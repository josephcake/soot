/**
 * @soot/context-manager
 *
 * Milestone 1: persisted execution state (SQLite via `node:sqlite`, under `SOOT_DATA_DIR`)
 * so an interrupted run resumes without re-running completed tasks. Milestone 4: attempt
 * history. Milestone 5: model outcome history (routing feedback) and untrusted-content
 * handling for agent context (fencing, injection flags, permissions from trusted input only).
 */

export const PACKAGE_NAME = '@soot/context-manager';

/** `partial`: the Milestone 1 scope is implemented; later milestones extend it. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 1;

export {
  ExecutionStore,
  SCHEMA_VERSION,
  STATE_DB_FILE,
  openExecutionStore,
  pidAlive,
  type BeginSessionInput,
  type BeginSessionResult,
  type ConfigChange,
  type PersistedVerification,
  type RunSession,
  type RunSessionKind,
  type AttemptSpend,
  type AttemptSpendLedger,
  type RunPlanningCost,
  type CommandRunRecord,
  type CreateRunInput,
  type ModelOutcome,
  type OpenExecutionStoreOptions,
  type PersistedAttempt,
  type PersistedRun,
  type PersistedTaskState,
} from './execution-store.js';
export {
  DEFAULT_RUN_LOCK_TTL_MS,
  latestAttempt,
  lockState,
  type LockCheck,
  type LockState,
  type RunLockRow,
} from './run-lock.js';
export {
  buildAgentContext,
  failedCheckLines,
  fenceUntrusted,
  latestRejectedChange,
  rejectedChangeHeader,
  rejectedChangeLines,
  renderAgentContext,
  scanForInjection,
  type AgentContextInput,
  type AgentContextPacket,
  type ContextPermissions,
  type InjectionFlag,
  type UntrustedBlock,
} from './untrusted.js';
