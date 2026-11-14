/**
 * Issue #5 (ADR-045): the planning (decomposer) call in the cost report, the run budget and
 * provider cooldowns. Mock model clients and the mock agent only; `fetch` is replaced with a
 * spy that rejects, so any network attempt fails the test.
 */
import { createMockModelClient, type ModelClient } from '@soot/provider-adapters';
import { openExecutionStore } from '@soot/context-manager';
import type { Task } from '@soot/task-graph';
import { SootEngine, unattendedApprovals, type ModelClientFactory } from '@soot/cli';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK, TEST_1, cli, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';

const SLOW = 60_000;
const UNKNOWN = 'Add a short release note for the demo app.';
// 700 in × $0.10/M + 150 out × $0.50/M (claude-haiku-5-5 in the demo models file).
const PLANNING_USD = 0.000145;

let repo: DemoRepo | null = null;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error('network access is forbidden in this test')));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  repo?.dispose();
  repo = null;
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const noteTask: Task = {
  id: 'add-release-note',
  title: 'Add a release note',
  instructions: 'Write docs/release-note.md with one line.',
  acceptanceCriteria: ['docs/release-note.md exists.'],
  requiredCapabilities: ['docs'],
  complexity: 'low',
  estimate: { inputTokens: 800, outputTokens: 100, costUsd: null },
  files: { read: [], write: ['docs/release-note.md'] },
  dependsOn: [],
};

const planner = (turns: Parameters<typeof createMockModelClient>[0]['turns']) =>
  createMockModelClient({ provider: 'anthropic', modelId: 'claude-haiku-5-5', turns });
const answering = () =>
  planner([
    { text: JSON.stringify({ tasks: [noteTask] }), usage: { inputTokens: 700, outputTokens: 150 } },
  ]);

/** Demo repo with a decomposer model and optional escalation settings, plus a note-writing agent. */
function demo(escalation?: Record<string, unknown>): DemoRepo {
  const r = createDemoRepo();
  const cfg = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
  cfg.decomposer = { model: 'anthropic/claude-haiku-5-5' };
  if (escalation !== undefined) cfg.escalation = escalation;
  r.write('soot.config.json', `${JSON.stringify(cfg, null, 2)}\n`);
  r.commitAll('configure a decomposer model');
  writeFileSync(
    join(r.top, 'note-agent.json'),
    JSON.stringify({
      version: 1,
      tasks: {
        'add-release-note': {
          writes: { 'docs/release-note.md': 'Release note.\n' },
          usage: { inputTokens: 900, outputTokens: 120, costUsd: 0.0002 },
        },
      },
    }),
  );
  return r;
}

function engineFor(r: DemoRepo, factory?: ModelClientFactory, warnings: string[] = []) {
  return new SootEngine({
    cwd: r.root,
    dataDir: r.dataDir,
    agent: { kind: 'mock', script: '../note-agent.json' },
    approvals: unattendedApprovals(),
    gitEnv: r.env,
    modelEnv: r.env,
    ...(factory === undefined ? {} : { modelClientFactory: factory }),
    log: {
      level: 'info',
      enabled: () => true,
      debug: () => undefined,
      info: () => undefined,
      warn: (line: string) => warnings.push(line),
      error: () => undefined,
    },
  });
}

interface CostData {
  cost: {
    planning: {
      label: string;
      model: string;
      inputTokens: number | null;
      outputTokens: number | null;
      actualUsd: number | null;
      priced: boolean;
    } | null;
    totals: {
      actual: { usd: number | null };
      run: { usd: number | null; planningUsd: number | null };
    };
    tasks: { taskId: string }[];
  };
}

