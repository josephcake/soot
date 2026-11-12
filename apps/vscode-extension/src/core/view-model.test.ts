import { describe, expect, it } from 'vitest';
import { renderBoard } from './blocks.js';
import { toRunView } from './view-model.js';

/** Shape copied from a real `soot status <run> --json` / `soot cost <run> --json` (mock run). */
const status = {
  ok: true,
  runId: 'r1',
  state: 'running',
  running: true,
  prompt: 'Implement a feature, add tests, review it.',
  tasks: [
    {
      taskId: 'implement',
      complexity: 'medium',
      dependsOn: [],
      state: 'succeeded',
      models: ['demo-a/demo-small', 'demo-b/demo-mid'],
      verdict: 'verified',
      complete: true,
      reason: '3 checks passed',
      attemptDetails: [
        {
          attempt: 1,
          state: 'retried',
          model: 'demo-a/demo-small',
          escalationLevel: 0,
          estimatedCostUsd: 0.001,
          actualCostUsd: 0.0009,
          failure: 'validation-failed',
          error: 'acceptance test failed',
        },
        {
          attempt: 2,
          state: 'succeeded',
          model: 'demo-b/demo-mid',
          escalationLevel: 1,
          estimatedCostUsd: 0.002,
          actualCostUsd: 0.0018,
          failure: null,
          error: null,
        },
      ],
    },
    {
      taskId: 'tests',
      complexity: 'low',
      dependsOn: ['implement'],
      state: 'running',
      models: ['demo-a/demo-small'],
      attemptDetails: [],
    },
    {
      taskId: 'review',
      complexity: 'high',
      dependsOn: ['implement', 'tests'],
      state: 'pending',
      models: [],
      attemptDetails: [],
    },
  ],
  events: [
    {
      taskId: 'implement',
      attempt: 1,
      type: 'assign',
      model: 'demo-a/demo-small',
      reason: 'cheapest',
    },
    {
      taskId: 'implement',
      attempt: 2,
      type: 'escalate',
      model: 'demo-b/demo-mid',
      reason: 'validation failed',
    },
  ],
};
const cost = {
  ok: true,
  cost: {
    totals: {
      estimated: { inputTokens: 1, outputTokens: 1, usd: 0.003 },
      actual: {
        attempts: 2,
        inputTokens: 1,
        outputTokens: 1,
        usd: 0.0027,
        unpricedAttempts: 0,
        unreportedAttempts: 0,
      },
    },
  },
};

describe('toRunView: only what the engine reported', () => {
  it('computes graph layers from dependencies and marks running tasks active', () => {
    const view = toRunView(status, cost);
    expect(view.tasks.map((t) => [t.id, t.layer, t.active])).toEqual([
      ['implement', 0, false],
      ['tests', 1, true],
      ['review', 2, false],
    ]);
  });
  it('keeps escalations and drops routine assign/accept events', () => {
    expect(toRunView(status).events.map((e) => e.type)).toEqual(['escalate']);
  });
  it('reads estimate and actual USD from cost totals, and none without a cost report', () => {
    expect(toRunView(status, cost).cost).toMatchObject({ estimatedUsd: 0.003, actualUsd: 0.0027 });
    expect(toRunView(status).cost).toBeNull();
  });
  it('tolerates missing fields instead of inventing values', () => {
    const view = toRunView({ runId: 'x', tasks: [{ taskId: 't' }] });
    expect(view.tasks[0]).toMatchObject({
      state: 'pending',
      models: [],
      attempts: [],
      verdict: null,
    });
    expect(view.state).toBe('unknown');
  });
});

describe('renderBoard: stacked text blocks, no dashboard', () => {
  it('shows the graph by layer, active agents, escalations, failures and cost', () => {
    const board = renderBoard(toRunView(status, cost));
    expect(board).toContain('== Task graph ==');
    expect(board).toMatch(/L0 \[■ implement · demo-small→demo-mid · 2x\]/);
    expect(board).toMatch(/L1 \[▣ tests/);
    expect(board).toMatch(/L2 \[□ review/);
    expect(board).toMatch(/└▶ review ← implement, tests/);
    expect(board).toMatch(/== Active agents ==\n.*tests.*demo-small/);
    expect(board).toMatch(/ESCALATE implement #2 → demo-mid: validation failed/);
    expect(board).toMatch(/✕ implement #1 retried \(validation-failed\): acceptance test failed/);
    expect(board).toMatch(/▣ tests on demo-small \(starting\)/);
    expect(board).toMatch(/▣ tests: running/);
    expect(board).toContain('estimate $0.003000 | actual $0.002700');
  });
  it('says plainly when there is no cost report yet', () => {
    expect(renderBoard(toRunView(status))).toMatch(/== Cost ==\n.*not available/i);
  });
});
