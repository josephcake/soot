/**
 * Engine hardening (ADR-030), mocks only: provider health and run-budget spend persist in
 * soot.sqlite, so a restarted process keeps skipping a provider that was down (until its
 * cooldown ends) and rebuilds the run's spend from every persisted attempt. Fictional registry,
 * scripted mock agents; no network, no keys, no spend.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAgentRunner, Scheduler, type MockScript } from '@soot/agent-runtime';
import { openExecutionStore, type ExecutionStore } from '@soot/context-manager';
import { AdaptiveSupervisor } from '@soot/escalation';
import { ProviderHealth } from '@soot/model-registry';
import { FixtureDecomposer, SPEC_FIXTURES, createPromptIntake } from '@soot/planner';
import { buildTaskGraph, type Task, type TaskGraph } from '@soot/task-graph';
import { routingRegistry } from '../packages/model-router/src/test-fixtures.js';

const TEST_1 = 'Change the page title to HELLO WORLD and update the primary button to purple.';
const TEST_3 = 'Update the theme color.';
const SMALL = 'alpha/test-small';
const MID = 'beta/test-mid';

async function decompose(prompt: string): Promise<Task[]> {
  const intake = createPromptIntake({ prompt, context: { name: 'demo-app' } });
  return [...(await new FixtureDecomposer(SPEC_FIXTURES).decompose(intake)).tasks];
}
const intakeOf = (prompt: string) => ({ originalPrompt: prompt, promptSha256: 'b'.repeat(64) });

const dirs: string[] = [];
const stores: ExecutionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'soot-harden-'));
  dirs.push(d);
  return d;
}
/** Open the state store as a fresh process would. */
function open(dir: string): ExecutionStore {
  const s = openExecutionStore({ dataDir: dir });
  stores.push(s);
  return s;
}

function schedulerFor(
  graph: TaskGraph,
  store: ExecutionStore,
  runId: string,
  opts: {
    health: ProviderHealth;
    script: (taskId: string, attempt: number, model: string | null) => MockScript;
    runBudgetUsd?: number;
    ledger?: boolean;
    signal?: AbortSignal;
    resume?: boolean;
  },
) {
  const persisted = opts.resume === true ? store.loadRun(runId) : null;
  const supervisor = new AdaptiveSupervisor({
    registry: routingRegistry(),
    policy: 'balanced',
    health: opts.health,
    ...(opts.ledger === false ? {} : { spend: store.spendLedger(runId) }),
    config: {
      backoff: { baseDelayMs: 1, maxDelayMs: 5 },
      ...(opts.runBudgetUsd === undefined ? {} : { runBudgetUsd: opts.runBudgetUsd }),
    },
  });
  const runner = new MockAgentRunner({
    scriptFor: (input) =>
      opts.script(input.task.id, input.attempt, input.assignment?.model ?? null),
  });
  const scheduler = new Scheduler(graph, {
    runner,
    supervisor,
    concurrency: 2,
    journal: store.journal(runId),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(persisted === null
      ? {}
      : {
          completed: persisted.completed,
          previousAttempts: persisted.attemptCounts,
          previousAttemptRecords: persisted.attemptRecords,
        }),
  });
  return { scheduler, supervisor, runner };
}

