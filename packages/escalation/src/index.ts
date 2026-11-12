/**
 * @soot/escalation
 *
 * Milestone 4: adaptive execution decisions for the agent-runtime Scheduler. Detects
 * escalation triggers, reassigns tasks to stronger models with context transfer, falls back
 * across providers on outages and persistent rate limits, downgrades work after a plan, and
 * bounds retries, escalations, and spend. Verified with mock agents and a fictional registry.
 */

export const PACKAGE_NAME = '@soot/escalation';

/** `partial`: the Milestone 4 scope is implemented with mocks; real agents come later. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 4;

export {
  DEFAULT_ESCALATION_CONFIG,
  EscalationConfigSchema,
  escalationConfig,
  type EscalationConfig,
  type EscalationConfigInput,
} from './config.js';
export {
  backoffDelay,
  detectTriggers,
  escalationLevel,
  nextStep,
  type NextStep,
  type Trigger,
  type TriggerKind,
} from './decide.js';
export {
  AdaptiveSupervisor,
  type AdaptiveEvent,
  type AdaptiveEventType,
  type AdaptiveSupervisorOptions,
  type AttemptSpendEntry,
  type SpendLedger,
} from './supervisor.js';
