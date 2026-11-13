import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toOverview } from './overview.js';
import { JobStore, type DashboardAgent } from './jobs.js';
import { APP_JS, GATE_HTML, INDEX_HTML, STYLE_CSS } from './ui.js';
import { toDashboardRun, toRunList, type DashboardRun, type DashboardSource } from './view.js';

/** Pixel logo masters live in the repo at docs/brand (same files the README uses). */
const BRAND_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/brand');
const LOGO_PNG = readFileSync(join(BRAND_DIR, 'soot-lockup.png'));
const MARK_PNG = readFileSync(join(BRAND_DIR, 'soot-mark.png'));

/*
 * The optional local dashboard (ADR-031, ADR-038): one static page and a JSON API, served by
 * Node's built-in http module on 127.0.0.1 only. It reads through the engine's status and cost
 * (the same data as `soot status` / `soot cost`); it has no store of its own, makes no
 * outbound requests, and never sees credential values.
 *
 * Access (ADR-038): every page and API request needs a session. `soot dashboard` prints a
 * link, new each start, with a random 256-bit token; opening it swaps the token for an HttpOnly,
 * SameSite=Strict cookie and redirects to `/`. Scripts may send `Authorization: Bearer <token>`.
 * Only the static assets (CSS, script, logos), which hold no data, are served without one.
 *
 * Writes (the prompt composer) exist only when the CLI passes an `agent`
 * (`soot dashboard --agent mock|acp`). Every POST then needs: a session, `Content-Type:
 * application/json`, and, for cookie sessions, the exact loopback `Origin`, `Sec-Fetch-Site:
 * same-origin` when sent, and the session's `X-Soot-CSRF` value. No CORS header is ever sent.
 */

export const DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_DASHBOARD_PORT = 8787;

export interface DashboardOptions {
  readonly source: DashboardSource;
  /** TCP port on 127.0.0.1 (default 8787). 0 asks the OS for a free port, explicitly. */
  readonly port?: number;
  /** Plans and runs prompts (the composer). Absent: read-only, every POST is refused. */
  readonly agent?: DashboardAgent;
  /** Access token; default a fresh random 256-bit one. Tests pass their own. */
  readonly token?: string;
}

export interface DashboardHandle {
  /** The access link (new each start), `http://127.0.0.1:<port>/?token=…`. Print it; never log it to a file. */
  readonly url: string;
  /** `http://127.0.0.1:<port>/` with no token. */
  readonly baseUrl: string;
  /** What the listening socket reports: always 127.0.0.1 / IPv4. */
  readonly address: AddressInfo;
  close(): Promise<void>;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const;

export function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DASHBOARD_PORT;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65_535)
    throw new Error(`--port must be an integer from 0 to 65535 (got "${value}")`);
  return Number(value);
}

function send(
  res: ServerResponse,
  code: number,
  type: string,
  body: string | Buffer,
  head: boolean,
  extra: Record<string, string> = {},
) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    ...extra,
    'content-type': type,
    'content-length': buf.length,
  });
  res.end(head ? undefined : buf);
}

