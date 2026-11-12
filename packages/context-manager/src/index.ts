/**
 * @soot/context-manager
 *
 * Milestone 1: persisted execution state (SQLite via `node:sqlite`, under `SOOT_DATA_DIR`)
 * so an interrupted run resumes without re-running completed tasks. Per-task context
 * selection is a later milestone.
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
  type CreateRunInput,
  type OpenExecutionStoreOptions,
  type PersistedAttempt,
  type PersistedRun,
  type PersistedTaskState,
} from './execution-store.js';
