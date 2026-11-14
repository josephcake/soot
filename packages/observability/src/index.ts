/**
 * @soot/observability
 *
 * Milestone 1: per-task usage/cost records that keep planner estimates and reported actuals
 * strictly separate. Milestone 3: the routing explanation log. Milestone 5: the audit log and
 * the per-task / total cost report. No dashboard or UI (ADR-009).
 */

export const PACKAGE_NAME = '@soot/observability';

/** `partial`: the Milestone 1 scope is implemented; later milestones extend it. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 1;

export {
  actualUsd,
  costRecordsFromAttempts,
  createCostRecord,
  estimatedUsd,
  recordAttempt,
  recordRoutedEstimate,
  summarizeCosts,
  taskActualTotals,
  type ActualTotals,
  type ActualUsd,
  type AttemptActual,
  type AttemptCostInput,
  type CostEstimate,
  type RoutedEstimate,
  type RoutedEstimateInput,
  type RoutedEstimateTotals,
  type CostSummary,
  type EstimateTotals,
  type EstimatedUsd,
  type TaskCostRecord,
} from './cost.js';
export {
  RoutingLog,
  formatRoutingEntry,
  type RoutingCandidateLine,
  type RoutingLogEntry,
} from './routing-log.js';
export {
  AUDIT_EVENT_TYPES,
  AuditLog,
  redactSecrets,
  type AuditEntry,
  type AuditEventType,
  type AuditLogOptions,
  type AuditValue,
} from './audit.js';
export {
  buildCostReport,
  renderCostReport,
  type CostAttemptInput,
  type CostAttemptLine,
  type CostReport,
  type CostSide,
  type CostTaskInput,
  type ModelCostLine,
  type PlanningCostInput,
  type PlanningCostLine,
  type TaskCostLine,
} from './cost-report.js';
