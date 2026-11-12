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
  STATE_DB_FILE,
  openExecutionStore,
  type AttemptSpend,
  type AttemptSpendLedger,
  type CreateRunInput,
  type ModelOutcome,
  type OpenExecutionStoreOptions,
  type PersistedAttempt,
  type PersistedRun,
  type PersistedTaskState,
} from './execution-store.js';
export {
  buildAgentContext,
  fenceUntrusted,
  renderAgentContext,
  scanForInjection,
  type AgentContextInput,
  type AgentContextPacket,
  type ContextPermissions,
  type InjectionFlag,
  type UntrustedBlock,
} from './untrusted.js';
