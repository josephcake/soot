import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardAgent, PlanResult } from './jobs.js';
import { startDashboard, type DashboardHandle } from './server.js';
import { GATE_HTML, INDEX_HTML } from './ui.js';
import type { DashboardSource } from './view.js';

/*
 * Security suite for the dashboard's access and write paths (ADR-038): token (new each start) → cookie,
 * cookie flags, bearer, CSRF + exact Origin + Sec-Fetch-Site, content type, Host (DNS rebinding),
 * read-only mode, the folder allowlist (ids only; paths and traversal refused before the agent
 * is asked), no CORS, and no key values in any response.
 */

const TOKEN = 'sec-token-0123456789abcdef0123456789abcdef';
const SECRET = 'sk-SHOULD-NEVER-APPEAR-0000';
const PID = 'p_0123456789abcdef';

const source: DashboardSource = {
  status: (runId) =>
    Promise.resolve(
      runId === undefined
        ? { ok: true, text: '', data: { runs: [] } }
        : { ok: false, text: `unknown run ${runId}`, data: {} },
    ),
  cost: () => Promise.resolve({ ok: false, text: 'no cost', data: {} }),
};

function fakeAgent() {
  const planned: string[] = [];
  const stopped: string[] = [];
  const agent: DashboardAgent = {
    runner: { kind: 'mock', label: 'mock (test double)' },
    projects: () => [
      {
        id: PID,
        label: 'demo-app',
        path: '/tmp/demo-app',
        config: { ok: true, policy: 'balanced', checks: [], error: null },
        planner: { model: null, status: 'not-configured', reason: null, roughCostUsd: null },
        runnerLabel: 'mock (test double)',
      },
    ],
    keyStatus: (id) =>
      id !== PID
        ? null
        : {
            project: { id: PID, label: 'demo-app' },
            modelsFile: 'models.json',
            models: 1,
            unpriced: [],
            planner: { model: null, status: 'not-configured', reason: null, roughCostUsd: null },
            providers: [{ id: 'xai', keyVar: 'XAI_API_KEY', key: 'set', usedBy: ['xai/grok'] }],
            runner: { kind: 'mock', label: 'mock (test double)' },
          },
    plan: (id, prompt): Promise<PlanResult> => {
      planned.push(`${id}|${prompt}`);
      return Promise.resolve({
        ok: true,
        preview: { tasks: [] },
        start: (_s, onRunStarted) => {
          onRunStarted('run-sec-1');
          return Promise.resolve({ ok: true, status: 'complete', message: 'ok' });
        },
      });
    },
    stop: (runId, taskId) => {
      stopped.push(`${runId}|${taskId ?? ''}`);
      return Promise.resolve({ ok: true, message: 'stop requested' });
    },
  };
  return { agent, planned, stopped };
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  port: number,
  path: string,
  o: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: o.method ?? 'GET',
        headers: { host: o.host ?? `127.0.0.1:${String(port)}`, ...o.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end(o.body);
  });
}

interface Body {
  error?: string;
  readOnlyHint?: string;
  writes?: boolean;
  runner?: unknown;
  job?: { id: string; runId: string | null };
  providers?: unknown[];
}
const parse = (b: string) => JSON.parse(b) as Body;

let handle: DashboardHandle | null = null;
const seen: string[] = [];
afterEach(async () => {
  await handle?.close();
  handle = null;
});

