import { describe, expect, it } from 'vitest';
import type { AgentResult } from '@soot/task-graph';
import { graphOf, task } from './test-fixtures.js';
import {
  MockAgentRunner,
  Scheduler,
  runTaskGraph,
  type RunReport,
  type TaskOutcome,
} from './index.js';

const outcome = (report: RunReport, id: string): TaskOutcome => {
  const found = report.outcomes.get(id);
  if (!found) throw new Error(`no outcome for ${id}`);
  return found;
};

const interval = (report: RunReport, id: string): [number, number] => {
  const o = outcome(report, id);
  if (o.startedAt === null || o.finishedAt === null) throw new Error(`${id} did not run`);
  return [o.startedAt, o.finishedAt];
};

const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

describe('scheduler (M1-05)', () => {
  it('runs independent tasks concurrently: their execution intervals overlap', async () => {
    const delayMs = 150;
    const runner = new MockAgentRunner({ defaultScript: { delayMs } });
    const report = await runTaskGraph(graphOf(task('a'), task('b'), task('c')), {
      runner,
      concurrency: 3,
    });

    expect(report.status).toBe('succeeded');
    const [a, b, c] = [interval(report, 'a'), interval(report, 'b'), interval(report, 'c')];
    // Every task started before any other finished.
    expect(overlaps(a, b) && overlaps(a, c) && overlaps(b, c)).toBe(true);
    expect(Math.max(a[0], b[0], c[0])).toBeLessThan(Math.min(a[1], b[1], c[1]));
    expect(report.maxObservedConcurrency).toBe(3);
    // Wall time is close to one delay, not the sum of three.
    expect(report.finishedAt - report.startedAt).toBeLessThan(delayMs * 2);
    // The mock saw the same overlap independently of the scheduler's bookkeeping.
    const calls = runner.calls;
    expect(Math.max(...calls.map((c) => c.startedAt))).toBeLessThan(
      Math.min(...calls.map((c) => c.finishedAt ?? Infinity)),
    );
  });

  it('dependents start only after every prerequisite finished, and receive their results', async () => {
    const runner = new MockAgentRunner({
      scripts: {
        implement: { delayMs: 80 },
        docs: { delayMs: 120 },
        tests: { delayMs: 40 },
        review: { delayMs: 40 },
      },
    });
    const graph = graphOf(
      task('implement'),
      task('docs'),
      task('tests', ['implement']),
      task('review', ['implement', 'docs']),
    );
    const report = await runTaskGraph(graph, { runner, concurrency: 4 });
    expect(report.status).toBe('succeeded');

    const [, implementEnd] = interval(report, 'implement');
    const [, docsEnd] = interval(report, 'docs');
    const [testsStart] = interval(report, 'tests');
    const [reviewStart] = interval(report, 'review');
    expect(testsStart).toBeGreaterThanOrEqual(implementEnd);
    expect(reviewStart).toBeGreaterThanOrEqual(Math.max(implementEnd, docsEnd));
    // `tests` did not wait for the unrelated `docs` task.
    expect(testsStart).toBeLessThan(docsEnd);

    // Event log ordering agrees with the timestamps.
    const order = report.events.map((e) => `${e.type === 'task-started' ? '+' : '-'}${e.taskId}`);
    expect(order.indexOf('+tests')).toBeGreaterThan(order.indexOf('-implement'));
    expect(order.indexOf('+review')).toBeGreaterThan(order.indexOf('-docs'));
    expect(order.slice(0, 2).sort()).toEqual(['+docs', '+implement']);

    const reviewCall = runner.calls.find((c) => c.taskId === 'review');
    expect(reviewCall?.dependencyTaskIds).toEqual(['implement', 'docs']);
  });

  it('bounds concurrency', async () => {
    const runner = new MockAgentRunner({ defaultScript: { delayMs: 30 } });
    const report = await runTaskGraph(
      graphOf(task('a'), task('b'), task('c'), task('d'), task('e')),
      {
        runner,
        concurrency: 2,
      },
    );
    expect(report.status).toBe('succeeded');
    expect(report.maxObservedConcurrency).toBe(2);
    let live = 0;
    let peak = 0;
    for (const e of report.events) {
      live += e.type === 'task-started' ? 1 : -1;
      peak = Math.max(peak, live);
    }
    expect(peak).toBe(2);
  });

  it('serializes tasks with conflicting declared writes even with spare capacity', async () => {
    const runner = new MockAgentRunner({ defaultScript: { delayMs: 40 } });
    const report = await runTaskGraph(
      graphOf(task('a', [], ['src/App.tsx']), task('b', [], ['src/App.tsx'])),
      {
        runner,
        concurrency: 4,
      },
    );
    expect(overlaps(interval(report, 'a'), interval(report, 'b'))).toBe(false);
    expect(report.maxObservedConcurrency).toBe(1);
  });

  it('a failed task skips its dependents but unrelated tasks still run', async () => {
    const runner = new MockAgentRunner({ scripts: { a: { outcome: 'fail' } } });
    const report = await runTaskGraph(
      graphOf(task('a'), task('b', ['a']), task('c', ['b']), task('x')),
      { runner },
    );
    expect(report.status).toBe('failed');
    expect(outcome(report, 'a')).toMatchObject({ state: 'failed', error: 'agent reported failed' });
    expect(outcome(report, 'a').result?.status).toBe('failed');
    expect(outcome(report, 'b')).toMatchObject({ state: 'skipped', attempt: null });
    expect(outcome(report, 'c').state).toBe('skipped');
    expect(outcome(report, 'x').state).toBe('succeeded');
    expect(runner.invokedTaskIds.sort()).toEqual(['a', 'x']);
  });

  it('treats crashes, blocked results, and invalid results as failures (results are validated)', async () => {
    const runner = new MockAgentRunner({
      scripts: {
        crash: { outcome: 'throw' },
        invalid: { outcome: 'invalid' },
        blocked: { outcome: 'block' },
      },
    });
    const report = await runTaskGraph(graphOf(task('crash'), task('invalid'), task('blocked')), {
      runner,
    });
    expect(outcome(report, 'crash').error).toMatch(/^agent error: .*crashed/);
    expect(outcome(report, 'invalid')).toMatchObject({ state: 'failed', result: null });
    expect(outcome(report, 'invalid').error).toMatch(/^invalid agent result: .*transcript/);
    expect(outcome(report, 'blocked').state).toBe('failed');
  });

  it('rejects a result that belongs to another task', async () => {
    const runner = {
      kind: 'liar',
      run: (): Promise<AgentResult> =>
        Promise.resolve({
          taskId: 'other',
          attempt: 1,
          status: 'succeeded',
          summary: 'done',
          findings: [],
          patch: null,
          evidence: [],
          usage: { inputTokens: 0, outputTokens: 0, durationMs: 0, costUsd: null, model: null },
        }),
    };
    const report = await runTaskGraph(graphOf(task('a')), { runner });
    expect(outcome(report, 'a').error).toMatch(/expected a#1/);
  });

  it('cancels the whole run: running tasks are aborted, pending tasks never start', async () => {
    const runner = new MockAgentRunner({ defaultScript: { delayMs: 10_000 } });
    const controller = new AbortController();
    const scheduler = new Scheduler(graphOf(task('a'), task('b'), task('c', ['a'])), {
      runner,
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'task-started' && e.taskId === 'b')
          setTimeout(() => {
            controller.abort();
          }, 20);
      },
    });
    const started = performance.now();
    const report = await scheduler.run();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(report.status).toBe('cancelled');
    expect([...report.outcomes.values()].map((o) => o.state)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    expect(runner.invokedTaskIds).toEqual(['a', 'b']);
    expect(runner.calls.map((c) => c.settledAs)).toEqual(['aborted', 'aborted']);
  });

  it('cancels one task: its dependents are skipped and the rest continue', async () => {
    const runner = new MockAgentRunner({
      scripts: { slow: { delayMs: 10_000 } },
      defaultScript: { delayMs: 20 },
    });
    const scheduler = new Scheduler(
      graphOf(task('slow'), task('after-slow', ['slow']), task('other')),
      {
        runner,
        onEvent: (e) => {
          if (e.type === 'task-started' && e.taskId === 'slow')
            queueMicrotask(() => {
              scheduler.cancel('slow');
            });
        },
      },
    );
    const report = await scheduler.run();
    expect(report.status).toBe('failed');
    expect(outcome(report, 'slow').state).toBe('cancelled');
    expect(outcome(report, 'after-slow').state).toBe('skipped');
    expect(outcome(report, 'other').state).toBe('succeeded');
  });

  it('does not wait for a hung agent that ignores cancellation', async () => {
    const runner = new MockAgentRunner({ scripts: { hung: { outcome: 'hang' } } });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 30);
    const report = await runTaskGraph(graphOf(task('hung')), { runner, signal: controller.signal });
    expect(outcome(report, 'hung').state).toBe('cancelled');
  });

  it('skips tasks completed in an earlier run and continues attempt numbering', async () => {
    const earlier = await runTaskGraph(graphOf(task('a'), task('b', ['a'])), {
      runner: new MockAgentRunner({ scripts: { b: { outcome: 'throw' } } }),
    });
    const aResult = outcome(earlier, 'a').result;
    if (!aResult) throw new Error('a should have a result');

    const runner = new MockAgentRunner();
    const report = await runTaskGraph(graphOf(task('a'), task('b', ['a'])), {
      runner,
      completed: new Map([['a', aResult]]),
      previousAttempts: new Map([['b', 1]]),
    });
    expect(report.status).toBe('succeeded');
    expect(runner.invokedTaskIds).toEqual(['b']);
    expect(outcome(report, 'a')).toMatchObject({ resumed: true, state: 'succeeded' });
    expect(outcome(report, 'b')).toMatchObject({ attempt: 2, resumed: false });
    expect(runner.calls[0]?.dependencyTaskIds).toEqual(['a']);
  });

  it('writes every transition to the journal synchronously', async () => {
    const log: string[] = [];
    await runTaskGraph(graphOf(task('a'), task('b', ['a'])), {
      runner: new MockAgentRunner(),
      journal: {
        taskStarted: (e) => log.push(`start ${e.taskId}#${e.attempt}`),
        taskFinished: (o) => log.push(`finish ${o.taskId} ${o.state}`),
      },
    });
    expect(log).toEqual(['start a#1', 'finish a succeeded', 'start b#1', 'finish b succeeded']);
  });

  it('validates options and refuses to run twice', async () => {
    const graph = graphOf(task('a'));
    expect(() => new Scheduler(graph, { runner: new MockAgentRunner(), concurrency: 0 })).toThrow(
      RangeError,
    );
    const scheduler = new Scheduler(graph, { runner: new MockAgentRunner() });
    await scheduler.run();
    await expect(scheduler.run()).rejects.toThrow(/only be called once/);
  });
});
