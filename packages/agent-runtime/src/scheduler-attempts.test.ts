import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttemptRecord, AttemptSupervisor, PlanContext, ReviewDecision } from './attempts.js';
import { MockAgentRunner, type MockScript } from './mock-agent.js';
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  Scheduler,
  runTaskGraph,
  type ExecutionJournal,
} from './scheduler.js';
import { graphOf, task } from './test-fixtures.js';

/** Supervisor scripted by test: model per attempt, and a review function. */
function supervisor(
  review: (record: AttemptRecord, history: readonly AttemptRecord[]) => ReviewDecision,
  plans: PlanContext[] = [],
  stopAt?: (ctx: PlanContext) => string | null,
): AttemptSupervisor {
  return {
    plan: (ctx) => {
      plans.push(ctx);
      const stop = stopAt?.(ctx) ?? null;
      if (stop !== null) return { action: 'stop', reason: stop };
      return {
        action: 'run',
        assignment: {
          model: `m/${String(ctx.attempt)}`,
          reason: 'scripted',
          escalationLevel: ctx.attempt - 1,
          estimatedCostUsd: null,
        },
      };
    },
    review: ({ record, history }) => review(record, history),
  };
}
const retryFailures =
  (delayMs = 0, max = 3) =>
  (record: AttemptRecord, history: readonly AttemptRecord[]): ReviewDecision =>
    record.failure === null
      ? { action: 'accept' }
      : history.length + 1 < max
        ? { action: 'retry', delayMs, note: `retry after ${record.failure.kind}` }
        : { action: 'fail', reason: 'out of attempts' };

