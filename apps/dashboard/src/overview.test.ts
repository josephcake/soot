import { describe, expect, it } from 'vitest';
import { toOverview } from './overview.js';
import { toDashboardRun } from './view.js';

const run = (over: Record<string, unknown>, cost: Record<string, unknown> | null = null) =>
  toDashboardRun({ state: 'incomplete', running: false, prompt: 'p', tasks: [], ...over }, cost);

describe('toOverview', () => {
  it('is empty when there are no runs, not zero-filled', () => {
    expect(toOverview([])).toEqual({
      prompts: [],
      flows: [],
      byModel: [],
      promptCount: 0,
      taskCount: 0,
    });
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
});
