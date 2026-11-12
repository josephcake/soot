import { describe, expect, it } from 'vitest';
import { usageCharts } from './charts.js';

const attempt = (o: Record<string, unknown>) => ({
  attempt: 1,
  model: 'p/small',
  status: 'succeeded',
  estimatedUsd: 0.001,
  inputTokens: 100,
  outputTokens: 10,
  actualUsd: 0.002,
  ...o,
});
const cost = {
  cost: {
    tasks: [
      {
        taskId: 'a',
        estimated: { inputTokens: 1000, outputTokens: 100, usd: 0.003 },
        attempts: [
          attempt({}),
          attempt({ attempt: 2, model: 'p/mid', estimatedUsd: 0.004, actualUsd: null }),
        ],
      },
      {
        taskId: 'b',
        estimated: { inputTokens: 500, outputTokens: 50, usd: null },
        attempts: [
          attempt({
            estimatedUsd: null,
            status: 'no-result',
            inputTokens: null,
            outputTokens: null,
            actualUsd: null,
          }),
        ],
      },
      { taskId: 'c', estimated: { inputTokens: 200, outputTokens: 20, usd: 0.0005 }, attempts: [] },
    ],
  },
};

describe('usageCharts', () => {
  const u = usageCharts(cost, 'mock-test-double');

  it('by task: planner tokens, routed estimates and reported actuals stay separate', () => {
    expect(u.byTask.map((r) => [r.label, r.attempts, r.estimated, r.actual])).toEqual([
      [
        'a',
        2,
        { inputTokens: 1000, outputTokens: 100, usd: 0.005 },
        // One attempt is unpriced: the actual sum is unknown, never the estimate, never 0.002.
        { inputTokens: 200, outputTokens: 20, usd: null },
      ],
      [
        'b',
        1,
        { inputTokens: 500, outputTokens: 50, usd: null },
        { inputTokens: null, outputTokens: null, usd: null },
      ],
      // Never ran: nothing reported, so unknown rather than zero.
      [
        'c',
        0,
        { inputTokens: 200, outputTokens: 20, usd: null },
        { inputTokens: null, outputTokens: null, usd: null },
      ],
    ]);
  });

  it('by model: attempts grouped by routed model; unknowns propagate', () => {
    expect(u.byModel.map((r) => [r.label, r.attempts, r.estimated.usd, r.actual])).toEqual([
      ['p/small', 2, null, { inputTokens: null, outputTokens: null, usd: null }],
      ['p/mid', 1, 0.004, { inputTokens: 100, outputTokens: 10, usd: null }],
    ]);
  });

  it('by runner: one row for the saved runner label, none when the runner is unknown', () => {
    expect(u.byAgent).toHaveLength(1);
    expect(u.byAgent[0]).toMatchObject({ label: 'mock-test-double', attempts: 3 });
    expect(u.byAgent[0]?.actual.usd).toBeNull();
    expect(usageCharts(cost, null).byAgent).toEqual([]);
  });

  it('no cost data means no rows, not zero rows', () => {
    expect(usageCharts(null, 'x')).toMatchObject({ byTask: [], byModel: [] });
    expect(usageCharts(null, 'x').byAgent[0]?.actual).toEqual({
      inputTokens: null,
      outputTokens: null,
      usd: null,
    });
  });
});
