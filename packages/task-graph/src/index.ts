/**
 * @soot/task-graph
 *
 * Milestone 1: task and agent-result contracts (runtime validators + JSON Schema) and the
 * dependency graph (DAG build, cycle detection, topological layers, file-conflict
 * serialization, revision). The scheduler that executes a graph lives in @soot/agent-runtime.
 */

export const PACKAGE_NAME = '@soot/task-graph';

/** `partial`: the Milestone 1 scope is implemented; later milestones extend it. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 1;

export {
  ContractValidationError,
  RelativePathSchema,
  safeValidate,
  validateOrThrow,
  type ValidationIssue,
  type ValidationResult,
} from './validation.js';
export {
  COMPLEXITY_LEVELS,
  CapabilitySchema,
  ComplexitySchema,
  TaskEstimateSchema,
  TaskFilesSchema,
  TaskIdSchema,
  TaskSchema,
  parseTask,
  validateTask,
  type Complexity,
  type Task,
  type TaskEstimate,
  type TaskFiles,
} from './task.js';
export {
  AGENT_RESULT_STATUSES,
  AgentResultSchema,
  AgentResultStatusSchema,
  EvidenceSchema,
  FindingSchema,
  PatchRefSchema,
  RESULT_LIST_LIMIT,
  RESULT_TEXT_LIMIT,
  ReportedUsageSchema,
  parseAgentResult,
  validateAgentResult,
  type AgentResult,
  type AgentResultStatus,
  type Evidence,
  type Finding,
  type PatchRef,
  type ReportedUsage,
} from './result.js';
export {
  TaskGraphError,
  buildTaskGraph,
  fileConflict,
  pathsOverlap,
  readyTasks,
  reviseTaskGraph,
  type FileConflict,
  type GraphRevision,
  type ImplicitEdge,
  type TaskGraph,
  type TaskGraphErrorCode,
} from './graph.js';
export {
  AGENT_RESULT_JSON_SCHEMA_ID,
  TASK_JSON_SCHEMA_ID,
  agentResultJsonSchema,
  taskJsonSchema,
} from './json-schema.js';
