import type { AgentResult, Task } from '@soot/task-graph';

/*
 * Task-level usage and cost records (non-negotiable #4: task-level billing).
 * Estimates (planner, before execution) and actuals (reported for each attempt) are kept in
 * separate fields with distinct branded number types, so they cannot be added, compared, or
 * assigned to each other by accident. Unknown costs stay `null`; they are never treated as 0.
 */

declare const estimatedBrand: unique symbol;
declare const actualBrand: unique symbol;

/** A cost estimate in USD. Not assignable to `ActualUsd`. */
export type EstimatedUsd = number & { readonly [estimatedBrand]: true };
/** A cost actually incurred in USD, as reported for an attempt. Not assignable to `EstimatedUsd`. */
export type ActualUsd = number & { readonly [actualBrand]: true };

export const estimatedUsd = (value: number): EstimatedUsd => checkUsd(value) as EstimatedUsd;
export const actualUsd = (value: number): ActualUsd => checkUsd(value) as ActualUsd;

function checkUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`invalid USD amount: ${value}`);
  return value;
}

export interface CostEstimate {
  readonly source: 'planner';
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** `null` until a model is routed and priced (Milestone 3). */
  readonly costUsd: EstimatedUsd | null;
}

export interface AttemptActual {
  readonly source: 'agent-reported';
  readonly attempt: number;
  readonly status: AgentResult['status'];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  /** `null` when the runtime could not price the call (e.g. mocks). */
  readonly costUsd: ActualUsd | null;
  readonly model: string | null;
}

/** Everything a task cost: its planner estimate and the actuals of every attempt (incl. escalations). */
export interface TaskCostRecord {
  readonly taskId: string;
  readonly estimate: CostEstimate;
  readonly attempts: readonly AttemptActual[];
}

export function createCostRecord(task: Task): TaskCostRecord {
  return Object.freeze({
    taskId: task.id,
    estimate: Object.freeze({
      source: 'planner' as const,
      inputTokens: task.estimate.inputTokens,
      outputTokens: task.estimate.outputTokens,
      costUsd: task.estimate.costUsd === null ? null : estimatedUsd(task.estimate.costUsd),
    }),
    attempts: Object.freeze([]),
  });
}

/** Return a new record with this attempt's reported usage appended. The estimate is untouched. */
export function recordAttempt(record: TaskCostRecord, result: AgentResult): TaskCostRecord {
  if (result.taskId !== record.taskId) {
    throw new Error(`result for "${result.taskId}" cannot be recorded on "${record.taskId}"`);
  }
  if (record.attempts.some((a) => a.attempt === result.attempt)) {
    throw new Error(`attempt ${result.attempt} of "${record.taskId}" is already recorded`);
  }
  const { usage } = result;
  const attempt: AttemptActual = Object.freeze({
    source: 'agent-reported' as const,
    attempt: result.attempt,
    status: result.status,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    durationMs: usage.durationMs,
    costUsd: usage.costUsd === null ? null : actualUsd(usage.costUsd),
    model: usage.model,
  });
  return Object.freeze({
    ...record,
    attempts: Object.freeze([...record.attempts, attempt].sort((a, b) => a.attempt - b.attempt)),
  });
}

export interface EstimateTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Sum of estimates, or `null` if any task has no cost estimate. */
  readonly costUsd: EstimatedUsd | null;
  readonly tasksWithoutCostEstimate: readonly string[];
}

export interface ActualTotals {
  readonly attempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  /** Sum of reported costs, or `null` if any attempt was unpriced. */
  readonly costUsd: ActualUsd | null;
  readonly unpricedAttempts: number;
}

export interface CostSummary {
  readonly tasks: number;
  readonly estimated: EstimateTotals;
  readonly actual: ActualTotals;
}

function sumAttempts(attempts: readonly AttemptActual[]): ActualTotals {
  const unpriced = attempts.filter((a) => a.costUsd === null).length;
  return {
    attempts: attempts.length,
    inputTokens: attempts.reduce((n, a) => n + a.inputTokens, 0),
    outputTokens: attempts.reduce((n, a) => n + a.outputTokens, 0),
    durationMs: attempts.reduce((n, a) => n + a.durationMs, 0),
    costUsd: unpriced > 0 ? null : actualUsd(attempts.reduce((n, a) => n + (a.costUsd ?? 0), 0)),
    unpricedAttempts: unpriced,
  };
}

/** Actual totals for one task across all of its attempts. */
export function taskActualTotals(record: TaskCostRecord): ActualTotals {
  return sumAttempts(record.attempts);
}

/** Totals over many tasks. Estimates and actuals are summed separately, never mixed. */
export function summarizeCosts(records: readonly TaskCostRecord[]): CostSummary {
  const missing = records.filter((r) => r.estimate.costUsd === null).map((r) => r.taskId);
  return {
    tasks: records.length,
    estimated: {
      inputTokens: records.reduce((n, r) => n + r.estimate.inputTokens, 0),
      outputTokens: records.reduce((n, r) => n + r.estimate.outputTokens, 0),
      costUsd:
        missing.length > 0
          ? null
          : estimatedUsd(records.reduce((n, r) => n + (r.estimate.costUsd ?? 0), 0)),
      tasksWithoutCostEstimate: missing,
    },
    actual: sumAttempts(records.flatMap((r) => r.attempts)),
  };
}