const waitFor = async (condition: () => boolean) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 2_000) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe('Scheduler with an AttemptSupervisor (Milestone 4)', () => {
  it('passes the assignment and prior-attempt context to the runner and records every attempt', async () => {
    const finished: AttemptRecord[] = [];
    const journal: ExecutionJournal = {
      taskStarted: () => undefined,
      taskFinished: () => undefined,
      attemptFinished: (r) => finished.push(r),
    };
    const runner = new MockAgentRunner({
      scripts: {
        a: [
          { outcome: 'fail', findings: [{ kind: 'issue', message: 'found the real cause' }] },
          { outcome: 'throw' },
          {},
        ],
      },
    });
    const report = await runTaskGraph(graphOf(task('a')), {
      runner,
      journal,
      supervisor: supervisor(retryFailures()),
    });
    expect(report.outcomes.get('a')?.state).toBe('succeeded');
    expect(runner.calls.map((c) => c.assignment?.model)).toEqual(['m/1', 'm/2', 'm/3']);
    expect(
      runner.calls[2]?.priorAttempts.map((p) => [p.attempt, p.model, p.outcome, p.note]),
    ).toEqual([
      [1, 'm/1', 'reported-failure', 'retry after reported-failure'],
      [2, 'm/2', 'crash', 'retry after crash'],
    ]);
    expect(runner.calls[1]?.priorAttempts[0]?.findings).toEqual([
      { kind: 'issue', message: 'found the real cause' },
    ]);
    expect(finished.map((r) => [r.attempt, r.failure?.kind ?? null, r.review?.action])).toEqual([
      [1, 'reported-failure', 'retry'],
      [2, 'crash', 'retry'],
      [3, null, 'accept'],
    ]);
    expect(report.outcomes.get('a')?.attempts).toHaveLength(3);
  });

  it('a task waiting to retry holds no concurrency slot', async () => {
    const runner = new MockAgentRunner({
      scripts: { a: [{ outcome: 'fail' }, {}], b: { delayMs: 10 } },
    });
    const report = await runTaskGraph(graphOf(task('a'), task('b')), {
      runner,
      concurrency: 1,
      supervisor: supervisor(retryFailures(60)),
    });
    expect(report.status).toBe('succeeded');
    expect(runner.calls.map((c) => `${c.taskId}${String(c.attempt)}`)).toEqual(['a1', 'b1', 'a2']);
    const b = runner.calls[1];
    expect((b?.finishedAt ?? Infinity) <= (runner.calls[2]?.startedAt ?? 0)).toBe(true);
  });

  it('times out a hung attempt, aborts it, and retries', async () => {
    const runner = new MockAgentRunner({
      scripts: { a: [{ outcome: 'succeed', delayMs: 10_000 }, {}] },
    });
    const report = await runTaskGraph(graphOf(task('a')), {
      runner,
      attemptTimeoutMs: 25,
      supervisor: supervisor(retryFailures()),
    });
    expect(report.outcomes.get('a')?.attempts.map((r) => r.failure?.kind ?? 'ok')).toEqual([
      'timeout',
      'ok',
    ]);
    expect(runner.calls[0]?.settledAs).toBe('aborted');
    expect(report.outcomes.get('a')?.attempts[0]?.failure?.message).toMatch(/25 ?ms/);
  });

  describe('default attempt timeout (no attemptTimeoutMs set)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is 30 minutes', () => {
      expect(DEFAULT_ATTEMPT_TIMEOUT_MS).toBe(1_800_000);
    });

    it('ends an attempt whose runner hangs forever and ignores abort', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const runner = new MockAgentRunner({ scripts: { a: { outcome: 'hang' } } });
      const done = runTaskGraph(graphOf(task('a'), task('b')), { runner });
      await vi.advanceTimersByTimeAsync(DEFAULT_ATTEMPT_TIMEOUT_MS - 1);
      expect(runner.calls).toHaveLength(2);
      let settled = false;
      void done.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false); // still inside the 30 minutes
      await vi.advanceTimersByTimeAsync(1);
      const report = await done;
      expect(report.outcomes.get('a')).toMatchObject({ state: 'failed' });
      expect(report.outcomes.get('a')?.attempts[0]?.failure).toMatchObject({
        kind: 'timeout',
        message: `attempt timed out after ${String(DEFAULT_ATTEMPT_TIMEOUT_MS)} ms`,
      });
      expect(report.outcomes.get('b')?.state).toBe('succeeded');
    });

    it('an explicit attemptTimeoutMs still wins over the default', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const runner = new MockAgentRunner({ scripts: { a: { outcome: 'hang' } } });
      const done = runTaskGraph(graphOf(task('a')), { runner, attemptTimeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      const report = await done;
      expect(report.outcomes.get('a')?.attempts[0]?.failure?.message).toBe(
        'attempt timed out after 5000 ms',
      );
    });
  });

  it('a supervisor stop fails the task before any call and skips its dependents', async () => {
    const plans: PlanContext[] = [];
    const runner = new MockAgentRunner();
    const report = await runTaskGraph(graphOf(task('a'), task('b', ['a']), task('c')), {
      runner,
      supervisor: supervisor(retryFailures(), plans, (ctx) =>
        ctx.task.id === 'a' ? 'budget exhausted' : null,
      ),
    });
    expect(report.outcomes.get('a')).toMatchObject({
      state: 'failed',
      error: 'budget exhausted',
      attempts: [],
    });
    expect(report.outcomes.get('b')?.state).toBe('skipped');
    expect(runner.invokedTaskIds).toEqual(['c']);
  });

  it('gives the supervisor the dependency results, and continues persisted history on resume', async () => {
    const plans: PlanContext[] = [];
    const seeded: AttemptRecord = {
      taskId: 'b',
      attempt: 1,
      assignment: { model: 'm/1', reason: 'r', escalationLevel: 0, estimatedCostUsd: null },
      result: null,
      failure: { kind: 'crash', message: 'agent error: boom', provider: null, retryAfterMs: null },
      review: { action: 'retry', delayMs: 0, note: 'retry after crash' },
      startedAt: null,
      finishedAt: null,
    };
    const runner = new MockAgentRunner();
    await runTaskGraph(graphOf(task('a'), task('b', ['a'])), {
      runner,
      supervisor: supervisor(retryFailures(), plans),
      previousAttempts: new Map([['b', 1]]),
      previousAttemptRecords: new Map([['b', [seeded]]]),
    });
    const b = plans.find((p) => p.task.id === 'b');
    expect(b?.attempt).toBe(2);
    expect(b?.history).toEqual([seeded]);
    expect(b?.dependencyResults.map((r) => r.taskId)).toEqual(['a']);
    expect(runner.calls.find((c) => c.taskId === 'b')?.priorAttempts.map((p) => p.failure)).toEqual(
      ['agent error: boom'],
    );
  });

  it('cancelling a task during a retried attempt aborts it and starts nothing new', async () => {
    const scripts: Record<string, MockScript[]> = { a: [{ outcome: 'fail' }, { delayMs: 10_000 }] };
    const runner = new MockAgentRunner({ scripts });
    const scheduler = new Scheduler(graphOf(task('a'), task('z')), {
      runner,
      supervisor: supervisor(retryFailures()),
    });
    const pending = scheduler.run();
    await waitFor(() => runner.calls.length === 3);
    scheduler.cancel('a');
    const report = await pending;
    expect(report.outcomes.get('a')?.state).toBe('cancelled');
    expect(report.outcomes.get('z')?.state).toBe('succeeded');
    const a = runner.calls.filter((c) => c.taskId === 'a');
    expect(a.map((c) => c.settledAs)).toEqual(['resolved', 'aborted']);
  });

  it('cancelling the run clears pending retry timers promptly (no live timer left behind)', async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timers();
    const runner = new MockAgentRunner({ scripts: { a: { outcome: 'fail' } } });
    const controller = new AbortController();
    const scheduler = new Scheduler(graphOf(task('a')), {
      runner,
      signal: controller.signal,
      supervisor: supervisor(retryFailures(60_000)),
    });
    const pending = scheduler.run();
    await waitFor(() => runner.calls[0]?.settledAs != null);
    const t0 = Date.now();
    controller.abort();
    const report = await pending;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(report.status).toBe('cancelled');
    expect(runner.calls).toHaveLength(1);
    expect(timers()).toBeLessThanOrEqual(before);
  });
});
