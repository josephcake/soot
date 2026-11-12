import { describe, expect, it } from 'vitest';
import type { AgentResult, Task } from '@soot/task-graph';
import {
  actualUsd,
  createCostRecord,
  estimatedUsd,
  recordAttempt,
  summarizeCosts,
  taskActualTotals,
  type ActualUsd,
  type EstimatedUsd,
} from './index.js';

const task = (id: string, costUsd: number | null): Task => ({
  id,
  title: id,
  instructions: 'x',
  acceptanceCriteria: ['x'],
  requiredCapabilities: ['code-edit'],
  complexity: 'low',
  estimate: { inputTokens: 1000, outputTokens: 100, costUsd },
  files: { read: [], write: [] },
  dependsOn: [],
});

const result = (
  taskId: string,
  attempt: number,
  costUsd: number | null,
  status: AgentResult['status'] = 'succeeded',
): AgentResult => ({
  taskId,
  attempt,
  status,
  summary: 'done',
  findings: [],
  patch: null,
  evidence: [],
  usage: {
    inputTokens: 1500,
    outputTokens: 300,
    durationMs: 1200,
    costUsd,
    model: costUsd === null ? null : 'model-x',
  },
});

describe('task cost records (M1-09)', () => {
  it('starts with the planner estimate and no actuals', () => {
    const record = createCostRecord(task('a', 0.01));
    expect(record).toEqual({
      taskId: 'a',
      estimate: { source: 'planner', inputTokens: 1000, outputTokens: 100, costUsd: 0.01 },
      attempts: [],
    });
  });

  it('records every attempt (including failed ones before an escalation) without touching the estimate', () => {
    const base = createCostRecord(task('a', 0.01));
    const record = recordAttempt(
      recordAttempt(base, result('a', 1, 0.004, 'failed')),
      result('a', 2, 0.02),
    );
    expect(record.estimate).toEqual(base.estimate);
    expect(base.attempts).toEqual([]); // immutable
    expect(record.attempts.map((a) => [a.attempt, a.status, a.costUsd, a.source])).toEqual([
      [1, 'failed', 0.004, 'agent-reported'],
      [2, 'succeeded', 0.02, 'agent-reported'],
    ]);
    const totals = taskActualTotals(record);
    expect(totals).toMatchObject({
      attempts: 2,
      inputTokens: 3000,
      outputTokens: 600,
      unpricedAttempts: 0,
    });
    expect(totals.costUsd).toBeCloseTo(0.024);
  });

  it('keeps estimate and actual totals separate and never treats unknown cost as zero', () => {
    const priced = recordAttempt(createCostRecord(task('a', 0.01)), result('a', 1, 0.02));
    const unpriced = recordAttempt(createCostRecord(task('b', null)), result('b', 1, null));
    const summary = summarizeCosts([priced, unpriced]);
    expect(summary.tasks).toBe(2);
    expect(summary.estimated).toEqual({
      inputTokens: 2000,
      outputTokens: 200,
      costUsd: null,
      tasksWithoutCostEstimate: ['b'],
    });
    expect(summary.actual).toMatchObject({
      attempts: 2,
      inputTokens: 3000,
      outputTokens: 600,
      costUsd: null,
      unpricedAttempts: 1,
    });

    const allPriced = summarizeCosts([priced]);
    expect(allPriced.estimated.costUsd).toBe(0.01);
    expect(allPriced.actual.costUsd).toBe(0.02);
  });

  it('rejects results for another task, duplicate attempts, and invalid amounts', () => {
    const record = recordAttempt(createCostRecord(task('a', null)), result('a', 1, null));
    expect(() => recordAttempt(record, result('b', 1, null))).toThrow(/cannot be recorded/);
    expect(() => recordAttempt(record, result('a', 1, null))).toThrow(/already recorded/);
    expect(() => estimatedUsd(-1)).toThrow(RangeError);
    expect(() => actualUsd(Number.NaN)).toThrow(RangeError);
  });

  it('estimates and actuals are distinct types', () => {
    const estimate: EstimatedUsd = estimatedUsd(1);
    const actual: ActualUsd = actualUsd(1);
    // @ts-expect-error an estimate is not an actual
    const wrongActual: ActualUsd = estimate;
    // @ts-expect-error an actual is not an estimate
    const wrongEstimate: EstimatedUsd = actual;
    // @ts-expect-error a plain number is neither
    const plain: ActualUsd = 1;
    expect([wrongActual, wrongEstimate, plain]).toEqual([1, 1, 1]);
  });
});
