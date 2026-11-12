/**
 * @soot/agent-runtime
 *
 * Milestone 1: the `AgentRunner` interface, the graph `Scheduler` (bounded concurrency,
 * dependency ordering, cancellation, result validation, resume support), and
 * `MockAgentRunner`, a scripted TEST DOUBLE. Milestone 4: multi-attempt execution driven by an
 * `AttemptSupervisor` (retries, reassignment with context transfer, attempt timeouts, retry
 * backoff that cancellation clears). No real model or harness runner exists yet.
 */

export const PACKAGE_NAME = '@soot/agent-runtime';

/** `partial`: the Milestone 1 scope is implemented; later milestones extend it. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 1;

export { monotonicClock, type AgentRunner, type AgentTaskInput, type Clock } from './agent.js';
export {
  FAILURE_KINDS,
  SINGLE_ATTEMPT,
  classifyError,
  toPriorAttempt,
  type Assignment,
  type AttemptFailure,
  type AttemptRecord,
  type AttemptSupervisor,
  type FailureKind,
  type PlanContext,
  type PlanDecision,
  type PriorAttempt,
  type ReviewContext,
  type ReviewDecision,
} from './attempts.js';
export {
  MockAgentAbortError,
  MockProviderError,
  MockAgentRunner,
  type MockAgentRunnerOptions,
  type MockCall,
  type MockOutcome,
  type MockScript,
} from './mock-agent.js';
export {
  Scheduler,
  runTaskGraph,
  type ExecutionJournal,
  type RunReport,
  type SchedulerEvent,
  type SchedulerOptions,
  type TaskFinalState,
  type TaskOutcome,
} from './scheduler.js';
