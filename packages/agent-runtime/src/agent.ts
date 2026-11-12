import type { AgentResult, Task } from '@soot/task-graph';

/**
 * What an agent receives for one attempt: its task (instructions, acceptance criteria,
 * declared files) and the structured results of its prerequisites. It deliberately does NOT
 * receive the original prompt or other agents' transcripts (build spec §7, §10).
 */
export interface AgentTaskInput {
  readonly task: Task;
  readonly attempt: number;
  readonly dependencyResults: readonly AgentResult[];
}

/**
 * Executes one task attempt. Real runners (model-backed, harness-backed) arrive in later
 * milestones; Milestone 1 ships only `MockAgentRunner`.
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
