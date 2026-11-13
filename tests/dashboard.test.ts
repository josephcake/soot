/**
 * The optional local dashboard (ADR-031) through the BUILT `soot` binary, against a temporary
 * copy of examples/demo-app with the scripted mock agent. No model, key, network or spend.
 *
 * - `soot dashboard` listens on 127.0.0.1 only: the socket's own address, and on Linux the
 *   kernel's listening-socket table, are checked, not just the port.
 * - A taken port fails the command; no other port is tried.
 * - Headless commands (run, status, cost, models, config, stop, install-skill, mcp) work with
 *   the dashboard package made unloadable, and none of them listens on a socket.
 * - No engine, headless CLI or extension module imports the dashboard.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MOCK,
  REPO_ROOT,
  TEST_1,
  cli as cliInProcess,
  createDemoRepo,
  type DemoRepo,
} from './helpers/demo-repo.js';
import { CLI_BIN, buildWorkspace } from './helpers/workspace-build.js';

const SLOW = 90_000;
const GUARD = join(REPO_ROOT, 'tests/fixtures/no-dashboard.mjs');

beforeAll(async () => {
  await buildWorkspace();
}, 180_000);

let repo: DemoRepo | null = null;
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  repo?.dispose();
  repo = null;
});

interface Proc {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function soot(r: DemoRepo, args: readonly string[], env: Record<string, string> = {}) {
  return new Promise<Proc>((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: r.root,
      env: { ...r.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** Start `soot dashboard` in the background and wait for its JSON line. */
async function startDashboardProcess(r: DemoRepo, args: readonly string[]) {
  const child = spawn(process.execPath, [CLI_BIN, 'dashboard', '--json', ...args], {
    cwd: r.root,
    env: r.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  const info = await new Promise<Record<string, unknown> | null>((resolve) => {
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        // wait for the rest of the JSON
      }
    });
    void exited.then(() => {
      resolve(null);
    });
  });
  return { child, info, exited, stderr: () => stderr };
}

/** Linux: local addresses of LISTEN sockets on `port` from /proc/net/tcp{,6}. */
function listeningAddresses(port: number): string[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  return ['/proc/net/tcp', '/proc/net/tcp6']
    .filter((f) => existsSync(f))
    .flatMap((f) => readFileSync(f, 'utf8').trim().split('\n').slice(1))
    .map((l) => l.trim().split(/\s+/))
    .filter((cols) => cols[3] === '0A' && cols[1]?.endsWith(`:${hexPort}`) === true)
    .map((cols) => cols[1]?.split(':')[0] ?? '');
}

/** GET /api/runs with an explicit Host header; resolves the status code. */
const statusWithHost = (port: number, host: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/runs', headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });

const listenOn = (port: number, host: string) =>
  new Promise<Server>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen({ port, host, exclusive: true }, () => {
      resolve(s);
    });
  });
const closeServer = (s: Server) =>
  new Promise<void>((resolve) => {
    s.close(() => {
      resolve();
    });
  });

