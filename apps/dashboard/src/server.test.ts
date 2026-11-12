import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DASHBOARD_PORT,
  parsePort,
  startDashboard,
  type DashboardHandle,
} from './server.js';
import { APP_JS, INDEX_HTML } from './ui.js';
import type { DashboardSource } from './view.js';

const calls: string[] = [];
const source: DashboardSource = {
  status: (runId) => {
    calls.push(`status ${runId ?? ''}`);
    if (runId === undefined)
      return Promise.resolve({ ok: true, text: '', data: { runs: [{ runId: 'r1', tasks: 0 }] } });
    if (runId !== 'r1')
      return Promise.resolve({ ok: false, text: `unknown run ${runId}`, data: {} });
    return Promise.resolve({
      ok: true,
      text: '',
      data: {
        runId: 'r1',
        state: 'incomplete',
        running: false,
        prompt: 'p',
        tasks: [],
        events: [],
      },
    });
  },
  cost: (runId) => {
    calls.push(`cost ${runId ?? ''}`);
    return Promise.resolve({ ok: false, text: 'no cost', data: {} });
  },
};

let handle: DashboardHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
  calls.length = 0;
});

const get = (port: number, path: string, options: { method?: string; host?: string } = {}) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: options.method ?? 'GET',
          headers: { host: options.host ?? `127.0.0.1:${String(port)}` },
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
      req.end();
    },
  );

describe('startDashboard', () => {
  it('listens on 127.0.0.1 / IPv4 only and serves the page and the JSON API', async () => {
    handle = await startDashboard({ source, port: 0 });
    expect(handle.address.address).toBe('127.0.0.1');
    expect(handle.address.family).toBe('IPv4');
    expect(handle.url).toBe(`http://127.0.0.1:${String(handle.address.port)}/`);
    const port = handle.address.port;

    const page = await get(port, '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).toBe(INDEX_HTML);
    expect((await get(port, '/app.js')).body).toBe(APP_JS);
    expect((await get(port, '/style.css')).status).toBe(200);

    const runs = await get(port, '/api/runs');
    expect(JSON.parse(runs.body)).toMatchObject({ runs: [{ runId: 'r1' }] });
    const run = await get(port, '/api/runs/r1');
    expect(JSON.parse(run.body)).toMatchObject({
      run: { runId: 'r1', cost: { actualUsd: null }, savings: { claimed: false } },
    });
    expect((await get(port, '/api/runs/r2')).status).toBe(404);
    expect((await get(port, '/api/runs/..%2Fetc')).status).toBe(400);
    expect((await get(port, '/nothing')).status).toBe(404);
    expect((await get(port, '/api/runs', { method: 'POST' })).status).toBe(405);
    expect((await get(port, '/api/runs', { method: 'DELETE' })).status).toBe(405);
    expect(
      (await get(port, '/api/runs', { host: `attacker.example:${String(port)}` })).status,
    ).toBe(421);
    expect((await get(port, '/api/runs', { host: `localhost:${String(port)}` })).status).toBe(200);
    // Reads only: status and cost, nothing else.
    expect(new Set(calls.map((c) => c.split(' ')[0]))).toEqual(new Set(['status', 'cost']));
  });

  it('rejects when the port is taken instead of trying another one', async () => {
    const blocker = await new Promise<Server>((resolve) => {
      const s = createServer();
      s.listen({ port: 0, host: '127.0.0.1' }, () => {
        resolve(s);
      });
    });
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(startDashboard({ source, port })).rejects.toThrow(
        `cannot listen on 127.0.0.1:${String(port)}: EADDRINUSE`,
      );
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => {
          resolve();
        });
      });
    }
  });

  it('parses --port (default 8787, 0..65535 only)', () => {
    expect(DEFAULT_DASHBOARD_PORT).toBe(8787);
    expect(parsePort(undefined)).toBe(8787);
    expect(parsePort('9000')).toBe(9000);
    expect(parsePort('0')).toBe(0);
    for (const bad of ['-1', '65536', 'abc', '80.5', '', ' 80'])
      expect(() => parsePort(bad)).toThrow();
  });
});

describe('no outbound network and no credentials', () => {
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  it('the page script only calls its own /api paths and never builds HTML from data', () => {
    expect(APP_JS).not.toMatch(/https?:\/\//);
    expect(APP_JS.match(/fetch\(/g)).toHaveLength(1);
    expect(APP_JS).toContain("getJson('/api/runs')");
    expect(APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(INDEX_HTML).not.toMatch(/https?:\/\//);
  });
  it('the server code makes no requests and reads no keys or env', () => {
    // ui.ts is the browser page (its one same-origin fetch is checked above).
    for (const f of ['./server.ts', './view.ts', './index.ts']) {
      const code = src(f);
      expect(code, f).not.toMatch(
        /\bfetch\(|https?\.request|from 'node:https'|process\.env|apiKey/i,
      );
      expect(code, f).not.toMatch(/from '@soot\//);
    }
    expect(src('./server.ts')).toContain("export const DASHBOARD_HOST = '127.0.0.1';");
  });
});
