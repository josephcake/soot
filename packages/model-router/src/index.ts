/**
 * @soot/model-router
 *
 * Milestone 3: task-level model routing. Each task is evaluated (complexity, mandatory
 * capabilities), filtered against the registry, priced from registry list prices (estimates
 * only), scored for reliability from configured priors and recorded history, and assigned the
 * best model that meets the policy's threshold. Every decision is explained. Heuristic
 * evaluation for now (ADR-023); no model is called by the router.
 */

export const PACKAGE_NAME = '@soot/model-router';

/** `partial`: the Milestone 3 scope is implemented; adaptive re-routing is Milestone 4. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 3;

export {
  DEFAULT_BASE_CAPABILITIES,
  DEFAULT_CAPABILITY_RULES,
  evaluateTask,
  type CapabilityRule,
  type EvaluationOptions,
  type TaskProfile,
} from './evaluate.js';
export {
  BALANCED,
  BUILT_IN_POLICIES,
  ECONOMY,
  QUALITY,
  ROUTING_OBJECTIVES,
  RoutingPolicySchema,
  customPolicy,
  resolvePolicy,
  type BuiltInPolicyName,
  type CustomPolicyInput,
  type RoutingObjective,
  type RoutingPolicy,
} from './policy.js';
export {
  InMemorySuccessHistory,
  estimateReliability,
  historyFromAttempts,
  type ReliabilityEstimate,
  type ReliabilitySource,
  type SuccessHistory,
  type SuccessStats,
} from './history.js';
export {
  routeTask,
  routeTasks,
  toLogEntry,
  type CandidateAssessment,
  type CostEstimateForTask,
  type RouteContext,
  type RouterExclusion,
  type RoutingDecision,
} from './router.js';