describe('soot dashboard binds 127.0.0.1 only', () => {
  it(
    'listens on 127.0.0.1 (socket and kernel table), serves the §12 run view, stops on SIGINT',
    async () => {
      const r = (repo = createDemoRepo());
      const run = await cliInProcess(r, ['run', TEST_1, ...MOCK, '--run-id', 'dash-1']);
      expect(run.code).toBe(2);

      const d = await startDashboardProcess(r, ['--port', '0']);
      expect(d.info, d.stderr()).not.toBeNull();
      expect(d.info).toMatchObject({ ok: true, address: '127.0.0.1', family: 'IPv4' });
      const port = d.info?.port as number;
      expect(port).toBeGreaterThan(0);
      expect(d.info?.url).toBe(`http://127.0.0.1:${String(port)}/`);
      if (process.platform === 'linux') {
        // 0100007F is 127.0.0.1 in /proc/net/tcp; 00000000 (0.0.0.0) or any IPv6 must not appear.
        expect(listeningAddresses(port)).toEqual(['0100007F']);
      }

      const base = `http://127.0.0.1:${String(port)}`;
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(await page.text()).toContain('<script src="/app.js"');

      const list = (await (await fetch(`${base}/api/runs`)).json()) as {
        runs: { runId: string }[];
        overview: {
          promptCount: number;
          taskCount: number;
          byModel: { model: string; tasks: number }[];
          prompts: { runId: string; prompt: string; tokens: { inputTokens: number } | null }[];
        };
      };
      expect(list.runs.map((x) => x.runId)).toEqual(['dash-1']);
      expect(list.overview.promptCount).toBe(1);
      expect(list.overview.taskCount).toBe(2);
      expect(list.overview.byModel).toEqual([{ model: 'anthropic/claude-haiku-5-5', tasks: 2 }]);
      expect(list.overview.prompts[0]?.prompt).toBe(TEST_1);

      const { run: view } = (await (await fetch(`${base}/api/runs/dash-1`)).json()) as {
        run: Record<string, unknown> & {
          tasks: { id: string; models: string[]; checks: unknown[] }[];
          cost: Record<string, unknown>;
          byModel: { model: string; actualUsd: number | null }[];
          duration: { ms: number | null };
          outcomes: Record<string, unknown>;
          validation: {
            reportStatus: string | null;
            final: { name: string; status: string }[] | null;
            problems: string[];
          };
          savings: { claimed: boolean };
          taskBreakdown: {
            id: string;
            runner: string | null;
            models: string[];
            tokens: { inputTokens: number; outputTokens: number; total: number } | null;
          }[];
        };
      };
      expect(view.prompt).toBe(TEST_1);
      expect(view.taskCount).toBe(2);
      expect(view.graph).toEqual({ layers: [['update-page-title', 'update-button-color']] });
      expect(view.activeAgents).toEqual([]);
      expect(view.tasks.map((t) => [t.id, t.models])).toEqual([
        ['update-page-title', ['anthropic/claude-haiku-5-5']],
        ['update-button-color', ['anthropic/claude-haiku-5-5']],
      ]);
      expect(view.tasks.every((t) => t.checks.length > 0)).toBe(true);
      expect(view.transitions).toEqual([]);
      expect(view.tokens).toMatchObject({ actual: { unreportedAttempts: 0 } });
      expect(view.cost.estimatedUsd).toEqual(expect.any(Number));
      expect(view.cost.actualUsd).toBeCloseTo(0.00163, 6);
      expect(view.byModel.map((m) => m.model)).toEqual(['anthropic/claude-haiku-5-5']);
      expect(view.duration.ms).toBeGreaterThanOrEqual(0);
      expect(view.outcomes).toMatchObject({ succeeded: 2, failed: 0, successRate: 1 });
      expect(view.validation.reportStatus).toBe('incomplete');
      expect(view.validation.final?.map((c) => [c.name, c.status])).toEqual([
        ['test', 'passed'],
        ['lint', 'passed'],
      ]);
      expect(view.validation.problems).toEqual([
        expect.stringMatching(/^working tree not updated: approval unavailable/),
      ]);
      expect(view.savings.claimed).toBe(false);
      expect(view.taskBreakdown.map((t) => [t.id, t.models, t.tokens])).toEqual([
        [
          'update-page-title',
          ['anthropic/claude-haiku-5-5'],
          { inputTokens: 1800, outputTokens: 250, total: 2050 },
        ],
        [
          'update-button-color',
          ['anthropic/claude-haiku-5-5'],
          { inputTokens: 2100, outputTokens: 280, total: 2380 },
        ],
      ]);
      expect(view.taskBreakdown.every((t) => t.runner !== null)).toBe(true);

      // Read-only, and only for requests addressed to this loopback server.
      expect((await fetch(`${base}/api/runs`, { method: 'POST' })).status).toBe(405);
      // fetch() will not send a foreign Host header, so use a raw request (DNS-rebinding shape).
      expect(await statusWithHost(port, `evil.example:${String(port)}`)).toBe(421);
      expect(await statusWithHost(port, `localhost:${String(port)}`)).toBe(200);
      expect((await fetch(`${base}/api/runs/nope`)).status).toBe(404);

      d.child.kill('SIGINT');
      expect(await d.exited).toBe(0);
    },
    SLOW,
  );

  it(
    'usage and assignment charts: an escalated task shows both models, by model, task and runner',
    async () => {
      const r = (repo = createDemoRepo());
      const config = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
      config.escalation = { sameModelRetries: 0 };
      r.write('soot.config.json', `${JSON.stringify(config, null, 2)}\n`);
      r.commitAll('escalate on first failure');
      const good = JSON.parse(r.read('mock-agent.json')) as { tasks: Record<string, unknown> };
      const goodButton = good.tasks['update-button-color'] as Record<string, unknown>;
      const bad = {
        ...goodButton,
        writes: { 'src/styles/button.css': '.btn-primary {\n  background: violet;\n}\n' },
      };
      writeFileSync(
        join(r.top, 'flaky.json'),
        JSON.stringify({
          version: 1,
          tasks: { ...good.tasks, 'update-button-color': [bad, goodButton] },
        }),
      );
      const run = await cliInProcess(r, [
        'run',
        TEST_1,
        '--agent',
        'mock',
        '--mock-script',
        '../flaky.json',
        '--run-id',
        'dash-esc',
      ]);
      expect(run.code).toBe(2);

      const d = await startDashboardProcess(r, ['--port', '0']);
      expect(d.info).toMatchObject({ address: '127.0.0.1' });
      const base = `http://127.0.0.1:${String(d.info?.port)}`;
      interface Side {
        inputTokens: number | null;
        outputTokens: number | null;
        usd: number | null;
      }
      interface Row {
        label: string;
        attempts: number;
        estimated: Side;
        actual: Side;
      }
      const { run: view } = (await (await fetch(`${base}/api/runs/dash-esc`)).json()) as {
        run: {
          agent: { kind: string | null; label: string | null };
          usage: { byModel: Row[]; byTask: Row[]; byAgent: Row[] };
          assignment: {
            prompt: string;
            tasks: {
              id: string;
              title: string;
              runner: string | null;
              attempts: {
                attempt: number;
                via: string | null;
                routedModel: string | null;
                reportedModel: string | null;
                state: string;
              }[];
            }[];
          };
        };
      };
      d.child.kill('SIGINT');
      expect(await d.exited).toBe(0);

      expect(view.agent.kind).toBe('mock-test-double');
      expect(view.assignment.prompt).toBe(TEST_1);
      expect(
        view.assignment.tasks.map((t) => [
          t.id,
          t.title.length > 0,
          t.attempts.map((a) => [a.attempt, a.via, a.routedModel, a.reportedModel, a.state]),
        ]),
      ).toEqual([
        [
          'update-page-title',
          true,
          [[1, 'assign', 'anthropic/claude-haiku-5-5', 'anthropic/claude-haiku-5-5', 'succeeded']],
        ],
        [
          'update-button-color',
          true,
          [
            [1, 'assign', 'anthropic/claude-haiku-5-5', 'anthropic/claude-haiku-5-5', 'retried'],
            [2, 'escalate', 'openai/gpt-6.1-terra', 'openai/gpt-6.1-terra', 'succeeded'],
          ],
        ],
      ]);
      expect(view.assignment.tasks.every((t) => t.runner === view.agent.label)).toBe(true);

      expect(view.usage.byModel.map((m) => [m.label, m.attempts])).toEqual([
        ['anthropic/claude-haiku-5-5', 2],
        ['openai/gpt-6.1-terra', 1],
      ]);
      expect(view.usage.byTask.map((m) => [m.label, m.attempts])).toEqual([
        ['update-page-title', 1],
        ['update-button-color', 2],
      ]);
      expect(view.usage.byAgent.map((m) => [m.label, m.attempts])).toEqual([[view.agent.label, 3]]);
      // Estimates and actuals are separate numbers; the mock reports its own (fictional) actuals.
      const all = view.usage.byAgent[0];
      expect(all?.estimated.usd).toBeCloseTo(0.00475, 6);
      expect(all?.actual.usd).toBeCloseTo(0.0025, 6);
      expect(all?.estimated.usd).not.toBe(all?.actual.usd);
    },
    SLOW,
  );

  it(
    'defaults to port 8787 on 127.0.0.1 when --port is not given',
    async (ctx) => {
      // Skip honestly if something else on this machine already has 8787.
      try {
        await closeServer(await listenOn(8787, '127.0.0.1'));
      } catch {
        ctx.skip();
      }
      const r = (repo = createDemoRepo());
      const d = await startDashboardProcess(r, []);
      expect(d.info).toMatchObject({
        address: '127.0.0.1',
        port: 8787,
        url: 'http://127.0.0.1:8787/',
      });
      if (process.platform === 'linux') expect(listeningAddresses(8787)).toEqual(['0100007F']);
      d.child.kill('SIGINT');
      expect(await d.exited).toBe(0);
    },
    SLOW,
  );

  it(
    'fails when the port is taken and does not fall back to another port',
    async () => {
      const r = (repo = createDemoRepo());
      const blocker = await listenOn(0, '127.0.0.1');
      const port = (blocker.address() as { port: number }).port;
      try {
        const res = await soot(r, ['dashboard', '--port', String(port)]);
        expect(res.code).toBe(1);
        expect(res.stderr).toContain(`cannot listen on 127.0.0.1:${String(port)}: EADDRINUSE`);
        expect(res.stdout).toBe('');
      } finally {
        await closeServer(blocker);
      }
      const bad = await soot(r, ['dashboard', '--port', '70000']);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toMatch(/--port must be an integer from 0 to 65535/);
      const misplaced = await soot(r, ['status', '--port', '1234']);
      expect(misplaced.code).toBe(1);
      expect(misplaced.stderr).toMatch(/--port and --open are only for soot dashboard/);
    },
    SLOW,
  );

  it(
    'opens a browser only with --open',
    async () => {
      const r = (repo = createDemoRepo());
      for (const open of [false, true]) {
        const opened: string[] = [];
        const ac = new AbortController();
        let stdout = '';
        const done = (async () => {
          const { main } = await import('../apps/cli/src/cli.js');
          return main(['dashboard', '--port', '0', ...(open ? ['--open'] : [])], {
            stdout: (t) => {
              stdout += t;
              if (stdout.includes('http://')) ac.abort();
            },
            stderr: () => undefined,
            stdin: process.stdin,
            stdinIsTTY: false,
            env: r.env,
            cwd: r.root,
            signal: ac.signal,
            openUrl: (u) => opened.push(u),
          });
        })();
        expect(await done).toBe(0);
        const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout)?.[0];
        expect(url).toBeDefined();
        expect(opened).toEqual(open ? [url] : []);
      }
    },
    SLOW,
  );
});

