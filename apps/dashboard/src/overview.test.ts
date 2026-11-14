import { describe, expect, it } from 'vitest';
import { complexityOf, complexitySignals, toOverview } from './overview.js';
import { toDashboardRun } from './view.js';

const run = (over: Record<string, unknown>, cost: Record<string, unknown> | null = null) =>
  toDashboardRun({ state: 'incomplete', running: false, prompt: 'p', tasks: [], ...over }, cost);

describe('toOverview', () => {
  it('is empty when there are no runs, not zero-filled', () => {
    const empty = toOverview([]);
    expect(empty).toMatchObject({
      prompts: [],
      flows: [],
      byModel: [],
      promptCount: 0,
      taskCount: 0,
    });
    // Aggregates over no runs: unknown (null with 0 runs covered), never a zero total.
    expect(empty.aggregate.tokens.actual).toEqual({ value: null, runs: 0 });
    expect(empty.aggregate.cost.actualUsd).toEqual({ value: null, runs: 0 });
    expect(empty.aggregate.outcomes.successRate).toBeNull();
    expect(empty.aggregate.usageByModel).toEqual([]);
    expect(empty.aggregate.validation.runsWithFinal).toBe(0);
  });

  it('counts unique tasks per model, including a task that hit two models, and sorts prompts newest first', () => {
    const older = run({
      runId: 'old',
      createdAt: '2026-11-12T09:00:00.000Z',
      prompt: 'first prompt',
      agentLabel: 'mock',
      tasks: [
        {
          taskId: 'a',
          state: 'succeeded',
          attemptDetails: [{ attempt: 1, state: 'succeeded', model: 'p/small' }],
        },
        {
          taskId: 'b',
          state: 'succeeded',
          attemptDetails: [{ attempt: 1, state: 'succeeded', model: 'p/small' }],
        },
      ],
    });
    const newer = run({
      runId: 'new',
      createdAt: '2026-11-12T11:00:00.000Z',
      prompt: 'second prompt',
      agentLabel: 'mock',
      tasks: [
        {
          taskId: 'x',
          state: 'succeeded',
          models: ['p/small', 'p/mid'],
          attemptDetails: [
            { attempt: 1, state: 'retried', model: 'p/small' },
            { attempt: 2, state: 'succeeded', model: 'p/mid' },
          ],
        },
        {
          taskId: 'y',
          state: 'pending',
          attemptDetails: [],
        },
      ],
    });
    const overview = toOverview([older, newer]);
    expect(overview.promptCount).toBe(2);
    expect(overview.taskCount).toBe(4);
    expect(overview.prompts.map((p) => p.runId)).toEqual(['new', 'old']);
    expect(overview.prompts[0]?.prompt).toBe('second prompt');
    // x counts under both models; y never started, so it is not a flow.
    expect(overview.flows).toEqual([
      { runId: 'new', prompt: 'second prompt', model: 'p/mid', tasks: 1 },
      { runId: 'new', prompt: 'second prompt', model: 'p/small', tasks: 1 },
      { runId: 'old', prompt: 'first prompt', model: 'p/small', tasks: 2 },
    ]);
    // p/small: 2 (old) + 1 (new) = 3; p/mid: 1. Biggest first.
    expect(overview.byModel).toEqual([
      { model: 'p/small', tasks: 3 },
      { model: 'p/mid', tasks: 1 },
    ]);
  });

  it('carries reported tokens and cost, and keeps them unknown when cost data is missing', () => {
    const withCost = run(
      {
        runId: 'c',
        createdAt: '2026-11-12T10:00:00.000Z',
        prompt: 'priced',
        tasks: [{ taskId: 'a', state: 'succeeded', attemptDetails: [] }],
      },
      {
        cost: {
          totals: {
            estimated: { inputTokens: 10, outputTokens: 2, usd: 0.01 },
            actual: {
              inputTokens: 8,
              outputTokens: 1,
              usd: 0.02,
              unpricedAttempts: 0,
              unreportedAttempts: 0,
            },
          },
        },
      },
    );
    const bare = run({
      runId: 'b',
      createdAt: '2026-11-12T08:00:00.000Z',
      prompt: 'unpriced',
      tasks: [{ taskId: 'a', state: 'succeeded', attemptDetails: [] }],
    });
    const overview = toOverview([withCost, bare]);
    expect(overview.prompts[0]?.tokens).toEqual({
      inputTokens: 8,
      outputTokens: 1,
      unreportedAttempts: 0,
    });
    expect(overview.prompts[0]?.cost).toEqual({ actualUsd: 0.02, unpricedAttempts: 0 });
    expect(overview.prompts[1]?.tokens).toBeNull();
    expect(overview.prompts[1]?.cost).toEqual({ actualUsd: null, unpricedAttempts: null });
  });

  it('aggregates across runs: partial sums say how many runs they cover, nothing is invented', () => {
    const priced = run(
      {
        runId: 'p1',
        createdAt: '2026-11-12T10:00:00.000Z',
        reportStatus: 'complete',
        finalValidation: [{ name: 'test', kind: 'test', status: 'passed', required: true }],
        tasks: [
          {
            taskId: 'a',
            state: 'succeeded',
            checks: [{ name: 'lint', kind: 'lint', status: 'failed', exitCode: 1 }],
            attemptDetails: [{ attempt: 1, state: 'succeeded', model: 'p/small' }],
          },
          { taskId: 'b', state: 'failed', attemptDetails: [] },
        ],
        events: [{ type: 'escalate', taskId: 'a', attempt: 2, model: 'p/mid', reason: 'r' }],
      },
      {
        cost: {
          tasks: [
            {
              taskId: 'a',
              estimated: { inputTokens: 10, outputTokens: 1 },
              attempts: [
                {
                  attempt: 1,
                  model: 'p/small',
                  estimatedUsd: 0.01,
                  inputTokens: 8,
                  outputTokens: 2,
                  actualUsd: 0.001,
                },
              ],
            },
          ],
          totals: {
            estimated: { inputTokens: 10, outputTokens: 1, usd: 0.01 },
            actual: {
              inputTokens: 8,
              outputTokens: 2,
              usd: 0.001,
              unpricedAttempts: 0,
              unreportedAttempts: 0,
            },
          },
        },
      },
    );
    const bare = run({
      runId: 'p2',
      createdAt: '2026-11-12T09:00:00.000Z',
      tasks: [{ taskId: 'c', state: 'succeeded', attemptDetails: [] }],
    });
    const ag = toOverview([priced, bare]).aggregate;
    expect(ag.tokens.actual).toEqual({
      value: { inputTokens: 8, outputTokens: 2, unreportedAttempts: 0 },
      runs: 1,
    });
    expect(ag.cost.actualUsd).toEqual({ value: 0.001, runs: 1 });
    // A report saved before planning was counted has no totals.run: the run total is the tasks'.
    expect(ag.cost.runUsd).toEqual({ value: 0.001, runs: 1 });
    expect(ag.outcomes).toMatchObject({ succeeded: 2, failed: 1, unfinished: 0 });
    expect(ag.outcomes.successRate).toBeCloseTo(2 / 3);
    expect(ag.validation.taskChecks).toEqual({ failed: 1 });
    expect(ag.validation.final).toEqual({ passed: 1 });
    expect(ag.validation.runsWithFinal).toBe(1);
    expect(ag.transitions).toEqual({ escalate: 1 });
    expect(ag.usageByModel.map((r) => [r.label, r.attempts, r.actual.usd])).toEqual([
      ['p/small', 1, 0.001],
    ]);
    expect(ag.usageNote).toContain('Runner label is from the saved report');
    expect(ag.savingsNote).toContain('does not claim savings');
  });

  it('the reported cost includes the planning call; an unknown planning cost leaves the run out', () => {
    const report = (run: unknown) => ({
      cost: {
        tasks: [],
        totals: {
          estimated: { inputTokens: 0, outputTokens: 0, usd: 0 },
          actual: {
            inputTokens: 0,
            outputTokens: 0,
            usd: 0.01,
            unpricedAttempts: 0,
            unreportedAttempts: 0,
          },
          run,
        },
      },
    });
    const planned = run({ runId: 'a' }, report({ usd: 0.013, planningUsd: 0.003 }));
    const unpricedPlan = run({ runId: 'b' }, report({ usd: null, planningUsd: null }));
    expect(planned.cost).toMatchObject({ actualUsd: 0.01, runUsd: 0.013 });
    expect(unpricedPlan.cost).toMatchObject({ actualUsd: 0.01, runUsd: null });
    const ag = toOverview([planned, unpricedPlan]).aggregate;
    expect(ag.cost.actualUsd).toEqual({ value: 0.02, runs: 2 });
    expect(ag.cost.runUsd).toEqual({ value: 0.013, runs: 1 });
  });

  it('complexity: each recorded input normalized, averaged, then bucketed 0-4', () => {
    const sig = { tasks: 6, planner: 1, depth: 4, tokens: 100_000, transitions: 6 };
    expect(complexityOf(sig)).toMatchObject({
      score: 1,
      level: 4,
      inputs: { tasks: 1, planner: 1, depth: 1, tokens: 1, retries: 1 },
      missing: [],
    });
    // 3 tasks → 0.4; planner 0.5; 2 layers → 1/3; 10k tokens → 0.5; 1 transition / 3 → 1/3.
    const mid = complexityOf({ tasks: 3, planner: 0.5, depth: 2, tokens: 10_000, transitions: 1 });
    expect(mid.inputs.tasks).toBeCloseTo(0.4);
    expect(mid.inputs.depth).toBeCloseTo(1 / 3);
    expect(mid.inputs.tokens).toBeCloseTo(0.5);
    expect(mid.score).toBe(0.413);
    expect(mid.level).toBe(2);
    // Tokens are a capped log scale: ≤1k → 0, 1M → still 1.
    expect(complexityOf({ ...sig, tokens: 500 }).inputs.tokens).toBe(0);
    expect(complexityOf({ ...sig, tokens: 1_000_000 }).inputs.tokens).toBe(1);
    // Deterministic.
    expect(complexityOf(sig)).toEqual(complexityOf({ ...sig }));
  });

  it('complexity: missing fields are left out of the mean, never counted as zero', () => {
    const noTokens = complexityOf({
      tasks: 6,
      planner: null,
      depth: 1,
      tokens: null,
      transitions: 0,
    });
    expect(noTokens.missing).toEqual(['planner', 'tokens']);
    // Mean of tasks 1, depth 0, retries 0 only.
    expect(noTokens.score).toBe(0.333);
    expect(noTokens.level).toBe(1);
    const nothing = complexityOf({
      tasks: 0,
      planner: null,
      depth: 0,
      tokens: null,
      transitions: 0,
    });
    expect(nothing.score).toBeNull();
    expect(nothing.level).toBe(0);
    expect(nothing.missing).toEqual(['tasks', 'planner', 'depth', 'tokens', 'retries']);
  });

  it('complexity signals come from the run: task count, planner complexity, layers, tokens, transitions', () => {
    const r = run(
      {
        runId: 'c',
        tasks: [
          { taskId: 'a', complexity: 'low', state: 'succeeded', attemptDetails: [] },
          {
            taskId: 'b',
            complexity: 'high',
            dependsOn: ['a'],
            state: 'succeeded',
            attemptDetails: [],
          },
          { taskId: 'c', complexity: 'unknown-label', state: 'succeeded', attemptDetails: [] },
        ],
        events: [
          { type: 'assign', taskId: 'a', attempt: 1, model: 'm', reason: '' },
          { type: 'escalate', taskId: 'b', attempt: 2, model: 'm', reason: '' },
        ],
      },
      {
        cost: {
          totals: {
            actual: {
              inputTokens: 900,
              outputTokens: 100,
              usd: 0,
              unpricedAttempts: 0,
              unreportedAttempts: 0,
            },
          },
        },
      },
    );
    expect(complexitySignals(r)).toEqual({
      tasks: 3,
      planner: 0.5,
      depth: 2,
      tokens: 1000,
      transitions: 1,
    });
    expect(toOverview([r]).prompts[0]?.complexity.level).toBe(
      complexityOf(complexitySignals(r)).level,
    );
  });
});