const sendJson = (res: ServerResponse, code: number, value: unknown, head: boolean) => {
  send(res, code, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`, head);
};

const sendError = (
  res: ServerResponse,
  code: number,
  error: string,
  message: string,
  head = false,
  extra: Record<string, unknown> = {},
) => {
  sendJson(res, code, { error, message, retryable: code >= 500 || code === 409, ...extra }, head);
};

/** Constant-time string compare (hashes first, so lengths never leak). */
function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const MAX_BODY_BYTES = 300 * 1024;

class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES)
      throw new BodyError(413, 'prompt_too_long', 'Request body too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError(400, 'bad_json', 'The request body is not JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BodyError(400, 'bad_json', 'The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

interface Session {
  readonly csrf: string;
}

interface ServerState {
  readonly source: DashboardSource;
  readonly token: string;
  readonly sessions: Map<string, Session>;
  readonly jobs: JobStore | null;
  readonly agent: DashboardAgent | null;
  port: number;
}

const READ_ONLY_HINT =
  'This dashboard is read-only. To direct work from here, restart it with "soot dashboard --agent mock --mock-script <file>" or "--agent acp".';

const STATIC: Record<string, { type: string; body: () => string | Buffer }> = {
  '/app.js': { type: 'text/javascript; charset=utf-8', body: () => APP_JS },
  '/style.css': { type: 'text/css; charset=utf-8', body: () => STYLE_CSS },
  '/logo.png': { type: 'image/png', body: () => LOGO_PNG },
  '/mark.png': { type: 'image/png', body: () => MARK_PNG },
  '/favicon.png': { type: 'image/png', body: () => MARK_PNG },
};

async function loadRecordedRuns(source: DashboardSource): Promise<
  | {
      ok: true;
      list: ReturnType<typeof toRunList>;
      runs: DashboardRun[];
    }
  | { ok: false; text: string }
> {
  const status = await source.status();
  if (!status.ok) return { ok: false, text: status.text };
  const list = toRunList(status);
  const runs: DashboardRun[] = [];
  for (const item of list) {
    if (item.runId === '') continue;
    const one = await source.status(item.runId);
    if (!one.ok) continue;
    const cost = await source.cost(item.runId);
    runs.push(toDashboardRun(one.data, cost.ok ? cost.data : null));
  }
  return { ok: true, list, runs };
}

type Auth = { kind: 'cookie'; session: Session } | { kind: 'bearer' } | null;

function authOf(req: IncomingMessage, st: ServerState): Auth {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (bearer !== null) return sameSecret(bearer[1] ?? '', st.token) ? { kind: 'bearer' } : null;
  const sid = cookieValue(req.headers.cookie, `soot_session_${String(st.port)}`);
  if (sid === null) return null;
  for (const [id, session] of st.sessions)
    if (sameSecret(id, sid)) return { kind: 'cookie', session };
  return null;
}

/** Why a POST is refused (CSRF / Origin / content type), or null when it may proceed. */
function writeProblem(
  req: IncomingMessage,
  auth: Exclude<Auth, null>,
  st: ServerState,
): string | null {
  const port = String(st.port);
  const origin = req.headers.origin;
  const okOrigin = (o: string) =>
    o === `http://${DASHBOARD_HOST}:${port}` || o === `http://localhost:${port}`;
  if (auth.kind === 'cookie') {
    if (origin === undefined || !okOrigin(origin)) return 'Origin must be this dashboard';
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return 'cross-site request';
    const csrf = req.headers['x-soot-csrf'];
    if (typeof csrf !== 'string' || !sameSecret(csrf, auth.session.csrf))
      return 'missing or wrong X-Soot-CSRF';
  } else if (origin !== undefined && !okOrigin(origin)) {
    return 'Origin must be this dashboard';
  }
  return null;
}

async function handle(req: IncomingMessage, res: ServerResponse, st: ServerState): Promise<void> {
  const head = req.method === 'HEAD';
  const port = st.port;
  // DNS-rebinding guard: only answer requests addressed to this loopback server.
  const host = req.headers.host ?? '';
  if (host !== `${DASHBOARD_HOST}:${String(port)}` && host !== `localhost:${String(port)}`) {
    sendJson(res, 421, { error: 'unexpected Host header' }, head);
    return;
  }
  const url = new URL(req.url ?? '/', `http://${DASHBOARD_HOST}`);
  const path = url.pathname;
  const isRead = req.method === 'GET' || head;
  const asset = STATIC[path];
  if (asset !== undefined && isRead) {
    send(res, 200, asset.type, asset.body(), head);
    return;
  }
  const isPage = path === '/' || path === '/index.html';
  // One-time link: swap the token for a session cookie and drop it from the address bar.
  const given = url.searchParams.get('token');
  if (isPage && isRead && given !== null) {
    if (!sameSecret(given, st.token)) {
      send(res, 401, 'text/html; charset=utf-8', GATE_HTML, head);
      return;
    }
    const sid = randomBytes(32).toString('base64url');
    st.sessions.set(sid, { csrf: randomBytes(32).toString('base64url') });
    // A handful of browsers at most; the oldest session goes first.
    if (st.sessions.size > 32) st.sessions.delete(st.sessions.keys().next().value ?? '');
    send(res, 303, 'text/plain; charset=utf-8', 'See /\n', head, {
      location: '/',
      'set-cookie': `soot_session_${String(port)}=${sid}; HttpOnly; SameSite=Strict; Path=/`,
    });
    return;
  }
  const auth = authOf(req, st);
  if (auth === null) {
    if (isPage && isRead) send(res, 401, 'text/html; charset=utf-8', GATE_HTML, head);
    else sendError(res, 401, 'auth_required', 'Open the link printed by soot dashboard.', head);
    return;
  }
  const post = POST_ROUTES.some((r) => r.test(path));
  if (req.method === 'POST' && post) {
    await handlePost(req, res, st, auth, path);
    return;
  }
  if (!isRead) {
    res.setHeader('allow', post ? 'POST' : 'GET, HEAD');
    sendJson(res, 405, { error: post ? 'POST only' : 'GET and HEAD only' }, head);
    return;
  }
  if (isPage) {
    send(res, 200, 'text/html; charset=utf-8', INDEX_HTML, head);
    return;
  }
  if (path === '/api/session') {
    sendJson(
      res,
      200,
      {
        writes: st.agent !== null,
        runner: st.agent?.runner ?? null,
        csrf: auth.kind === 'cookie' ? auth.session.csrf : null,
        auth: auth.kind,
        readOnlyHint: st.agent === null ? READ_ONLY_HINT : null,
        port,
      },
      head,
    );
    return;
  }
  if (
    path === '/api/projects' ||
    path === '/api/keys/status' ||
    path === '/api/prompts' ||
    path.startsWith('/api/prompts/')
  ) {
    if (st.agent === null || st.jobs === null) {
      sendError(res, 403, 'read_only', READ_ONLY_HINT, head);
      return;
    }
    if (path === '/api/projects') {
      sendJson(res, 200, { projects: st.agent.projects() }, head);
      return;
    }
    if (path === '/api/keys/status') {
      const status = st.agent.keyStatus(url.searchParams.get('project') ?? '');
      if (status === null)
        sendError(res, 404, 'unknown_project', 'That project is not in the allowlist.', head);
      else sendJson(res, 200, status, head);
      return;
    }
    if (path === '/api/prompts') {
      sendJson(res, 200, { jobs: st.jobs.list() }, head);
      return;
    }
    const jm = /^\/api\/prompts\/(job_[0-9a-f]{16})$/.exec(path);
    const job = jm === null ? null : st.jobs.get(jm[1] ?? '');
    if (job === null) sendError(res, 404, 'unknown_job', 'No such prompt job.', head);
    else sendJson(res, 200, { job }, head);
    return;
  }
  if (path === '/api/runs') {
    const loaded = await loadRecordedRuns(st.source);
    if (!loaded.ok) {
      sendJson(res, 500, { error: loaded.text }, head);
      return;
    }
    sendJson(res, 200, { runs: loaded.list, overview: toOverview(loaded.runs) }, head);
    return;
  }
  const m = /^\/api\/runs\/([^/]+)$/.exec(path);
  if (m !== null) {
    const runId = decodeURIComponent(m[1] ?? '');
    if (!RUN_ID.test(runId)) {
      sendJson(res, 400, { error: 'bad run id' }, head);
      return;
    }
    const status = await st.source.status(runId);
    if (!status.ok) {
      sendJson(res, 404, { error: status.text }, head);
      return;
    }
    const cost = await st.source.cost(runId);
    sendJson(res, 200, { run: toDashboardRun(status.data, cost.ok ? cost.data : null) }, head);
    return;
  }
  sendJson(res, 404, { error: 'not found' }, head);
}

const POST_ROUTES = [
  /^\/api\/prompts$/,
  /^\/api\/prompts\/[^/]+\/cancel$/,
  /^\/api\/runs\/[^/]+\/cancel$/,
];

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  st: ServerState,
  auth: Exclude<Auth, null>,
  path: string,
): Promise<void> {
  const problem = writeProblem(req, auth, st);
  if (problem !== null) {
    sendError(res, 403, 'csrf', problem);
    return;
  }
  if (!/^application\/json(\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) {
    sendError(res, 415, 'content_type', 'Send Content-Type: application/json.');
    return;
  }
  if (st.agent === null || st.jobs === null) {
    sendError(res, 403, 'read_only', READ_ONLY_HINT);
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyError) sendError(res, error.status, error.code, error.message);
    else throw error;
    return;
  }
  if (path === '/api/prompts') {
    const keys = Object.keys(body);
    if (keys.some((k) => k !== 'project' && k !== 'prompt')) {
      sendError(res, 400, 'bad_request', 'Send only "project" (an id) and "prompt".');
      return;
    }
    const idem = req.headers['idempotency-key'];
    const key = typeof idem === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(idem) ? idem : null;
    const out = st.jobs.submit(body.project, body.prompt, key);
    if (!out.ok) sendError(res, out.status, out.code, out.message);
    else sendJson(res, out.replay ? 200 : 202, { job: out.job }, false);
    return;
  }
  const jc = /^\/api\/prompts\/([^/]+)\/cancel$/.exec(path);
  if (jc !== null) {
    const id = decodeURIComponent(jc[1] ?? '');
    const job = /^job_[0-9a-f]{16}$/.test(id) ? await st.jobs.cancel(id) : null;
    if (job === null) sendError(res, 404, 'unknown_job', 'No such prompt job.');
    else sendJson(res, 200, { job }, false);
    return;
  }
  const rc = /^\/api\/runs\/([^/]+)\/cancel$/.exec(path);
  const runId = decodeURIComponent(rc?.[1] ?? '');
  if (!RUN_ID.test(runId)) {
    sendError(res, 400, 'bad_run_id', 'Bad run id.');
    return;
  }
  const task = body.task;
  if (task !== undefined && (typeof task !== 'string' || !RUN_ID.test(task))) {
    sendError(res, 400, 'bad_task_id', 'Bad task id.');
    return;
  }
  if (!st.jobs.ownsRun(runId)) {
    sendError(
      res,
      403,
      'not_owned',
      'Only runs started from this dashboard can be stopped here; use "soot stop".',
    );
    return;
  }
  const stopped = await st.agent.stop(runId, task);
  if (!stopped.ok) sendError(res, 409, 'not_running', stopped.message);
  else sendJson(res, 202, { runId, stopRequested: true, task: task ?? null }, false);
}