describe('priced planning', () => {
  it(
    'is its own labelled line in soot cost and the run report, and in the run total',
    async () => {
      const r = (repo = demo());
      const engine = engineFor(r, () => answering());
      const out = await engine.run({ prompt: UNKNOWN, runId: 'priced' });
      expect(out.ok).toBe(true);
      const cost = await engine.cost('priced');
      const data = cost.data as unknown as CostData;
      expect(data.cost.planning).toMatchObject({
        label: 'planning (decomposition)',
        model: 'anthropic/claude-haiku-5-5',
        inputTokens: 700,
        outputTokens: 150,
        priced: true,
      });
      expect(data.cost.planning?.actualUsd).toBeCloseTo(PLANNING_USD, 12);
      // Not mixed into a task.
      expect(data.cost.tasks.map((t) => t.taskId)).toEqual(['add-release-note']);
      const tasksUsd = data.cost.totals.actual.usd;
      expect(tasksUsd).not.toBeNull();
      expect(data.cost.totals.run.planningUsd).toBeCloseTo(PLANNING_USD, 12);
      expect(tasksUsd).toBeCloseTo(0.0002, 12);
      expect(data.cost.totals.run.usd).toBeCloseTo(0.0002 + PLANNING_USD, 12);
      expect(cost.text).toMatch(
        /- Planning \(decomposition, not a task\): anthropic\/claude-haiku-5-5, 700 in \/ 150 out tokens reported \| actual \$0\.000145/,
      );
      expect(cost.text).toMatch(
        /Total actual with planning: \$\d+\.\d{6} \(planning \$0\.000145 \+ tasks/,
      );
      // The consolidated run report carries the same line.
      const report = (out.data.report as unknown as { cost: CostData['cost'] }).cost;
      expect(report.planning?.actualUsd).toBeCloseTo(PLANNING_USD, 12);
      expect(out.text).toMatch(/- Planning \(decomposition, not a task\)/);
    },
    SLOW,
  );
});

describe('unpriced planning', () => {
  it(
    'stays unknown: no number is invented, and the run total is unknown',
    async () => {
      const r = (repo = demo({ runBudgetUsd: 1 }));
      const models = JSON.parse(r.read('models.json')) as {
        providers: { id: string; baseURL?: string }[];
        models: { modelId: string; pricing?: unknown }[];
      };
      // Unpriced, behind a proxy so soot's catalog does not price it either.
      for (const m of models.models) if (m.modelId === 'claude-haiku-5-5') delete m.pricing;
      for (const p of models.providers)
        if (p.id === 'anthropic') p.baseURL = 'https://llm-proxy.example.com/v1';
      r.write('models.json', `${JSON.stringify(models, null, 2)}\n`);
      r.commitAll('leave haiku unpriced');
      const warnings: string[] = [];
      const engine = engineFor(r, () => answering(), warnings);
      await engine.run({ prompt: UNKNOWN, runId: 'unpriced' });
      const cost = await engine.cost('unpriced');
      const data = cost.data as unknown as CostData;
      expect(data.cost.planning).toMatchObject({
        inputTokens: 700,
        outputTokens: 150,
        actualUsd: null,
        priced: false,
      });
      expect(data.cost.totals.run).toEqual({ usd: null, planningUsd: null });
      expect(cost.text).toMatch(
        /Planning \(decomposition, not a task\).*actual unknown \(model has no price\)/,
      );
      expect(warnings.join('\n')).toMatch(
        /planning call's cost is unknown \(anthropic\/claude-haiku-5-5 has no price\); it is not counted against the run budget/,
      );
    },
    SLOW,
  );
});

describe('run budget', () => {
  it('planning alone over the budget stops the run before any task starts', async () => {
    const r = (repo = demo({ runBudgetUsd: 0.0001 }));
    const mock = answering();
    const out = await engineFor(r, () => mock).run({ prompt: UNKNOWN, runId: 'over' });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(
      /Planning alone cost \$0\.000145 \(anthropic\/claude-haiku-5-5\), more than the run budget of \$0\.0001 \("escalation\.runBudgetUsd" in soot\.config\.json\)\. No task was started\./,
    );
    expect(out.data).toMatchObject({
      decompositionFailure: 'run-budget',
      runBudgetUsd: 0.0001,
    });
    expect(mock.calls()).toBe(1);
    expect(r.git('branch', '--list', 'soot/*')).toBe('');
    expect((await engineFor(r).status()).data).toEqual({ runs: [] });
  });

  it(
    'planning counts against the budget the tasks share',
    async () => {
      // The task alone would fit in $0.0002; planning ($0.000145) plus the task does not.
      const r = (repo = demo({ runBudgetUsd: 0.0002 }));
      const out = await engineFor(r, () => answering()).run({ prompt: UNKNOWN, runId: 'shared' });
      const decisions = (out.data.decisions as string[]).join('\n');
      expect(decisions).toMatch(
        /add-release-note #1 stop: run budget exhausted: spent \$0\.000145 \(planning \$0\.000145\) \+ next attempt \$0\.000\d+ > \$0\.000200/,
      );
      const report = out.data.report as { tasks: { taskId: string; verdict: string }[] };
      expect(report.tasks[0]?.verdict).not.toBe('verified');
    },
    SLOW,
  );
});

describe('provider cooldowns for the planner call', () => {
  it('an outage puts the provider in cooldown, and the next planner call skips it', async () => {
    const r = (repo = demo());
    const down = planner([{ error: { status: 503, message: 'mock: overloaded' } }]);
    const first = await engineFor(r, () => down).run({ prompt: UNKNOWN });
    expect(first.ok).toBe(false);
    expect(first.data).toMatchObject({
      decompositionFailure: 'model-call-failed',
      providerCooldown: { provider: 'anthropic', reason: 'outage' },
    });
    expect(first.text).toMatch(/Provider anthropic is now in cooldown \(outage\) until /);
    const store = openExecutionStore({ dataDir: r.dataDir });
    try {
      expect(store.providerCooldowns(Date.now()).map((c) => [c.provider, c.reason])).toEqual([
        ['anthropic', 'outage'],
      ]);
    } finally {
      store.close();
    }

    const healthy = answering();
    const second = await engineFor(r, () => healthy).run({ prompt: UNKNOWN });
    expect(second.ok).toBe(false);
    expect(second.data).toMatchObject({ decomposerModelStatus: 'unusable' });
    expect(second.text).toMatch(
      /decomposer model anthropic\/claude-haiku-5-5 .* is not usable: provider "anthropic" is in cooldown until .*\(outage: planner call: /,
    );
    expect(healthy.calls()).toBe(0);
  });

  it('a request error (HTTP 400) records no cooldown', async () => {
    const r = (repo = demo());
    const bad = planner([{ error: { status: 400, message: 'mock: bad request' } }]);
    const out = await engineFor(r, () => bad).run({ prompt: UNKNOWN });
    expect(out.data).toMatchObject({ decompositionFailure: 'model-call-failed' });
    expect(out.data.providerCooldown).toBeUndefined();
    const store = openExecutionStore({ dataDir: r.dataDir });
    try {
      expect(store.providerCooldowns(Date.now())).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe('fixture planning', () => {
  it(
    'still costs nothing and adds no planning line',
    async () => {
      const r = (repo = demo({ runBudgetUsd: 0.0000001 }));
      const factory = vi.fn<ModelClientFactory>((): ModelClient => answering());
      const run = await cli(r, ['run', TEST_1, ...MOCK, '--run-id', 'fixture', '--json']);
      expect(JSON.parse(run.stdout)).toMatchObject({ fixtureId: 'build-spec-17-test-1' });
      const cost = await engineFor(r, factory).cost('fixture');
      const data = cost.data as unknown as CostData;
      expect(data.cost.planning).toBeNull();
      expect(data.cost.totals.run.planningUsd).toBeNull();
      expect(data.cost.totals.run.usd).toBe(data.cost.totals.actual.usd);
      expect(cost.text).not.toMatch(/Planning/);
      expect(factory).not.toHaveBeenCalled();
    },
    SLOW,
  );
});
