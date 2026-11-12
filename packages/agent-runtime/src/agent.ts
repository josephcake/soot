import type { AgentResult, Task } from '@soot/task-graph';
import type { Assignment, PriorAttempt } from './attempts.js';

/**
 * What an agent receives for one attempt: its task (instructions, acceptance criteria,
 * declared files), the structured results of its prerequisites, its model assignment, and
 * the structured findings of earlier attempts of the same task (context transfer, M4-02).
 * It deliberately does NOT receive the original prompt or any transcripts (build spec §7, §10).
 */
export interface AgentTaskInput {
  readonly task: Task;
  readonly attempt: number;
  readonly dependencyResults: readonly AgentResult[];
  /** Model chosen for this attempt; absent when no supervisor assigns models. */
  readonly assignment?: Assignment | null;
  /** Earlier attempts of this task, oldest first. */
  readonly priorAttempts?: readonly PriorAttempt[];
}

/**
 * Executes one task attempt. Real runners (model-backed, harness-backed) arrive in later
 * milestones; Milestones 1–4 ship only `MockAgentRunner`.
 *
 * The return value is `unknown` on purpose: the scheduler validates it against
 * `AgentResultSchema` and treats anything invalid as a failed attempt.
 * Implementations should stop work promptly when `signal` aborts.
 */
export interface AgentRunner {
  readonly kind: string;
  run(input: AgentTaskInput, signal: AbortSignal): Promise<unknown>;
}

/** Monotonic milliseconds. Injected so tests can reason about ordering. */
export type Clock = () => number;

export const monotonicClock: Clock = () => performance.now();
