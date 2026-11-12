/**
 * Milestone 4 exit criteria, end to end, with mocks only (no network, no keys, no model calls):
 * spec prompt → fixture decomposer → Scheduler + AdaptiveSupervisor → per-attempt routing on a
 * fictional registry → scripted mock agents → SQLite execution store.
 *
 *  EC1 failed or low-confidence work escalates mid-flight to a stronger model, context preserved
 *  EC2 unrelated tasks keep running and are not restarted
 *  EC3 retries and escalation are bounded (attempts, escalations, budget)
 *  EC4 downgrades happen after planning/investigation when appropriate, and only then
 *  EC5 timeouts, rate limits, outages, crashes, and invalid output recover without losing state
 *  EC6 a task or a whole run can be cancelled cleanly
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MockAgentRunner,
  Scheduler,
  type ExecutionJournal,
  type MockScript,
  type RunReport,
  type SchedulerOptions,
} from '@soot/agent-runtime';
import { openExecutionStore, type PersistedRun } from '@soot/context-manager';
import { AdaptiveSupervisor, type AdaptiveSupervisorOptions } from '@soot/escalation';
import { ProviderHealth } from '@soot/model-registry';
import { FixtureDecomposer, SPEC_FIXTURES, createPromptIntake } from '@soot/planner';
import { buildTaskGraph, type Task, type TaskGraph } from '@soot/task-graph';
import { routingRegistry } from '../packages/model-router/src/test-fixtures.js';

const TEST_1 = 'Change the page title to HELLO WORLD and update the primary button to purple.';
const TEST_2 =
  'Change the button color to purple, add a reusable dropdown component, and investigate the previous authentication bug.';
const TEST_3 = 'Update the theme color.';
const TEST_4 =
  'Implement a new feature, add tests, and review the implementation for security issues.';

const SMALL = 'alpha/test-small';
const MID = 'beta/test-mid';
const LARGE = 'alpha/test-large';

async function decompose(prompt: string): Promise<Task[]> {
  const intake = createPromptIntake({ prompt, context: { name: 'demo-app' } });
  return [...(await new FixtureDecomposer(SPEC_FIXTURES).decompose(intake)).tasks];
}

/** Scripted behaviour per task: given the attempt number and assigned model, what happens. */
type Behaviour = (attempt: number, model: string | null) => MockScript;

interface AdaptiveRun {
  readonly report: RunReport;
  readonly runner: MockAgentRunner;
  readonly supervisor: AdaptiveSupervisor;
  readonly health: ProviderHealth;
}

function setup(
  graph: TaskGraph,
  behaviours: Readonly<Record<string, Behaviour>>,
  options: {
    readonly supervisor?: Partial<AdaptiveSupervisorOptions>;
    readonly scheduler?: Partial<SchedulerOptions>;
    readonly health?: ProviderHealth;
  } = {},
) {
  const health = options.health ?? new ProviderHealth();
  const supervisor = new AdaptiveSupervisor({
    registry: routingRegistry(),
    policy: 'balanced',
    health,
    ...options.supervisor,
    config: { backoff: { baseDelayMs: 5, maxDelayMs: 50 }, ...options.supervisor?.config },
  });
  const runner = new MockAgentRunner({
    scriptFor: (input) =>
      behaviours[input.task.id]?.(input.attempt, input.assignment?.model ?? null) ?? {
        usage: { inputTokens: 1000, outputTokens: 200 },
      },
  });
  const scheduler = new Scheduler(graph, {
    runner,
    concurrency: 4,
    supervisor,
    ...options.scheduler,
  });
  return { scheduler, runner, supervisor, health };
}

async function run(...args: Parameters<typeof setup>): Promise<AdaptiveRun> {
  const { scheduler, ...rest } = setup(...args);
  return { report: await scheduler.run(), ...rest };
}

