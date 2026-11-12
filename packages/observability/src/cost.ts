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

/**
 * The router's estimate for one attempt (ADR-030), written when the attempt was routed. It is
 * an estimate only: it never becomes, fills in, or is added to an actual.
 */
export interface RoutedEstimate {
  readonly source: 'router';
  readonly attempt: number;
  /** Model the router assigned. */
  readonly model: string | null;
  /** `null` when the assigned model has no price. */
  readonly costUsd: EstimatedUsd | null;
  /**
   * Whether the runner reports it ran the routed model: `true`/`false` from its result's
   * `usage.model`, `null` when the attempt returned no result. An ACP agent that did not apply
   * the route (ADR-028) reports no model, so this is `false`.
   */
  readonly routeApplied: boolean | null;
}

/**
 * Everything a task cost: its planner estimate, the router's estimate for every attempt, and
 * the reported actuals of every attempt (incl. escalations). Three separate lists, never mixed.
 */
export interface TaskCostRecord {
  readonly taskId: string;
  readonly estimate: CostEstimate;
  readonly routed: readonly RoutedEstimate[];
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
    routed: Object.freeze([]),
    attempts: Object.freeze([]),
  });
}

export interface RoutedEstimateInput {
  readonly attempt: number;
  readonly model: string | null;
  readonly costUsd: number | null;
  readonly routeApplied: boolean | null;
}

/** Return a new record with the router's estimate for this attempt. Actuals are untouched. */
export function recordRoutedEstimate(
  record: TaskCostRecord,
  input: RoutedEstimateInput,
): TaskCostRecord {
  if (record.routed.some((r) => r.attempt === input.attempt)) {
    throw new Error(`routed estimate for attempt ${input.attempt} of "${record.taskId}" exists`);
  }
  const routed: RoutedEstimate = Object.freeze({
    source: 'router' as const,
    attempt: input.attempt,
    model: input.model,
    costUsd: input.costUsd === null ? null : estimatedUsd(input.costUsd),
    routeApplied: input.routeApplied,
  });
  return Object.freeze({
    ...record,
    routed: Object.freeze([...record.routed, routed].sort((a, b) => a.attempt - b.attempt)),
  });
}

/** One persisted attempt, as the runtime has it (assignment from the router, result if any). */
export interface AttemptCostInput {
  readonly taskId: string;
  readonly attempt: number;
  readonly assignment: {
    readonly model: string | null;
    readonly estimatedCostUsd: number | null;
  } | null;
  readonly result: AgentResult | null;
}

/**
 * Build every task's cost record from the run's attempts (done automatically by `soot run` and
 * `soot cost`): routed estimates from the assignments, actuals only from results the runner
 * returned. An attempt without a result gets a routed estimate and no actual; nothing is
 * filled in.
 */
export function costRecordsFromAttempts(
  tasks: readonly Task[],
  attempts: readonly AttemptCostInput[],
): TaskCostRecord[] {
  return tasks.map((task) => {
    let record = createCostRecord(task);
    const mine = attempts
      .filter((a) => a.taskId === task.id && a.attempt > 0)
      .sort((a, b) => a.attempt - b.attempt);
    for (const a of mine) {
      if (a.assignment !== null) {
        record = recordRoutedEstimate(record, {
          attempt: a.attempt,
          model: a.assignment.model,
          costUsd: a.assignment.estimatedCostUsd,
          routeApplied:
            a.result === null
              ? null
              : a.assignment.model !== null && a.result.usage.model === a.assignment.model,
        });
      }
      if (a.result !== null) record = recordAttempt(record, a.result);
    }
    return record;
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

/** Totals of the router's per-attempt estimates. */
export interface RoutedEstimateTotals {
  readonly attempts: number;
  /** Sum of routed estimates, or `null` if any routed attempt has no price. */
  readonly costUsd: EstimatedUsd | null;
  readonly unpricedAttempts: number;
  /** Routed attempts whose runner reported a different model, or none (route not applied). */
  readonly routeNotApplied: number;
}

export interface CostSummary {
  readonly tasks: number;
  readonly estimated: EstimateTotals;
  readonly routed: RoutedEstimateTotals;
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
    routed: sumRouted(records.flatMap((r) => r.routed)),
    actual: sumAttempts(records.flatMap((r) => r.attempts)),
  };
}

function sumRouted(routed: readonly RoutedEstimate[]): RoutedEstimateTotals {
  const unpriced = routed.filter((r) => r.costUsd === null).length;
  return {
    attempts: routed.length,
    costUsd: unpriced > 0 ? null : estimatedUsd(routed.reduce((n, r) => n + (r.costUsd ?? 0), 0)),
    unpricedAttempts: unpriced,
    routeNotApplied: routed.filter((r) => r.routeApplied === false).length,
  };
}