describe('provider health survives a restart (ADR-030)', () => {
  it('a provider marked down stays skipped by a restarted process until its cooldown ends', async () => {
    const dir = dataDir();
    let now = 1_000_000;
    const clock = () => now;
    const graph = buildTaskGraph(await decompose(TEST_3));

    // Process 1: alpha is down (outage) → the task falls back to beta.
    const store1 = open(dir);
    store1.createRun({ runId: 'r1', intake: intakeOf(TEST_3), graph });
    const p1 = schedulerFor(graph, store1, 'r1', {
      health: new ProviderHealth({ now: clock, store: store1 }),
      script: (_t, _a, model) =>
        model?.startsWith('alpha/') === true
          ? { outcome: 'provider-error', error: { kind: 'unavailable', provider: 'alpha' } }
          : { usage: { inputTokens: 1000, outputTokens: 200 } },
    });
    const r1 = await p1.scheduler.run();
    expect(r1.outcomes.get('update-theme-color')?.attempts.map((a) => a.assignment?.model)).toEqual(
      [SMALL, MID],
    );
    store1.close();
    stores.splice(stores.indexOf(store1), 1);

    // Process 2, 30 s later: a fresh ProviderHealth loads the cooldown; alpha is never called.
    now += 30_000;
    const store2 = open(dir);
    expect(store2.providerCooldowns(now)).toEqual([
      expect.objectContaining({ provider: 'alpha', reason: 'outage', until: 1_000_000 + 60_000 }),
    ]);
    const health2 = new ProviderHealth({ now: clock, store: store2 });
    expect(health2.isAvailable('alpha')).toBe(false);
    store2.createRun({ runId: 'r2', intake: intakeOf(TEST_3), graph });
    const p2 = schedulerFor(graph, store2, 'r2', {
      health: health2,
      script: () => ({ usage: { inputTokens: 1000, outputTokens: 200 } }),
    });
    const r2 = await p2.scheduler.run();
    expect(r2.outcomes.get('update-theme-color')?.attempts.map((a) => a.assignment?.model)).toEqual(
      [MID],
    );
    expect(p2.runner.calls.map((c) => c.assignment?.model)).toEqual([MID]); // alpha never called

    // Without persistence (the old behaviour) the restarted process would try alpha again.
    expect(new ProviderHealth({ now: clock }).isAvailable('alpha')).toBe(true);

    // Process 3, after the 60 s outage cooldown: alpha is routable again.
    now += 30_001;
    const health3 = new ProviderHealth({ now: clock, store: open(dir) });
    expect(health3.isAvailable('alpha')).toBe(true);
    store2.createRun({ runId: 'r3', intake: intakeOf(TEST_3), graph });
    const p3 = schedulerFor(graph, store2, 'r3', {
      health: health3,
      script: () => ({ usage: { inputTokens: 1000, outputTokens: 200 } }),
    });
    const r3 = await p3.scheduler.run();
    expect(r3.outcomes.get('update-theme-color')?.attempts[0]?.assignment?.model).toBe(SMALL);
  });

  it('session-long marks (auth) are not persisted, and markAvailable clears a cooldown', () => {
    const dir = dataDir();
    const store = open(dir);
    const health = new ProviderHealth({ store });
    health.markUnavailable('alpha', 'auth', { detail: 'bad key' });
    health.markUnavailable('beta', 'rate-limited', { cooldownMs: 10_000 });
    expect(health.isAvailable('alpha')).toBe(false);
    expect(store.providerCooldowns(Date.now()).map((c) => c.provider)).toEqual(['beta']);
    health.markAvailable('beta');
    expect(store.providerCooldowns(Date.now())).toEqual([]);
  });
});

