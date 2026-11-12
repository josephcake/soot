/**
 * Milestone 6 (fixture-backed, local): the `soot` CLI drives the whole workflow on real git
 * repositories — recorded-fixture decomposition → routing (with stored outcome history) →
 * supervised mock execution in worktrees → soot-run checks → serial integration → report.
 *
 * These are fixture-backed runs of spec §17 Tests 1 and 2 and the mockable graph shape of
 * Test 4. They are NOT the M6-07 acceptance runs: no real model or provider is involved.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MOCK,
  TEST_1,
  TEST_2,
  TEST_4,
  cli,
  createDemoRepo,
  type DemoRepo,
} from './helpers/demo-repo.js';

const SLOW = 60_000;
let repo: DemoRepo | null = null;
afterEach(() => {
  repo?.dispose();
  repo = null;
});

interface RunJson {
  ok: boolean;
  runId: string;
  fixtureId: string;
  agent: string;
  maxObservedConcurrency: number;
  historySamples: number;
  decisions: string[];
  report: {
    status: string;
    incomplete: { taskId: string; reason: string }[];
    problems: string[];
    workingTree: { updated: boolean; reason: string };
    tasks: {
      taskId: string;
      verdict: string;
      reason: string;
      integration: string;
      modelPath: string[];
      complete: boolean;
      checks: { name: string; status: string; exitCode: number | null }[];
    }[];
    cost: { totals: { actual: { usd: number | null; attempts: number; inputTokens: number } } };
  };
}

const parse = (stdout: string) => JSON.parse(stdout) as RunJson;
const task = (r: RunJson, id: string) => r.report.tasks.find((t) => t.taskId === id);

describe('soot run: spec §17 Test 1 through the CLI (fixture-backed)', () => {
  it(
    'unattended: two tasks run concurrently on cheap models, are verified by soot and merged; the working tree is left alone',
    async () => {
      const r = (repo = createDemoRepo());
      const head = r.git('rev-parse', 'HEAD');
      const run = await cli(r, ['run', TEST_1, ...MOCK, '--run-id', 't1', '--json']);
      expect(run.code).toBe(2); // incomplete: only because nobody could approve the fast-forward
      const out = parse(run.stdout);
      expect(out.fixtureId).toBe('build-spec-17-test-1');
      expect(out.agent).toBe('mock-test-double');
      expect(out.maxObservedConcurrency).toBe(2);
      for (const id of ['update-page-title', 'update-button-color']) {
        expect(task(out, id)).toMatchObject({
          verdict: 'verified',
          integration: 'merged',
          complete: true,
          modelPath: ['demo-a/demo-small'],
        });
      }
      expect(task(out, 'update-page-title')?.checks.map((c) => `${c.name}:${c.status}`)).toEqual([
        'test:passed',
        'lint:passed',
        'acceptance:title:passed',
      ]);
      expect(out.report.workingTree).toEqual({
        updated: false,
        reason: 'approval unavailable; result left on soot/t1/integration',
      });
      expect(r.git('rev-parse', 'HEAD')).toBe(head);
      expect(r.git('status', '--porcelain')).toBe('');
      expect(r.git('show', 'soot/t1/integration:src/pages/index.html')).toContain(
        '<title>HELLO WORLD</title>',
      );
      expect(r.git('show', 'soot/t1/integration:src/styles/button.css')).toContain(
        'background: purple;',
      );
      // Cost totals match the mock's reported usage (fictional amounts).
      expect(out.report.cost.totals.actual.attempts).toBe(2);
      expect(out.report.cost.totals.actual.inputTokens).toBe(1800 + 2100);
      expect(out.report.cost.totals.actual.usd).toBeCloseTo(0.00076 + 0.00087, 10);
    },
    SLOW,
  );

  it(
    'interactive: the run pauses for the person; "y" fast-forwards the tree, "n" leaves it',
    async () => {
      const r = (repo = createDemoRepo());
      const head = r.git('rev-parse', 'HEAD');
      const denied = await cli(r, ['run', TEST_1, ...MOCK, '--run-id', 'no', '--interactive'], {
        stdin: 'n\n',
      });
      expect(denied.stderr).toMatch(/approval needed \(integrate-into-working-tree\)/);
      expect(denied.stdout).toMatch(/Working tree: not updated \(approval denied/);
      expect(r.git('rev-parse', 'HEAD')).toBe(head);

      const approved = await cli(r, ['run', TEST_1, ...MOCK, '--run-id', 'yes', '--interactive'], {
        stdin: 'y\n',
      });
      expect(approved.code).toBe(0);
      expect(approved.stdout).toMatch(/soot run yes \(COMPLETE\)/);
      expect(approved.stdout).toMatch(/Working tree: updated \(fast-forwarded main/);
      expect(r.read('src/pages/index.html')).toContain('<h1 id="title">HELLO WORLD</h1>');
      expect(r.read('src/styles/button.css')).toContain('background: purple;');
      expect(r.git('merge-base', '--is-ancestor', head, 'HEAD')).toBe('');
      expect(r.git('status', '--porcelain')).toBe('');
    },
    SLOW,
  );
});

describe('soot run: spec §17 Test 2 through the CLI (fixture-backed)', () => {
  it(
    'mixed complexity: each task routed by complexity, all three run at once, the investigation is verified by a soot-run regression test',
    async () => {
      const r = (repo = createDemoRepo());
      const run = await cli(r, ['run', TEST_2, ...MOCK, '--run-id', 't2', '--json']);
      const out = parse(run.stdout);
      expect(out.fixtureId).toBe('build-spec-17-test-2');
      expect(out.maxObservedConcurrency).toBe(3);
      expect(task(out, 'update-button-color')?.modelPath).toEqual(['demo-a/demo-small']);
      expect(task(out, 'add-dropdown-component')?.modelPath).toEqual(['demo-b/demo-mid']);
      expect(task(out, 'verify-auth-bug')?.modelPath).toEqual(['demo-a/demo-large']);
      expect(out.report.tasks.map((t) => [t.taskId, t.verdict, t.integration])).toEqual([
        ['update-button-color', 'verified', 'merged'],
        ['add-dropdown-component', 'verified', 'merged'],
        ['verify-auth-bug', 'verified', 'read-only'],
      ]);
      expect(task(out, 'verify-auth-bug')?.checks).toEqual([
        { name: 'regression:auth', kind: 'test', status: 'passed', exitCode: 0 },
      ]);
      expect(r.git('show', 'soot/t2/integration:src/components/Dropdown.tsx')).toMatch(
        /export function Dropdown/,
      );
    },
    SLOW,
  );
});

describe('soot run: spec §17 Test 4 graph shape (fixture-backed; cross-provider part needs BYOK)', () => {
  it(
    'tests and review wait for the implementation; tests build on its verified commit; an unverifiable review is reported incomplete',
    async () => {
      const r = (repo = createDemoRepo());
      const run = await cli(r, ['run', TEST_4, ...MOCK, '--run-id', 't4', '--json']);
      expect(run.code).toBe(2);
      const out = parse(run.stdout);
      expect(out.fixtureId).toBe('build-spec-17-test-4');
      expect(out.maxObservedConcurrency).toBe(2);
      expect(out.report.tasks.map((t) => [t.taskId, t.verdict])).toEqual([
        ['implement-feature', 'verified'],
        ['add-feature-tests', 'verified'],
        ['security-review', 'unverified'],
      ]);
      // add-feature-tests ran the project test suite, which imports the implementation: it can
      // only pass because its worktree started from implement-feature's verified commit.
      expect(task(out, 'add-feature-tests')?.checks.find((c) => c.name === 'test')?.status).toBe(
        'passed',
      );
      expect(out.report.incomplete).toEqual([
        {
          taskId: 'security-review',
          reason:
            'unverified: read-only task with no soot-run acceptance checks; only the agent reported success',
        },
        ...out.report.incomplete.slice(1),
      ]);
      const status = await cli(r, ['status', 't4', '--json']);
      const tasks = (
        JSON.parse(status.stdout) as { tasks: { taskId: string; dependsOn: string[] }[] }
      ).tasks;
      expect(tasks.map((t) => [t.taskId, t.dependsOn])).toEqual([
        ['implement-feature', []],
        ['add-feature-tests', ['implement-feature']],
        ['security-review', ['implement-feature']],
      ]);
    },
    SLOW,
  );
});

describe('soot run: refusals and guards', () => {
  it('refuses without an agent runner, and refuses prompts it has no recorded decomposition for', async () => {
    const r = (repo = createDemoRepo());
    const noAgent = await cli(r, ['run', TEST_1]);
    expect(noAgent.code).toBe(1);
    expect(noAgent.stderr).toMatch(
      /no agent runner selected: real model execution needs provider keys \(M2-07, blocked\)/,
    );
    const unknown = await cli(r, ['run', 'Rewrite everything in Rust.', ...MOCK]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/No decomposition fixture matches this prompt/);
    const split = await cli(r, ['run', 'Change', 'the', 'title', ...MOCK]);
    expect(split.code).toBe(1);
    expect(split.stderr).toMatch(/exactly one quoted prompt/);
    expect(r.git('branch', '--list', 'soot/*')).toBe('');
  });

  it(
    'an agent edit to a protected acceptance test fails the task, even though the run is otherwise fine',
    async () => {
      const r = (repo = createDemoRepo());
      const script = JSON.parse(r.read('mock-agent.json')) as {
        tasks: Record<string, { writes?: Record<string, string> }>;
      };
      const title = script.tasks['update-page-title'];
      if (title?.writes)
        title.writes['acceptance/title.test.js'] =
          "import test from 'node:test';\ntest('ok', () => {});\n";
      writeFileSync(join(r.top, 'cheat.json'), JSON.stringify(script));
      const run = await cli(r, [
        'run',
        TEST_1,
        '--agent',
        'mock',
        '--mock-script',
        '../cheat.json',
        '--run-id',
        'cheat',
        '--json',
      ]);
      const out = parse(run.stdout);
      expect(task(out, 'update-page-title')).toMatchObject({
        verdict: 'out-of-scope',
        complete: false,
      });
      expect(task(out, 'update-page-title')?.reason).toMatch(
        /changed protected files: acceptance\/title\.test\.js/,
      );
      expect(task(out, 'update-button-color')?.verdict).toBe('verified');
    },
    SLOW,
  );
});

describe('routing feedback through the CLI (M5-07 glue now in `soot run`)', () => {
  it(
    'soot-verified outcomes from earlier runs move later routing to a more reliable model',
    async () => {
      const r = (repo = createDemoRepo());
      // Escalate on the first failure, so each run tries demo-small once, then demo-mid.
      const config = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
      config.escalation = { sameModelRetries: 0 };
      r.write('soot.config.json', `${JSON.stringify(config, null, 2)}\n`);
      r.commitAll('escalate on first failure');
      const base = r.git('rev-parse', 'HEAD');
      const good = JSON.parse(r.read('mock-agent.json')) as {
        version: 1;
        tasks: Record<string, { writes?: Record<string, string> }>;
      };
      const bad = {
        ...good.tasks['update-button-color'],
        writes: {
          'src/styles/button.css':
            '.btn-primary {\n  background: violet;\n}\n\n.btn-secondary {\n  background: gray;\n}\n',
        },
      };
      const script = {
        version: 1,
        tasks: { 'update-button-color': [bad, good.tasks['update-button-color']] },
      };
      writeFileSync(join(r.top, 'flaky.json'), JSON.stringify(script));
      const agent = ['--agent', 'mock', '--mock-script', '../flaky.json'];
      const prompt =
        'Change my page title to HELLO WORLD, update the primary button color to purple, and make sure the authentication bug from the previous issue has been fixed.';
      // §3 fixture: the button task is low complexity → demo-small first.
      const first = parse(
        (await cli(r, ['run', prompt, ...agent, '--run-id', 'fb1', '--json'])).stdout,
      );
      expect(task(first, 'update-button-color')?.modelPath).toEqual([
        'demo-a/demo-small',
        'demo-b/demo-mid',
      ]);
      expect(first.historySamples).toBe(0);
      r.git('reset', '--quiet', '--hard', base);
      const second = parse(
        (await cli(r, ['run', prompt, ...agent, '--run-id', 'fb2', '--json'])).stdout,
      );
      // fb1 stored demo-small failed@low (soot's acceptance test) and demo-mid verified@medium.
      // Blending that failure into demo-small's 0.9 prior drops it out of the Balanced low-tier
      // threshold, so routing now starts on demo-mid.
      expect(second.historySamples).toBeGreaterThanOrEqual(2);
      expect(task(second, 'update-button-color')?.modelPath[0]).toBe('demo-b/demo-mid');
      expect(second.decisions.find((d) => d.startsWith('- update-button-color #1 assign'))).toMatch(
        /assign demo-b\/demo-mid/,
      );
    },
    SLOW * 2,
  );
});

describe('soot status / cost / models / config / stop against fixtures', () => {
  it(
    'reports runs, per-task state, cost (estimate vs actual), models and config without reading keys',
    async () => {
      const r = (repo = createDemoRepo());
      expect((await cli(r, ['status'])).stdout).toBe('No runs yet.\n');
      await cli(r, ['run', TEST_1, ...MOCK, '--run-id', 's1']);
      const list = await cli(r, ['status']);
      expect(list.stdout).toMatch(
        /- s1 incomplete 2 tasks .*: Change the page title to HELLO WORLD/,
      );
      const one = await cli(r, ['status', 's1']);
      expect(one.stdout).toMatch(
        /- update-page-title \[low\] succeeded, 1 attempt\(s\) \(demo-a\/demo-small\), verdict verified \(complete\)/,
      );
      expect((await cli(r, ['status', 'nope'])).code).toBe(1);

      const cost = await cli(r, ['cost', '--json']);
      const c = JSON.parse(cost.stdout) as {
        runId: string;
        cost: { totals: { estimated: { usd: number }; actual: { usd: number } } };
      };
      expect(c.runId).toBe('s1');
      expect(c.cost.totals.actual.usd).toBeCloseTo(0.00163, 10);
      expect(c.cost.totals.estimated.usd).toBeCloseTo(0.001875, 10);
      expect((await cli(r, ['cost', 's1'])).stdout).toMatch(
        /Total estimated: \$0\.001875[\s\S]*Total actual: \$0\.001630 over 2 attempts/,
      );

      const models = await cli(r, ['models']);
      expect(models.stdout).toMatch(
        /- demo-a\/demo-small \(anthropic\) eligible; price in\/out per MTok \$0\.25\/\$1\.25/,
      );

      const config = await cli(r, ['config', '--json']);
      const cfg = JSON.parse(config.stdout) as {
        protectedPaths: string[];
        providers: { apiKeyEnv: string | null }[];
        approvals: string;
        agent: string;
      };
      expect(cfg.protectedPaths).toEqual([
        'acceptance/',
        'tests/auth/',
        'scripts/',
        'soot.config.json',
        'models.json',
      ]);
      expect(cfg.providers.map((p) => p.apiKeyEnv)).toEqual([
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
      ]);
      expect(cfg).toMatchObject({ approvals: 'unattended', agent: 'none' });

      const stop = await cli(r, ['stop', 's1']);
      expect(stop.code).toBe(1);
      expect(stop.stderr).toMatch(/run s1 is not running/);
    },
    SLOW,
  );

  it(
    'lists a DeepSeek model as excluded, and never routes to it',
    async () => {
      const r = (repo = createDemoRepo());
      const models = JSON.parse(r.read('models.json')) as {
        providers: unknown[];
        models: unknown[];
      };
      models.providers.push({
        id: 'deepseek',
        kind: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      });
      models.models.push({
        provider: 'deepseek',
        modelId: 'demo-ds',
        capabilities: {
          tools: true,
          structuredOutput: true,
          vision: true,
          reasoning: true,
          streaming: true,
        },
        contextWindow: 1000000,
        pricing: {
          inputPerMTokUsd: 0.01,
          outputPerMTokUsd: 0.02,
          source: 'fictional demo value (not a real price)',
          asOf: '2026-11-12',
        },
        reliability: { low: 0.99, medium: 0.99, high: 0.99, source: 'fictional demo prior' },
      });
      r.write('models.json', JSON.stringify(models));
      r.commitAll('add deepseek');
      const listed = await cli(r, ['models']);
      expect(listed.stdout).toMatch(
        /- deepseek\/demo-ds \(openai-compatible\) excluded: restricted/,
      );
      const run = parse(
        (await cli(r, ['run', TEST_2, ...MOCK, '--run-id', 'ds', '--json'])).stdout,
      );
      expect(
        run.report.tasks.flatMap((t) => t.modelPath).some((m) => m.startsWith('deepseek/')),
      ).toBe(false);
      expect(run.decisions.join('\n')).not.toMatch(/assign deepseek/);
    },
    SLOW,
  );
});

describe('soot help', () => {
  it('prints usage and rejects unknown commands and flags', async () => {
    const r = (repo = createDemoRepo());
    const help = await cli(r, ['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/soot run "<prompt>"/);
    expect((await cli(r, ['frobnicate'])).code).toBe(1);
    expect((await cli(r, ['run', TEST_1, '--yes'])).stderr).toMatch(/Unknown option '--yes'/);
    expect(readFileSync(join(r.root, 'soot.config.json'), 'utf8')).toContain('"version": 1');
  });
});
