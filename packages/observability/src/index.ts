/**
 * @soot/observability
 *
 * Milestone 1: per-task usage/cost records that keep planner estimates and reported actuals
 * strictly separate. No dashboard or UI (ADR-009); audit logs and reports come later.
 */

export const PACKAGE_NAME = '@soot/observability';

/** `partial`: the Milestone 1 scope is implemented; later milestones extend it. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 1;

export {
  actualUsd,
  createCostRecord,
  estimatedUsd,
  recordAttempt,
  summarizeCosts,
  taskActualTotals,
  type ActualTotals,
  type ActualUsd,
  type AttemptActual,
  type CostEstimate,
  type CostSummary,
  type EstimateTotals,
  type EstimatedUsd,
  type TaskCostRecord,
} from './cost.js';