describe('run-budget spend is rebuilt from soot.sqlite after a restart (ADR-030)', () => {
  /**
   * Process 1: TEST_1's two independent tasks start; the title task finishes and reports its
   * cost; the process stops while the button task is still running (its routed estimate is
   * its only recorded spend: no actual was reported, none is invented). Process 2 resumes.
   */
  async function crashAfterTitle(dir: string, runBudgetUsd: number) {
    const graph = buildTaskGraph(await decompose(TEST_1));
    const store = open(dir);
    store.createRun({ runId: 'b1', intake: intakeOf(TEST_1), graph });
    const stop = new AbortController();
    const p1 = schedulerFor(graph, store, 'b1', {
      health: new ProviderHealth(),
      runBudgetUsd,
      signal: stop.signal,
      script: (taskId) =>
        taskId === 'update-page-title'
          ? { usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.0009 } }
          : { delayMs: 60_000 },
    });
    const done = p1.scheduler.run();
    while (p1.runner.calls.find((c) => c.taskId === 'update-page-title')?.settledAs !== 'resolved')
      await new Promise((r) => setTimeout(r, 5));
    stop.abort();
    await done;
    const spend = store.spendLedger('b1').attemptSpend();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    return { graph, spend };
  }

  it('persists each attempt as an actual or a routed estimate, never inventing either', async () => {
    const { spend } = await crashAfterTitle(dataDir(), 1);
    expect(spend.map((s) => [s.taskId, s.attempt, s.source])).toEqual([
      ['update-button-color', 1, 'estimate'],
      ['update-page-title', 1, 'actual'],
    ]);
    expect(spend[0]?.usd).toBeGreaterThan(0);
    expect(spend[1]?.usd).toBe(0.0009);
  });

  it('the rebuilt budget blocks the next attempt when the run would overspend', async () => {
    const dir = dataDir();
    const first = await crashAfterTitle(dir, 1);
    const buttonEstimate = first.spend.find((s) => s.taskId === 'update-button-color')?.usd ?? 0;
    expect(buttonEstimate).toBeGreaterThan(0);
    // Spent before restart: 0.0009 (title actual) + the button's in-flight estimate. One more
    // button attempt does not fit into this budget.
    const budget = 0.0009 + buttonEstimate * 1.5;

    const store = open(dir);
    store.recoverInterrupted('b1');
    const p2 = schedulerFor(first.graph, store, 'b1', {
      health: new ProviderHealth(),
      runBudgetUsd: budget,
      resume: true,
      script: () => ({ usage: { inputTokens: 1000, outputTokens: 200 } }),
    });
    const r2 = await p2.scheduler.run();
    expect(p2.runner.calls).toHaveLength(0); // the title is not re-run; the button is refused
    expect(r2.outcomes.get('update-button-color')?.error).toMatch(
      new RegExp(`^run budget exhausted: spent \\$${(0.0009 + buttonEstimate).toFixed(6)}`),
    );
    expect(p2.supervisor.runSpent()).toBeCloseTo(0.0009 + buttonEstimate, 9);

    // Control: without the persisted ledger the same restart would only see the button's own
    // (unreviewed) history and run it, i.e. overspend.
    const p3 = schedulerFor(first.graph, store, 'b1', {
      health: new ProviderHealth(),
      runBudgetUsd: budget,
      resume: true,
      ledger: false,
      script: () => ({ usage: { inputTokens: 1000, outputTokens: 200 } }),
    });
    await p3.scheduler.run();
    expect(p3.runner.calls.map((c) => c.taskId)).toEqual(['update-button-color']);
  });

  it('the rebuilt budget still allows the next attempt when it fits', async () => {
    const dir = dataDir();
    const first = await crashAfterTitle(dir, 1);
    const buttonEstimate = first.spend.find((s) => s.taskId === 'update-button-color')?.usd ?? 0;
    const budget = 0.0009 + buttonEstimate * 2 + 0.000001;

    const store = open(dir);
    store.recoverInterrupted('b1');
    const p2 = schedulerFor(first.graph, store, 'b1', {
      health: new ProviderHealth(),
      runBudgetUsd: budget,
      resume: true,
      script: () => ({ usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.0008 } }),
    });
    const r2 = await p2.scheduler.run();
    expect(p2.runner.calls.map((c) => [c.taskId, c.attempt])).toEqual([['update-button-color', 2]]);
    expect(r2.outcomes.get('update-button-color')?.state).toBe('succeeded');
    expect(store.spendLedger('b1').attemptSpend()).toEqual([
      { taskId: 'update-button-color', attempt: 1, usd: buttonEstimate, source: 'estimate' },
      { taskId: 'update-button-color', attempt: 2, usd: 0.0008, source: 'actual' },
      { taskId: 'update-page-title', attempt: 1, usd: 0.0009, source: 'actual' },
    ]);
  });
});