/** Start the dashboard on 127.0.0.1. Rejects if the port cannot be bound (no other port is tried). */
export function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const requested = options.port ?? DEFAULT_DASHBOARD_PORT;
  const token = options.token ?? randomBytes(32).toString('base64url');
  if (token.length < 16) throw new Error('dashboard token too short');
  const st: ServerState = {
    source: options.source,
    token,
    sessions: new Map(),
    agent: options.agent ?? null,
    jobs: options.agent === undefined ? null : new JobStore(options.agent),
    port: requested,
  };
  const server = createServer((req, res) => {
    handle(req, res, st).catch((error: unknown) => {
      if (!res.headersSent)
        sendJson(res, 500, { error: (error as Error).message }, req.method === 'HEAD');
      else res.destroy();
    });
  });
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          `cannot listen on ${DASHBOARD_HOST}:${String(requested)}: ${error.code ?? error.message}`,
        ),
      );
    };
    server.once('error', onError);
    server.listen({ host: DASHBOARD_HOST, port: requested, exclusive: true }, () => {
      server.off('error', onError);
      const address = server.address() as AddressInfo;
      if (address.address !== DASHBOARD_HOST) {
        server.close();
        reject(new Error(`refusing to serve on ${address.address}: loopback 127.0.0.1 only`));
        return;
      }
      st.port = address.port;
      const baseUrl = `http://${DASHBOARD_HOST}:${String(address.port)}/`;
      resolve({
        url: `${baseUrl}?token=${token}`,
        baseUrl,
        address,
        close: async () => {
          // Runs live in this process (ADR-038): stop them before the server goes away.
          await st.jobs?.close();
          await new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          });
        },
      });
    });
  });
}