describe('headless soot works without the dashboard', () => {
  it(
    'run, status, cost, models, config, stop, install-skill and mcp run with the dashboard unloadable, and never listen',
    async () => {
      const r = (repo = createDemoRepo());
      const log = join(r.top, 'guard.log');
      const env = { NODE_OPTIONS: `--import ${GUARD}`, SOOT_TEST_GUARD_LOG: log };
      const ok = async (args: string[], code = 0) => {
        const res = await soot(r, args, env);
        expect(res.code, `${args.join(' ')}\n${res.stderr}`).toBe(code);
        return res;
      };
      await ok(['run', TEST_1, ...MOCK, '--run-id', 'headless-1'], 2);
      expect((await ok(['status', 'headless-1'])).stdout).toContain('Run headless-1: incomplete');
      await ok(['cost', 'headless-1']);
      await ok(['models']);
      await ok(['config']);
      expect((await ok(['stop', 'headless-1'], 1)).stderr).toMatch(/not running/);
      await ok(['install-skill', '--target', r.top]);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI_BIN, 'mcp', ...MOCK],
        cwd: r.root,
        env: { ...r.env, ...env },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'soot-dashboard-test', version: '0.0.0' });
      await client.connect(transport);
      try {
        const res = await client.callTool({ name: 'soot_status', arguments: {} });
        expect(res.isError).toBe(false);
      } finally {
        await client.close();
      }

      // Nothing tried to load the dashboard and nothing listened on a socket.
      expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('');

      // The guard really blocks it: only `soot dashboard` asks for the package.
      const dash = await soot(r, ['dashboard', '--port', '0'], env);
      expect(dash.code).toBe(1);
      expect(dash.stderr).toContain('the optional @soot/dashboard package is not installed');
      expect(readFileSync(log, 'utf8')).toMatch(/^blocked-import @soot\/dashboard\n$/);
    },
    SLOW,
  );

  it('no engine package, headless CLI module or the extension imports the dashboard', () => {
    const sources = (dir: string): string[] =>
      readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => join(dir, f));
    const files = [
      ...readdirSync(join(REPO_ROOT, 'packages')).flatMap((p) => sources(`packages/${p}/src`)),
      ...sources('apps/cli/src'),
      ...sources('apps/vscode-extension/src'),
    ];
    expect(files.length).toBeGreaterThan(50);
    const importers = files.filter((f) =>
      /@soot\/dashboard|apps\/dashboard/.test(readFileSync(join(REPO_ROOT, f), 'utf8')),
    );
    // Only the CLI front door mentions it: a type-only import and the `dashboard` case.
    expect(importers).toEqual(['apps/cli/src/cli.ts']);
    const cliSrc = readFileSync(join(REPO_ROOT, 'apps/cli/src/cli.ts'), 'utf8');
    expect(cliSrc.match(/^import .*@soot\/dashboard.*$/gm)).toEqual([
      "import type * as Dashboard from '@soot/dashboard';",
    ]);
    expect(cliSrc.match(/import\('@soot\/dashboard'\)/g)).toHaveLength(1);
    // The built CLI loads it only through that dynamic import.
    const built = readdirSync(join(REPO_ROOT, 'apps/cli/dist'))
      .filter((f) => f.endsWith('.js'))
      .filter((f) =>
        readFileSync(join(REPO_ROOT, 'apps/cli/dist', f), 'utf8').includes('@soot/dashboard'),
      );
    expect(built).toEqual(['cli.js']);
    expect(
      readFileSync(join(REPO_ROOT, 'apps/cli/dist/cli.js'), 'utf8').match(
        /^import .*@soot\/dashboard.*$/gm,
      ),
    ).toBeNull();

    // Manifests: no engine package depends on it; the CLI has it as an optional peer only.
    for (const p of readdirSync(join(REPO_ROOT, 'packages'))) {
      const m = readFileSync(join(REPO_ROOT, 'packages', p, 'package.json'), 'utf8');
      expect(m, p).not.toContain('@soot/dashboard');
    }
    const cliPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/cli/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    expect(cliPkg.dependencies['@soot/dashboard']).toBeUndefined();
    expect(cliPkg.peerDependenciesMeta['@soot/dashboard']?.optional).toBe(true);
    const ext = readFileSync(join(REPO_ROOT, 'apps/vscode-extension/package.json'), 'utf8');
    expect(ext).not.toContain('@soot/dashboard');
  });
});