const outcome = (report: RunReport, id: string) => {
  const o = report.outcomes.get(id);
  if (o === undefined) throw new Error(`no outcome for ${id}`);
  return o;
};
const models = (report: RunReport, id: string) =>
  outcome(report, id).attempts.map((a) => a.assignment?.model ?? null);
const callsFor = (runner: MockAgentRunner, id: string) =>
  runner.calls.filter((c) => c.taskId === id);
const ok = (extra: MockScript = {}): MockScript => ({
  usage: { inputTokens: 1000, outputTokens: 200 },
  ...extra,
});

const allAssigned: string[] = [];
afterEach(() => {
  // ADR-016 / brief: DeepSeek is never assigned on any path exercised here.
  expect(allAssigned.some((m) => m.startsWith('deepseek/'))).toBe(false);
});
function track(r: AdaptiveRun): AdaptiveRun {
  for (const e of r.supervisor.events) if (e.model !== null) allAssigned.push(e.model);
  return r;
}

describe('Milestone 4 end to end: spec §17 Test 3 (runtime escalation)', () => {
  it('EC1/EC2: a simple-looking task escalates with its findings; unrelated tasks are untouched', async () => {
    const tasks = [...(await decompose(TEST_3)), ...(await decompose(TEST_1))];
    expect(tasks.map((t) => [t.id, t.complexity])).toEqual([
      ['update-theme-color', 'low'],
      ['update-page-title', 'low'],
      ['update-button-color', 'low'],
    ]);
    const finding = {
      kind: 'issue' as const,
      message: 'Theme color is computed by a shared theme engine with three inheritance layers.',
      files: ['src/theme/engine.ts'],
    };
    const r = track(
      await run(buildTaskGraph(tasks), {
        'update-theme-color': (_attempt, model) =>
          model === SMALL
            ? {
                outcome: 'fail',
                delayMs: 10,
                summary: 'Theme color is not a single token; stopped before editing.',
                findings: [finding],
                signals: { complexity: 'higher', confidence: 0.3 },
                usage: { inputTokens: 2500, outputTokens: 300 },
              }
            : ok({ delayMs: 10, signals: { confidence: 0.9 } }),
        'update-page-title': () => ok({ delayMs: 30 }),
        'update-button-color': () => ok({ delayMs: 30 }),
      }),
    );
    const { report, runner, supervisor } = r;
    expect(report.status).toBe('succeeded');

    // Started cheap, escalated once to a stronger model mid-flight.
    expect(models(report, 'update-theme-color')).toEqual([SMALL, MID]);
    const theme = outcome(report, 'update-theme-color');
    expect(theme.attempts.map((a) => a.assignment?.escalationLevel)).toEqual([0, 1]);
    const escalate = supervisor.events.find((e) => e.type === 'escalate');
    expect(escalate?.triggers.map((t) => t.kind)).toEqual([
      'unexpected-complexity',
      'low-confidence',
    ]);
    expect(escalate?.reason).toMatch(/higher complexity.*→ beta\/test-mid \(medium tier/);

    // Context transfer: the escalated attempt receives the first attempt's findings and summary.
    const second = callsFor(runner, 'update-theme-color')[1];
    expect(second?.priorAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        model: SMALL,
        outcome: 'reported-failure',
        summary: 'Theme color is not a single token; stopped before editing.',
        findings: [finding],
      }),
    ]);
    expect(second?.priorAttempts[0]?.note).toMatch(/^escalate:/);

    // The escalation happened while the unrelated tasks were still running; they ran once.
    for (const id of ['update-page-title', 'update-button-color']) {
      expect(callsFor(runner, id)).toHaveLength(1);
      expect(outcome(report, id).attempts).toHaveLength(1);
      expect((second?.startedAt ?? Infinity) < (outcome(report, id).finishedAt ?? 0)).toBe(true);
    }
  });

  it('EC1: a "successful" result with low confidence or unmet criteria is not accepted', async () => {
    const [task] = await decompose(TEST_3);
    if (task === undefined) throw new Error('fixture');
    const { report, supervisor } = track(
      await run(buildTaskGraph([task]), {
        'update-theme-color': (attempt) =>
          attempt === 1
            ? ok({
                signals: { confidence: 0.9, unmetCriteria: ['No unrelated theme tokens change.'] },
              })
            : ok({ signals: { confidence: 0.95 } }),
      }),
    );
    expect(models(report, 'update-theme-color')).toEqual([SMALL, MID]);
    const first = outcome(report, 'update-theme-color').attempts[0];
    expect(first?.result?.status).toBe('succeeded');
    expect(first?.failure?.kind).toBe('rejected');
    expect(first?.review).toMatchObject({ action: 'retry', delayMs: 0 });
    expect(first?.review?.action === 'retry' ? first.review.note : '').toMatch(
      /unmet acceptance criteria/,
    );
    expect(supervisor.events.map((e) => e.type)).toEqual(['assign', 'escalate', 'accept']);
  });
});