async function boot(withAgent = true) {
  const f = fakeAgent();
  handle = await startDashboard({
    source,
    port: 0,
    token: TOKEN,
    ...(withAgent ? { agent: f.agent } : {}),
  });
  const port = handle.address.port;
  const origin = `http://127.0.0.1:${String(port)}`;
  const rec = async (p: Promise<Res>) => {
    const r = await p;
    seen.push(r.body, JSON.stringify(r.headers));
    return r;
  };
  /** Exchange the token for a cookie session like a browser does; returns cookie + CSRF. */
  const login = async () => {
    const r = await rec(call(port, `/?token=${TOKEN}`));
    const set = String(r.headers['set-cookie'] ?? '');
    const cookie = set.split(';')[0] ?? '';
    const session = JSON.parse(
      (await rec(call(port, '/api/session', { headers: { cookie } }))).body,
    ) as {
      csrf: string;
    };
    return { r, set, cookie, csrf: session.csrf };
  };
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    rec(
      call(port, path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
  return { ...f, port, origin, login, post, rec };
}

describe('access token and session cookie', () => {
  it('the access link (new each start) sets an HttpOnly SameSite=Strict cookie and 303s to / with no token', async () => {
    const { login, port } = await boot();
    const { r, set, cookie } = await login();
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe('/');
    expect(set).toMatch(
      new RegExp(
        `^soot_session_${String(port)}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/$`,
      ),
    );
    expect(set).not.toContain(TOKEN);
    const page = await call(port, '/', { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.body).toBe(INDEX_HTML);
  });

  it('no session, a wrong token or a forged cookie gets the gate (page) or 401 (API)', async () => {
    const { port } = await boot();
    for (const headers of [
      {},
      { cookie: `soot_session_${String(port)}=forged` },
      { authorization: 'Bearer nope' },
    ]) {
      const page = await call(port, '/', { headers });
      expect(page.status).toBe(401);
      expect(page.body).toBe(GATE_HTML);
      for (const p of [
        '/api/runs',
        '/api/session',
        '/api/projects',
        '/api/prompts',
        '/api/runs/x',
      ]) {
        const api = await call(port, p, { headers });
        expect(api.status, p).toBe(401);
        expect(JSON.parse(api.body)).toMatchObject({ error: 'auth_required' });
      }
    }
    const bad = await call(port, '/?token=wrong');
    expect(bad.status).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();
    // Assets hold no data and load without a session (the gate page needs its stylesheet).
    expect((await call(port, '/style.css')).status).toBe(200);
    expect((await call(port, '/app.js')).status).toBe(200);
  });

  it('a cookie from another port is not this dashboard’s session', async () => {
    const { login, port } = await boot();
    const { cookie } = await login();
    const other = cookie.replace(
      `soot_session_${String(port)}`,
      `soot_session_${String(port + 1)}`,
    );
    expect((await call(port, '/api/runs', { headers: { cookie: other } })).status).toBe(401);
  });

  it('bearer works for scripts', async () => {
    const { port } = await boot();
    const r = await call(port, '/api/session', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({
      writes: true,
      auth: 'bearer',
      csrf: null,
      runner: { kind: 'mock' },
    });
  });
});

describe('writes: CSRF, Origin, Sec-Fetch-Site, content type, Host', () => {
  it('a cookie POST needs the exact Origin and the session CSRF value', async () => {
    const { login, post, origin, planned, port } = await boot();
    const { cookie, csrf } = await login();
    const body = { project: PID, prompt: 'hi' };
    const cases: [Record<string, string>, number, string][] = [
      [{ cookie }, 403, 'csrf'],
      [{ cookie, origin }, 403, 'csrf'],
      [{ cookie, 'x-soot-csrf': csrf }, 403, 'csrf'],
      [{ cookie, origin: 'http://evil.example', 'x-soot-csrf': csrf }, 403, 'csrf'],
      [
        { cookie, origin: `http://127.0.0.1:${String(port + 1)}`, 'x-soot-csrf': csrf },
        403,
        'csrf',
      ],
      [{ cookie, origin: 'null', 'x-soot-csrf': csrf }, 403, 'csrf'],
      [{ cookie, origin, 'x-soot-csrf': 'wrong' }, 403, 'csrf'],
      [{ cookie, origin, 'x-soot-csrf': csrf, 'sec-fetch-site': 'cross-site' }, 403, 'csrf'],
      [{ cookie, origin, 'x-soot-csrf': csrf, 'sec-fetch-site': 'same-site' }, 403, 'csrf'],
    ];
    for (const [headers, status, error] of cases) {
      const r = await post('/api/prompts', body, headers);
      expect(r.status, JSON.stringify(headers)).toBe(status);
      expect(parse(r.body).error).toBe(error);
    }
    expect(planned).toEqual([]);
    const ok = await post('/api/prompts', body, {
      cookie,
      origin,
      'x-soot-csrf': csrf,
      'sec-fetch-site': 'same-origin',
    });
    expect(ok.status).toBe(202);
    expect(planned).toEqual([`${PID}|hi`]);
  });

  it('form-style content types are refused; only application/json', async () => {
    const { login, origin, port, planned } = await boot();
    const { cookie, csrf } = await login();
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      const r = await call(port, '/api/prompts', {
        method: 'POST',
        body: JSON.stringify({ project: PID, prompt: 'x' }),
        headers: { cookie, origin, 'x-soot-csrf': csrf, 'content-type': type },
      });
      expect(r.status, type).toBe(415);
    }
    expect(planned).toEqual([]);
  });

  it('the Host check comes first, for writes too (DNS rebinding)', async () => {
    const { port } = await boot();
    const r = await call(port, '/api/prompts', {
      method: 'POST',
      host: `rebind.example:${String(port)}`,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(421);
  });

  it('no CORS headers, ever, and no preflight answer', async () => {
    const { port, login, post, origin } = await boot();
    const { cookie, csrf } = await login();
    const pre = await call(port, '/api/prompts', {
      method: 'OPTIONS',
      headers: { cookie, origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(pre.status).toBe(405);
    const ok = await post(
      '/api/prompts',
      { project: PID, prompt: 'x' },
      { cookie, origin, 'x-soot-csrf': csrf },
    );
    for (const r of [pre, ok]) {
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    }
  });

  it('methods other than GET/HEAD/POST-on-write-routes are 405', async () => {
    const { port } = await boot();
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await call(port, '/api/runs', { method: 'POST', headers: auth })).status).toBe(405);
    expect((await call(port, '/api/prompts', { method: 'PUT', headers: auth })).status).toBe(405);
    expect((await call(port, '/api/prompts', { method: 'DELETE', headers: auth })).status).toBe(
      405,
    );
  });
});

describe('read-only mode (no --agent)', () => {
  it('every write and the project endpoints are refused; the page says why', async () => {
    const { port, login, post, origin } = await boot(false);
    const { cookie, csrf } = await login();
    const session = parse((await call(port, '/api/session', { headers: { cookie } })).body);
    expect(session).toMatchObject({ writes: false, runner: null });
    expect(session.readOnlyHint).toContain('--agent mock');
    for (const p of [
      '/api/prompts',
      '/api/prompts/job_0123456789abcdef/cancel',
      '/api/runs/run-1/cancel',
    ]) {
      const r = await post(p, {}, { cookie, origin, 'x-soot-csrf': csrf });
      expect(r.status, p).toBe(403);
      expect(parse(r.body).error).toBe('read_only');
    }
    for (const p of ['/api/projects', `/api/keys/status?project=${PID}`, '/api/prompts']) {
      expect((await call(port, p, { headers: { cookie } })).status, p).toBe(403);
    }
    expect((await call(port, '/api/runs', { headers: { cookie } })).status).toBe(200);
  });
});

describe('allowlist: ids only, never paths', () => {
  it('paths, traversal and unknown ids are refused before the agent plans anything', async () => {
    const { login, post, origin, planned } = await boot();
    const { cookie, csrf } = await login();
    const h = { cookie, origin, 'x-soot-csrf': csrf };
    for (const project of [
      '/tmp/demo-app',
      '../../etc',
      '/etc/passwd',
      'p_0123456789abcdef/../x',
      'p_ffffffffffffffff',
      '',
      null,
      7,
    ]) {
      const r = await post('/api/prompts', { project, prompt: 'x' }, h);
      expect(r.status, String(project)).toBe(404);
      expect(parse(r.body).error).toBe('unknown_project');
    }
    // A body that tries to smuggle a path or cwd is refused outright.
    const smuggle = await post('/api/prompts', { project: PID, prompt: 'x', path: '/etc' }, h);
    expect(smuggle.status).toBe(400);
    expect(planned).toEqual([]);
    const ks = await call(handle?.address.port ?? 0, '/api/keys/status?project=../../etc', {
      headers: { cookie },
    });
    expect(ks.status).toBe(404);
  });

  it('a prompt over 256 KB and a body over the limit are refused', async () => {
    const { login, post, origin, planned } = await boot();
    const { cookie, csrf } = await login();
    const h = { cookie, origin, 'x-soot-csrf': csrf };
    expect(
      (await post('/api/prompts', { project: PID, prompt: 'x'.repeat(256 * 1024 + 1) }, h)).status,
    ).toBe(413);
    expect(
      (await post('/api/prompts', { project: PID, prompt: 'x'.repeat(400 * 1024) }, h)).status,
    ).toBe(413);
    expect(planned).toEqual([]);
  });

  it('only runs started here can be stopped here; bad ids are 400', async () => {
    const { login, post, origin, stopped } = await boot();
    const { cookie, csrf } = await login();
    const h = { cookie, origin, 'x-soot-csrf': csrf };
    expect((await post('/api/runs/someone-elses-run/cancel', {}, h)).status).toBe(403);
    expect((await post('/api/runs/..%2F..%2Fx/cancel', {}, h)).status).toBe(400);
    const job = parse((await post('/api/prompts', { project: PID, prompt: 'x' }, h)).body).job;
    for (let i = 0; i < 100; i++) {
      const j = parse(
        (
          await call(handle?.address.port ?? 0, `/api/prompts/${String(job?.id)}`, {
            headers: { cookie },
          })
        ).body,
      ).job;
      if (j?.runId !== null) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await post('/api/runs/run-sec-1/cancel', { task: '../x' }, h)).status).toBe(400);
    expect((await post('/api/runs/run-sec-1/cancel', { task: 't1' }, h)).status).toBe(202);
    expect(stopped).toEqual(['run-sec-1|t1']);
  });
});

describe('keys', () => {
  it('responses carry key variable names and set/missing only', async () => {
    process.env.SOOT_SECURITY_TEST_FAKE = SECRET;
    try {
      const { port, login } = await boot();
      const { cookie } = await login();
      const ks = parse(
        (await call(port, `/api/keys/status?project=${PID}`, { headers: { cookie } })).body,
      );
      expect(ks.providers).toEqual([
        { id: 'xai', keyVar: 'XAI_API_KEY', key: 'set', usedBy: ['xai/grok'] },
      ]);
      for (const p of ['/', '/api/session', '/api/projects', '/api/prompts', '/api/runs']) {
        seen.push((await call(port, p, { headers: { cookie } })).body);
      }
      const all = seen.join('\n');
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain(TOKEN);
    } finally {
      delete process.env.SOOT_SECURITY_TEST_FAKE;
    }
  });
});
