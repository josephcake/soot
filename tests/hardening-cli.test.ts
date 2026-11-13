/**
 * Engine hardening through the BUILT `soot` binary and `soot mcp` (ADR-030), against a
 * temporary copy of examples/demo-app with the scripted mock agent. No model, key, network or
 * spend is involved.
 *
 * - SOOT_DATA_DIR / SOOT_LOG_LEVEL are honoured by real CLI and MCP processes.
 * - Provider cooldowns from one `soot run` process apply to the next one.
 * - Routing decisions land in the run's audit log; cost records carry routed estimates and
 *   only the actuals runners reported.
 * - `soot config` shows the default attempt timeout.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MOCK, TEST_1, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';
import { CLI_BIN, buildWorkspace } from './helpers/workspace-build.js';

const SLOW = 90_000;

beforeAll(async () => {
  await buildWorkspace();
}, 180_000);

let repo: DemoRepo | null = null;
afterEach(() => {
  repo?.dispose();
  repo = null;
});

interface Proc {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the built binary in the demo repo with the demo env plus `env` (undefined deletes). */
function soot(
  r: DemoRepo,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<Proc> {
  const merged: Record<string, string> = { ...r.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) Reflect.deleteProperty(merged, k);
    else merged[k] = v;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: r.root,
      env: merged,
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

const auditOf = (dataDir: string, runId: string) =>
  readFileSync(join(dataDir, 'audit', `${runId}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map(
      (l) =>
        JSON.parse(l) as { type: string; taskId: string | null; detail: Record<string, unknown> },
    );

describe('SOOT_DATA_DIR and SOOT_LOG_LEVEL in real processes', () => {
  it(
    'SOOT_DATA_DIR decides where state goes and which runs `soot status` sees',
    async () => {
      const r = (repo = createDemoRepo());
      const a = join(r.top, 'state-a');
      const b = join(r.top, 'state-b');
      const run = await soot(r, ['run', TEST_1, ...MOCK, '--run-id', 'env1', '--json'], {
        SOOT_DATA_DIR: a,
      });
      expect(run.code).toBe(2); // incomplete: unattended, nothing approved
      expect(existsSync(join(a, 'soot.sqlite'))).toBe(true);
      expect(existsSync(join(a, 'reports', 'env1.json'))).toBe(true);
      expect(existsSync(join(a, 'audit', 'env1.jsonl'))).toBe(true);
      expect(existsSync(b)).toBe(false);
      expect((await soot(r, ['status'], { SOOT_DATA_DIR: a })).stdout).toMatch(/- env1 incomplete/);
      expect((await soot(r, ['status'], { SOOT_DATA_DIR: b })).stdout).toBe('No runs yet.\n');
      // A relative SOOT_DATA_DIR resolves against the working directory; --data-dir wins.
      expect((await soot(r, ['status', '--data-dir', a], { SOOT_DATA_DIR: b })).stdout).toMatch(
        /- env1 incomplete/,
      );
      expect((await soot(r, ['status'], { SOOT_DATA_DIR: '../state-a' })).stdout).toMatch(/env1/);
    },
    SLOW,
  );

  it(
    'SOOT_LOG_LEVEL filters stderr log lines; results on stdout are unchanged; bad values fail',
    async () => {
      const r = (repo = createDemoRepo());
      const runAt = (level: string | undefined, id: string) =>
        soot(r, ['run', TEST_1, ...MOCK, '--run-id', id], { SOOT_LOG_LEVEL: level });

      const info = await runAt(undefined, 'l-info');
      expect(info.stderr).toMatch(/^soot: run l-info: 2 tasks/m);
      expect(info.stderr).not.toMatch(/soot: debug:/);
      const silent = await runAt('silent', 'l-silent');
      expect(silent.stderr).toBe('');
      expect(silent.stdout).toMatch(/soot run l-silent \(INCOMPLETE\)/);
      const warn = await runAt('warn', 'l-warn');
      expect(warn.stderr).toBe(''); // progress is info; this run has no warnings
      const debug = await runAt('DEBUG', 'l-debug');
      expect(debug.stderr).toContain(
        `soot: debug: state dir ${r.dataDir} (from SOOT_DATA_DIR); log level debug; command run`,
      );
      expect(debug.stderr).toMatch(
        /soot: debug: config .*soot\.config\.json; models .*attempt timeout 1800000 ms \(default\)/,
      );
      expect(debug.stderr).toMatch(/^soot: run l-debug: 2 tasks/m);

      const bad = await soot(r, ['status'], { SOOT_LOG_LEVEL: 'verbose' });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toMatch(
        /SOOT_LOG_LEVEL: expected one of silent, error, warn, info, debug/,
      );
    },
    SLOW,
  );

  it(
    '`soot mcp` honours SOOT_DATA_DIR and logs to stderr at SOOT_LOG_LEVEL, never on stdout',
    async () => {
      const r = (repo = createDemoRepo());
      const mcpState = join(r.top, 'mcp-state');
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI_BIN, 'mcp', ...MOCK],
        cwd: r.root,
        env: { ...r.env, SOOT_DATA_DIR: mcpState, SOOT_LOG_LEVEL: 'debug' },
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      const client = new Client({ name: 'soot-hardening-test', version: '0.0.0' });
      await client.connect(transport);
      try {
        const res = await client.callTool({
          name: 'soot_run',
          arguments: { prompt: TEST_1, runId: 'mcp-env' },
        });
        expect(res.isError).toBe(false);
      } finally {
        await client.close();
      }
      expect(existsSync(join(mcpState, 'reports', 'mcp-env.json'))).toBe(true);
      expect(existsSync(join(r.dataDir, 'reports', 'mcp-env.json'))).toBe(false);
      expect(stderr).toContain(`soot: debug: state dir ${mcpState} (from SOOT_DATA_DIR)`);
      expect(stderr).toMatch(/soot: run mcp-env: 2 tasks/);
    },
    SLOW,
  );
});

describe('provider health across `soot run` processes', () => {
  it(
    'a provider that went down in one run is skipped by the next run until its cooldown ends',
    async () => {
      const r = (repo = createDemoRepo());
      const demo = JSON.parse(r.read('mock-agent.json')) as {
        tasks: Record<string, Record<string, unknown>>;
      };
      const down = {
        outcome: 'provider-error',
        error: { kind: 'unavailable', provider: 'anthropic' },
      };
      writeFileSync(
        join(r.top, 'outage.json'),
        JSON.stringify({
          version: 1,
          tasks: {
            ...demo.tasks,
            'update-button-color': [down, demo.tasks['update-button-color']],
          },
        }),
      );
      const agent = ['--agent', 'mock', '--mock-script', '../outage.json'];
      const first = await soot(r, ['run', TEST_1, ...agent, '--run-id', 'h1', '--json']);
      const firstOut = JSON.parse(first.stdout) as { decisions: string[] };
      expect(firstOut.decisions).toContainEqual(
        expect.stringMatching(/^- update-button-color #2 fallback openai\//),
      );

      r.git('reset', '--quiet', '--hard', 'HEAD');
      const second = await soot(r, ['run', TEST_1, ...MOCK, '--run-id', 'h2']);
      expect(second.stderr).toMatch(
        /soot: provider anthropic unavailable until \S+ \(outage, recorded earlier\); routing skips it until then/,
      );
      const report = JSON.parse(readFileSync(join(r.dataDir, 'reports', 'h2.json'), 'utf8')) as {
        decisions: string[];
      };
      const assigns = report.decisions.filter((d) => d.includes(' #1 assign '));
      expect(assigns).toHaveLength(2);
      for (const d of assigns) expect(d).toMatch(/ assign openai\//);
    },
    SLOW,
  );
});

describe('routing decisions in the audit log; routed estimates on cost records', () => {
  it(
    'every routing decision is audited; estimates appear without fabricated actuals',
    async () => {
      const r = (repo = createDemoRepo());
      const demo = JSON.parse(r.read('mock-agent.json')) as {
        tasks: Record<string, Record<string, unknown>>;
      };
      // The title task reports tokens but no price: its actual cost must stay unknown.
      const title = demo.tasks['update-page-title'] ?? {};
      writeFileSync(
        join(r.top, 'unpriced.json'),
        JSON.stringify({
          version: 1,
          tasks: {
            ...demo.tasks,
            'update-page-title': {
              ...title,
              usage: { inputTokens: 1800, outputTokens: 250, costUsd: null },
            },
          },
        }),
      );
      const run = await soot(r, [
        'run',
        TEST_1,
        '--agent',
        'mock',
        '--mock-script',
        '../unpriced.json',
        '--run-id',
        'au1',
        '--json',
      ]);
      expect(run.code).toBe(2);
      const audit = auditOf(r.dataDir, 'au1');
      const routing = audit.filter((e) => e.type === 'routing-decision');
      expect(routing.map((e) => [e.taskId, e.detail.decision, e.detail.model])).toEqual(
        expect.arrayContaining([
          ['update-page-title', 'assign', 'anthropic/claude-haiku-5-5'],
          ['update-button-color', 'assign', 'anthropic/claude-haiku-5-5'],
          ['update-page-title', 'accept', 'anthropic/claude-haiku-5-5'],
        ]),
      );
      expect(String(routing[0]?.detail.reason)).toMatch(/^Balanced: lowest estimated cost/);
      // Routing happens between run-started and run-finished in the same log.
      const types = audit.map((e) => e.type);
      expect(types.indexOf('run-started')).toBeLessThan(types.indexOf('routing-decision'));

      const cost = JSON.parse((await soot(r, ['cost', 'au1', '--json'])).stdout) as {
        costRecords: {
          taskId: string;
          routed: {
            attempt: number;
            model: string;
            costUsd: number | null;
            routeApplied: boolean | null;
          }[];
          attempts: { attempt: number; inputTokens: number; costUsd: number | null }[];
        }[];
        costSummary: {
          routed: { attempts: number; costUsd: number };
          actual: { costUsd: number | null };
        };
      };
      const titleRecord = cost.costRecords.find((c) => c.taskId === 'update-page-title');
      expect(titleRecord?.routed).toEqual([
        {
          source: 'router',
          attempt: 1,
          model: 'anthropic/claude-haiku-5-5',
          costUsd: 0.00035,
          routeApplied: true,
        },
      ]);
      expect(titleRecord?.attempts).toEqual([
        expect.objectContaining({
          attempt: 1,
          inputTokens: 1800,
          outputTokens: 250,
          costUsd: null,
        }),
      ]);
      expect(cost.costSummary.routed).toMatchObject({ attempts: 2 });
      expect(cost.costSummary.routed.costUsd).toBeCloseTo(0.00075, 10);
      expect(cost.costSummary.actual.costUsd).toBeNull(); // one attempt is unpriced: total unknown
      const saved = JSON.parse(readFileSync(join(r.dataDir, 'reports', 'au1.json'), 'utf8')) as {
        costRecords: unknown;
      };
      expect(saved.costRecords).toEqual(cost.costRecords);
    },
    SLOW,
  );
});

describe('default attempt timeout is visible', () => {
  it('`soot config` reports the 30 minute default unless attemptTimeoutMs is set', async () => {
    const r = (repo = createDemoRepo());
    const def = JSON.parse((await soot(r, ['config', '--json'])).stdout) as Record<string, unknown>;
    expect(def).toMatchObject({ attemptTimeoutMs: null, effectiveAttemptTimeoutMs: 1_800_000 });
    expect((await soot(r, ['config'])).stdout).toMatch(/Attempt timeout: 1800000 ms \(default;/);
    const config = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
    r.write('soot.config.json', JSON.stringify({ ...config, attemptTimeoutMs: 120_000 }));
    const set = JSON.parse((await soot(r, ['config', '--json'])).stdout) as Record<string, unknown>;
    expect(set).toMatchObject({ attemptTimeoutMs: 120_000, effectiveAttemptTimeoutMs: 120_000 });
  });
});
