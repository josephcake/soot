/**
 * @soot/integrations
 *
 * Milestone 5: codebase integration and safety on real git repositories — one worktree per
 * task from a pinned base, write-scope leases, soot-run validation against the actual diff,
 * serial merge-tree integration, approval-gated update of the user's working tree, honest
 * consolidated reports, and an audit log.
 */

export const PACKAGE_NAME = '@soot/integrations';

/** `partial`: the Milestone 5 scope is implemented; harness runners come later. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 5;

export { GitError, git, type GitOptions, type GitResult } from './git.js';
export {
  DirtyWorkingTreeError,
  Repository,
  SOOT_IDENTITY,
  type FileChange,
  type FileStatus,
  type GitIdentity,
  type MergeTreeResult,
  type RepositoryOptions,
  type Worktree,
} from './repository.js';
export {
  WriteLeases,
  findDiffOverlaps,
  withinScope,
  type DiffOverlap,
  type LeaseResult,
  type TaskDiff,
} from './scope.js';
export {
  EditRejectedError,
  MAX_EDITS,
  MAX_EDIT_BYTES,
  applyStructuredEdits,
  type StructuredEdit,
} from './edits.js';
export {
  checkCommand,
  runCheck,
  scrubbedEnv,
  type CheckCommand,
  type CheckEvidence,
  type CheckKind,
  type CheckStatus,
  type CommandDecision,
  type CommandPolicy,
  type RunCheckOptions,
} from './commands.js';
export {
  IsolatedTaskRunner,
  type IsolatedRunnerOptions,
  type TaskVerification,
  type Verdict,
} from './runner.js';
export {
  integrateSerially,
  type IntegrationCandidate,
  type IntegrationResult,
  type IntegrationStep,
} from './integrate.js';
export {
  buildConsolidatedReport,
  renderConsolidatedReport,
  type ConsolidatedReport,
  type IntegrationState,
  type ReportInput,
  type TaskReport,
  type WorkingTreeUpdate,
} from './report.js';
export {
  auditLogPath,
  runCodebaseWorkflow,
  type CodebaseRunResult,
  type CodebaseWorkflowOptions,
  type OutcomeSink,
} from './workflow.js';