describe('Milestone 4 end to end: spec §17 Test 6 (failure recovery)', () => {
  let dataDir: string | undefined;
  afterEach(() => {
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it('EC5: outage, rate limit, timeout, crash, and invalid output each recover; nothing else re-runs', async () => {
    const tasks = [...(await decompose(TEST_2)), ...(await decompose(TEST_4))];
    dataDir = mkdtempSync(join(tmpdir(), 'soot-m4-test6-'));
    const store = openExecutionStore({ dataDir });
    const intake = createPromptIntake({
      prompt: `${TEST_2} ${TEST_4}`,
      context: { name: 'demo-app' },
    });
    const graph = buildTaskGraph(tasks);
    const runId = store.createRun({ intake, graph });
    const r = track(
      await run(
        graph,
        {
          // Provider outage on alpha → fallback to another provider.
          'update-button-color': (attempt) =>
            attempt === 1
              ? { outcome: 'provider-error', error: { kind: 'unavailable', provider: 'alpha' } }
              : ok(),
          // Rate limit with retry-after → same model after the delay.
          'add-dropdown-component': (attempt) =>
            attempt === 1
              ? { outcome: 'provider-error', error: { kind: 'rate-limited', retryAfterMs: 40 } }
              : ok(),
          // Hung provider call → timeout → same model again.
          'verify-auth-bug': (attempt) =>
            attempt === 1 ? { outcome: 'succeed', delayMs: 5_000 } : ok(),
          // Agent crash → same model again.
          'implement-feature': (attempt) => (attempt === 1 ? { outcome: 'throw' } : ok()),
          // Invalid output → same model again.
          'add-feature-tests': (attempt) => (attempt === 1 ? { outcome: 'invalid' } : ok()),
          'security-review': () => ok(),
        },
        { scheduler: { attemptTimeoutMs: 150, journal: store.journal(runId) } },
      ),
    );
    const { report, runner, health } = r;
    expect(report.status).toBe('succeeded');

    const kinds = (id: string) => outcome(report, id).attempts.map((a) => a.failure?.kind ?? 'ok');
    expect(kinds('update-button-color')).toEqual(['unavailable', 'ok']);
    expect(models(report, 'update-button-color')).toEqual([SMALL, MID]);
    expect(health.status('alpha')).toMatchObject({ available: false, reason: 'outage' });

    expect(kinds('add-dropdown-component')).toEqual(['rate-limited', 'ok']);
    expect(models(report, 'add-dropdown-component')).toEqual([MID, MID]);
    const [rl1, rl2] = callsFor(runner, 'add-dropdown-component');
    expect((rl2?.startedAt ?? 0) - (rl1?.finishedAt ?? 0)).toBeGreaterThanOrEqual(35);

    expect(kinds('verify-auth-bug')).toEqual(['timeout', 'ok']);
    expect(callsFor(runner, 'verify-auth-bug')[0]?.settledAs).toBe('aborted');
    expect(kinds('implement-feature')).toEqual(['crash', 'ok']);
    expect(kinds('add-feature-tests')).toEqual(['invalid-output', 'ok']);
    // Alpha was down when these were (re)planned, so the router kept them off alpha.
    for (const id of ['add-feature-tests', 'security-review']) {
      expect(models(report, id).every((m) => m?.startsWith('alpha/') !== true)).toBe(true);
    }

    // Succeeded tasks ran exactly once; failures cost exactly one extra attempt each.
    expect(callsFor(runner, 'security-review')).toHaveLength(1);
    expect(runner.calls).toHaveLength(11);

    // State is preserved: every attempt, its failure, and its review are in SQLite.
    const persisted = store.loadRun(runId);
    store.close();
    expect(persisted.tasks.map((t) => stateOf(persisted, t.id))).toEqual(
      tasks.map(() => 'succeeded'),
    );
    const saved = persisted.attemptRecords.get('add-dropdown-component') ?? [];
    expect(
      saved.map((a) => [a.attempt, a.assignment?.model, a.failure?.kind ?? null, a.review?.action]),
    ).toEqual([
      [1, MID, 'rate-limited', 'retry'],
      [2, MID, null, 'accept'],
    ]);
    expect(persisted.attempts.some((a) => a.state === 'running')).toBe(false);
  });

  it('EC5: a persistent rate limit falls back to another provider after bounded retries', async () => {
    const [task] = await decompose(TEST_3);
    if (task === undefined) throw new Error('fixture');
    const { report, health } = track(
      await run(buildTaskGraph([task]), {
        'update-theme-color': (_attempt, model) =>
          model === SMALL
            ? {
                outcome: 'provider-error',
                error: { kind: 'rate-limited', provider: 'alpha', retryAfterMs: 10 },
              }
            : ok(),
      }),
    );
    expect(models(report, 'update-theme-color')).toEqual([SMALL, SMALL, SMALL, MID]);
    expect(outcome(report, 'update-theme-color').attempts.map((a) => a.review?.action)).toEqual([
      'retry',
      'retry',
      'retry',
      'accept',
    ]);
    expect(health.status('alpha')).toMatchObject({ available: false, reason: 'rate-limited' });
  });

  it('EC5: the workflow resumes from SQLite after the process dies mid-recovery', async () => {
    const tasks = await decompose(TEST_1);
    dataDir = mkdtempSync(join(tmpdir(), 'soot-m4-resume-'));
    const store = openExecutionStore({ dataDir });
    const intake = createPromptIntake({ prompt: TEST_1, context: { name: 'demo-app' } });
    const graph = buildTaskGraph(tasks);
    const runId = store.createRun({ intake, graph });

    // Process 1: the title succeeds; the button hits a rate limit with a long retry-after,
    // and the process "dies" while the retry is pending (journal stops recording).
    let alive = true;
    const real = store.journal(runId);
    const dying: ExecutionJournal = {
      taskStarted: (...a) => {
        if (alive) real.taskStarted(...a);
      },
      taskFinished: (...a) => {
        if (alive) real.taskFinished(...a);
      },
      attemptFinished: (record) => {
        if (alive) real.attemptFinished?.(record);
      },
    };
    const first = setup(
      graph,
      {
        'update-page-title': () => ok(),
        'update-button-color': () => ({
          outcome: 'provider-error',
          error: { kind: 'rate-limited', retryAfterMs: 20_000 },
        }),
      },
      { scheduler: { journal: dying } },
    );
    const pending = first.scheduler.run();
    await waitFor(
      () =>
        first.runner.calls.length === 2 && first.runner.calls.every((c) => c.settledAs !== null),
    );
    await new Promise((r) => setTimeout(r, 10));
    alive = false;
    first.scheduler.cancel(); // tidy the in-memory timers; nothing reaches the store
    await pending;
    store.close();

    // Process 2: reopen the store, resume with persisted results and attempt history.
    const store2 = openExecutionStore({ dataDir });
    const before = store2.loadRun(runId);
    expect(stateOf(before, 'update-page-title')).toBe('succeeded');
    expect(stateOf(before, 'update-button-color')).toBe('retried');
    const second = track(
      await run(
        graph,
        { 'update-button-color': () => ok() },
        {
          scheduler: {
            journal: store2.journal(runId),
            completed: before.completed,
            previousAttempts: before.attemptCounts,
            previousAttemptRecords: before.attemptRecords,
          },
        },
      ),
    );
    expect(second.report.status).toBe('succeeded');
    expect(outcome(second.report, 'update-page-title').resumed).toBe(true);
    expect(second.runner.invokedTaskIds).toEqual(['update-button-color']);
    // The resumed attempt continues the persisted history: attempt 2, same model (retry-same).
    expect(second.runner.calls[0]?.attempt).toBe(2);
    expect(second.runner.calls[0]?.assignment?.model).toBe(SMALL);
    expect(second.runner.calls[0]?.priorAttempts.map((p) => p.outcome)).toEqual(['rate-limited']);
    const after = store2.loadRun(runId);
    store2.close();
    expect(stateOf(after, 'update-button-color')).toBe('succeeded');
    expect(after.attemptRecords.get('update-button-color')?.map((a) => a.review?.action)).toEqual([
      'retry',
      'accept',
    ]);
  });
});

describe('Milestone 4 end to end: bounds (M4-03)', () => {
  const failing = (): MockScript => ({
    outcome: 'fail',
    usage: { inputTokens: 1000, outputTokens: 200 },
  });

  it('EC3: an always-failing task stops at the attempt limit after climbing the model ladder', async () => {
    const [task] = await decompose(TEST_3);
    if (task === undefined) throw new Error('fixture');
    const { report, runner } = track(
      await run(buildTaskGraph([task]), { 'update-theme-color': failing }),
    );
    expect(models(report, 'update-theme-color')).toEqual([SMALL, SMALL, MID, MID, LARGE]);
    expect(runner.calls).toHaveLength(5);
    expect(outcome(report, 'update-theme-color').state).toBe('failed');
    expect(outcome(report, 'update-theme-color').error).toMatch(/^attempt limit reached \(5\/5\)/);
  });

  it('EC3: the escalation limit stops climbing when attempts remain', async () => {
    const [task] = await decompose(TEST_3);
    if (task === undefined) throw new Error('fixture');
    const { report } = track(
      await run(
        buildTaskGraph([task]),
        { 'update-theme-color': failing },
        { supervisor: { config: { maxAttemptsPerTask: 20, maxEscalationsPerTask: 1 } } },
      ),
    );
    expect(models(report, 'update-theme-color')).toEqual([SMALL, SMALL, MID, MID]);
    expect(outcome(report, 'update-theme-color').error).toMatch(/^escalation limit reached \(1\)/);
  });

  it('EC3: a task budget stops an escalation that would overspend; a run budget caps all tasks', async () => {
    const tasks = await decompose(TEST_2);
    const dropdown = tasks.find((t) => t.id === 'add-dropdown-component');
    if (dropdown === undefined) throw new Error('fixture');
    const capped = track(
      await run(
        buildTaskGraph([dropdown]),
        { 'add-dropdown-component': failing },
        { supervisor: { config: { taskBudgetUsd: 0.05 } } },
      ),
    );
    // mid costs ≈$0.016 per attempt; escalating to alpha/test-large (≈$0.0925) would exceed $0.05.
    expect(models(capped.report, 'add-dropdown-component')).toEqual([MID, MID]);
    expect(outcome(capped.report, 'add-dropdown-component').error).toMatch(
      /^task budget exhausted/,
    );

    const both = track(
      await run(
        buildTaskGraph(await decompose(TEST_1)),
        {},
        { supervisor: { config: { runBudgetUsd: 0.0015 } } },
      ),
    );
    expect(both.runner.calls).toHaveLength(1);
    expect([...both.report.outcomes.values()].map((o) => o.state).sort()).toEqual([
      'failed',
      'succeeded',
    ]);
    expect(both.supervisor.events.find((e) => e.type === 'stop')?.reason).toMatch(
      /^run budget exhausted/,
    );
  });

  it('EC3: an endless outage everywhere ends with a clear reason, not a loop', async () => {
    const [task] = await decompose(TEST_3);
    if (task === undefined) throw new Error('fixture');
    const { report, runner } = track(
      await run(buildTaskGraph([task]), {
        'update-theme-color': (_a, model) => ({
          outcome: 'provider-error',
          error: { kind: 'unavailable', provider: model?.split('/')[0] ?? 'x' },
        }),
      }),
    );
    expect(models(report, 'update-theme-color')).toEqual([SMALL, MID]);
    expect(runner.calls).toHaveLength(2);
    expect(outcome(report, 'update-theme-color').error).toMatch(/^no fallback model available/);
  });
});

describe('Milestone 4 end to end: downgrade after investigation (M4-04)', () => {
  const investigate: Task = {
    id: 'investigate-race',
    title: 'Investigate the checkout race condition',
    instructions: 'Find the root cause of the duplicate-order race and write a fix plan.',
    acceptanceCriteria: ['Root cause identified', 'Step-by-step fix plan recorded'],
    requiredCapabilities: ['code-read', 'debugging'],
    complexity: 'high',
    estimate: { inputTokens: 12_000, outputTokens: 2_000, costUsd: null },
    files: { read: ['src/checkout/'], write: [] },
    dependsOn: [],
  };
  const implement: Task = {
    id: 'apply-race-fix',
    title: 'Apply the race fix',
    instructions: 'Apply the fix plan from the investigation.',
    acceptanceCriteria: ['Duplicate orders are impossible'],
    requiredCapabilities: ['code-edit'],
    complexity: 'medium',
    estimate: { inputTokens: 6_000, outputTokens: 2_500, costUsd: null },
    files: { read: ['src/checkout/'], write: ['src/checkout/submit.ts'] },
    dependsOn: ['investigate-race'],
  };
  const review: Task = {
    id: 'review-race-fix',
    title: 'Security review of the fix',
    instructions: 'Review the fix for security issues.',
    acceptanceCriteria: ['No new security issues'],
    requiredCapabilities: ['code-read', 'security-review'],
    complexity: 'high',
    estimate: { inputTokens: 9_000, outputTokens: 1_500, costUsd: null },
    files: { read: ['src/checkout/'], write: [] },
    dependsOn: ['investigate-race'],
  };
  const plan = {
    kind: 'decision' as const,
    message: 'Fix plan: wrap submitOrder in an idempotency key check (src/checkout/submit.ts).',
  };
  const behaviours = {
    'investigate-race': () =>
      ok({ findings: [plan], signals: { planReady: true, confidence: 0.9 } }),
  };

  it('EC4: implementation is downgraded once a plan exists; high-risk work is not', async () => {
    const { report, runner, supervisor } = track(
      await run(buildTaskGraph([investigate, implement, review]), behaviours),
    );
    expect(report.status).toBe('succeeded');
    expect(models(report, 'investigate-race')).toEqual([LARGE]);
    expect(models(report, 'apply-race-fix')).toEqual([SMALL]);
    const down = supervisor.events.find((e) => e.type === 'downgrade');
    expect(down?.reason).toMatch(
      /^downgraded: prerequisite investigate-race produced a plan; routed as low instead of medium, est\. \$0\.016000 → \$0\.004625 \(saves 71%\)$/,
    );
    // The cheaper model gets the plan through the dependency results.
    expect(callsFor(runner, 'apply-race-fix')[0]?.dependencyTaskIds).toEqual(['investigate-race']);
    // High-risk review keeps its strong model.
    expect(models(report, 'review-race-fix')).toEqual([LARGE]);
    expect(supervisor.events.find((e) => e.type === 'downgrade-skipped')?.reason).toMatch(
      /high-risk work is never downgraded/,
    );
  });

  it('EC4: no downgrade without a plan, and no switch when the saving is too small', async () => {
    const noPlan = track(
      await run(buildTaskGraph([investigate, implement]), { 'investigate-race': () => ok() }),
    );
    expect(models(noPlan.report, 'apply-race-fix')).toEqual([MID]);
    expect(noPlan.supervisor.events.some((e) => e.type.startsWith('downgrade'))).toBe(false);

    const strict = track(
      await run(buildTaskGraph([investigate, implement]), behaviours, {
        supervisor: { config: { downgrade: { enabled: true, minSavingsRatio: 0.8 } } },
      }),
    );
    expect(models(strict.report, 'apply-race-fix')).toEqual([MID]);
    expect(strict.supervisor.events.find((e) => e.type === 'downgrade-skipped')?.reason).toMatch(
      /save only 71% \(< 80%\), not worth a model switch/,
    );
  });
});

describe('Milestone 4 end to end: cancellation (M4-06)', () => {
  it('EC6: cancelling one task during backoff stops it and its dependents; others finish', async () => {
    const tasks = await decompose(TEST_4);
    const { scheduler, runner } = setup(buildTaskGraph(tasks), {
      'implement-feature': () => ({
        outcome: 'provider-error',
        error: { kind: 'rate-limited', retryAfterMs: 30_000 },
      }),
    });
    const pending = scheduler.run();
    await waitFor(() => runner.calls[0]?.settledAs != null);
    const t0 = Date.now();
    scheduler.cancel('implement-feature');
    const report = await pending;
    expect(Date.now() - t0).toBeLessThan(1_000); // the 30 s backoff timer was cleared
    expect(outcome(report, 'implement-feature').state).toBe('cancelled');
    expect(outcome(report, 'add-feature-tests').state).toBe('skipped');
    expect(outcome(report, 'security-review').state).toBe('skipped');
    expect(runner.calls).toHaveLength(1);
  });

  it('EC6: cancelling the whole run aborts running attempts and pending retries; no orphans', async () => {
    const tasks = await decompose(TEST_2);
    const dataDir = mkdtempSync(join(tmpdir(), 'soot-m4-cancel-'));
    try {
      const store = openExecutionStore({ dataDir });
      const graph = buildTaskGraph(tasks);
      const runId = store.createRun({
        intake: createPromptIntake({ prompt: TEST_2, context: { name: 'demo-app' } }),
        graph,
      });
      const controller = new AbortController();
      const { scheduler, runner } = setup(
        graph,
        {
          'update-button-color': () => ({
            outcome: 'provider-error',
            error: { kind: 'rate-limited', retryAfterMs: 30_000 },
          }),
          'add-dropdown-component': () => ok({ delayMs: 30_000 }),
          'verify-auth-bug': () => ok({ delayMs: 30_000 }),
        },
        { scheduler: { signal: controller.signal, journal: store.journal(runId) } },
      );
      const pending = scheduler.run();
      await waitFor(() => runner.calls.length === 3 && runner.calls[0]?.settledAs != null);
      controller.abort();
      const report = await pending;
      await new Promise((r) => setTimeout(r, 20));
      expect(report.status).toBe('cancelled');
      expect([...report.outcomes.values()].every((o) => o.state === 'cancelled')).toBe(true);
      expect(runner.calls.map((c) => c.settledAs)).toEqual(['rejected', 'aborted', 'aborted']);
      const persisted = store.loadRun(runId);
      store.close();
      expect(persisted.attempts.some((a) => a.state === 'running')).toBe(false);
      expect(persisted.tasks.every((t) => stateOf(persisted, t.id) === 'cancelled')).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/** Latest persisted state of a task (its highest-numbered attempt row). */
function stateOf(run: PersistedRun, taskId: string) {
  const rows = run.attempts.filter((a) => a.taskId === taskId);
  return rows.reduce<(typeof rows)[number] | undefined>(
    (best, a) => (best === undefined || a.attempt >= best.attempt ? a : best),
    undefined,
  )?.state;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}
