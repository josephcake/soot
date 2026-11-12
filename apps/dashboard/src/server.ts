import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { APP_JS, INDEX_HTML, STYLE_CSS } from './ui.js';
import { toDashboardRun, toRunList, type DashboardSource } from './view.js';

/*
 * The optional local dashboard (ADR-031): one static page and a read-only JSON API, served by
 * Node's built-in http module on 127.0.0.1 only. It reads through the engine's status and cost
 * (the same data as `soot status` / `soot cost`); it has no store of its own, makes no
 * outbound requests, calls no provider, and never sees credentials.
 */

export const DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_DASHBOARD_PORT = 8787;

export interface DashboardOptions {
  readonly source: DashboardSource;
  /** TCP port on 127.0.0.1 (default 8787). 0 asks the OS for a free port, explicitly. */
  readonly port?: number;
}

export interface DashboardHandle {
  readonly url: string;
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

function send(res: ServerResponse, code: number, type: string, body: string, head: boolean) {
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'content-type': type,
    'content-length': Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
}

const sendJson = (res: ServerResponse, code: number, value: unknown, head: boolean) => {
  send(res, code, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`, head);
};

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  source: DashboardSource,
  port: number,
): Promise<void> {
  const head = req.method === 'HEAD';
  // DNS-rebinding guard: only answer requests addressed to this loopback server.
  const host = req.headers.host ?? '';
  if (host !== `${DASHBOARD_HOST}:${String(port)}` && host !== `localhost:${String(port)}`) {
    sendJson(res, 421, { error: 'unexpected Host header' }, head);
    return;
  }
  if (req.method !== 'GET' && !head) {
    res.setHeader('allow', 'GET, HEAD');
    sendJson(res, 405, { error: 'read-only: GET and HEAD only' }, head);
    return;
  }
  const path = new URL(req.url ?? '/', `http://${DASHBOARD_HOST}`).pathname;
  if (path === '/' || path === '/index.html') {
    send(res, 200, 'text/html; charset=utf-8', INDEX_HTML, head);
    return;
  }
  if (path === '/app.js') {
    send(res, 200, 'text/javascript; charset=utf-8', APP_JS, head);
    return;
  }
  if (path === '/style.css') {
    send(res, 200, 'text/css; charset=utf-8', STYLE_CSS, head);
    return;
  }
  if (path === '/api/runs') {
    const status = await source.status();
    if (!status.ok) {
      sendJson(res, 500, { error: status.text }, head);
      return;
    }
    sendJson(res, 200, { runs: toRunList(status) }, head);
    return;
  }
  const m = /^\/api\/runs\/([^/]+)$/.exec(path);
  if (m !== null) {
    const runId = decodeURIComponent(m[1] ?? '');
    if (!RUN_ID.test(runId)) {
      sendJson(res, 400, { error: 'bad run id' }, head);
      return;
    }
    const status = await source.status(runId);
    if (!status.ok) {
      sendJson(res, 404, { error: status.text }, head);
      return;
    }
    const cost = await source.cost(runId);
    sendJson(res, 200, { run: toDashboardRun(status.data, cost.ok ? cost.data : null) }, head);
    return;
  }
  sendJson(res, 404, { error: 'not found' }, head);
}

/** Start the dashboard on 127.0.0.1. Rejects if the port cannot be bound (no other port is tried). */
export function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const requested = options.port ?? DEFAULT_DASHBOARD_PORT;
  let port = requested;
  const server = createServer((req, res) => {
    handle(req, res, options.source, port).catch((error: unknown) => {
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
      port = address.port;
      resolve({
        url: `http://${DASHBOARD_HOST}:${String(address.port)}/`,
        address,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
