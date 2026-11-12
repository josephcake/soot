import type { AgentResult, Complexity, Finding, Task } from '@soot/task-graph';

/*
 * Attempt-level vocabulary for adaptive execution (Milestone 4). The scheduler owns the
 * mechanics (timeouts, backoff timers, cancellation, journaling); an `AttemptSupervisor`
 * (e.g. @soot/escalation) owns the decisions (which model, retry or not, escalate, stop).
 */

export const FAILURE_KINDS = [
  /** The agent returned a valid result with status `failed`. */
  'reported-failure',
  /** The agent returned `blocked` (missing input); another model will not fix it. */
  'blocked',
  /** The agent returned `cancelled`. */
  'cancelled',
  /** The agent threw an unclassified error. */
  'crash',
  /** The attempt exceeded its time limit, or the provider timed out. */
  'timeout',
  'rate-limited',
  /** Provider outage / overload. */
  'unavailable',
  'auth',
  /** The agent's output failed the result contract or structured-output validation. */
  'invalid-output',
  /** A valid `succeeded` result the supervisor did not accept (e.g. low confidence). */
  'rejected',
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface AttemptFailure {
  readonly kind: FailureKind;
  readonly message: string;
  /** Provider that failed, when the error says so. */
  readonly provider: string | null;
  /** Provider-requested wait, when known. */
  readonly retryAfterMs: number | null;
}

/** Which model an attempt runs on and why. */
export interface Assignment {
  /** Model ref (`provider/modelId`), or `null` when the runner does not use one (mocks). */
  readonly model: string | null;
  readonly reason: string;
  /** 0 for the initial assignment; +1 for every escalation. */
  readonly escalationLevel: number;
  /** Estimated cost of this attempt in USD (`null` = unknown). Never an actual. */
  readonly estimatedCostUsd: number | null;
  /** Complexity tier the model was routed at (Milestone 5 outcome feedback), when known. */
  readonly tier?: Complexity;
}

export type ReviewDecision =
  | { readonly action: 'accept' }
  | { readonly action: 'retry'; readonly delayMs: number; readonly note: string }
  | { readonly action: 'fail'; readonly reason: string };

export type PlanDecision =
  | { readonly action: 'run'; readonly assignment: Assignment }
  | { readonly action: 'stop'; readonly reason: string };

/** Everything known about one finished attempt. */
export interface AttemptRecord {
  readonly taskId: string;
  readonly attempt: number;
  readonly assignment: Assignment | null;
  /** The validated result, if the agent returned one. */
  readonly result: AgentResult | null;
  /** `null` only for an accepted success. */
  readonly failure: AttemptFailure | null;
  readonly review: ReviewDecision | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

/**
 * Context transferred to the next attempt (M4-02): structured findings only, never
 * transcripts. Lets an escalated model continue from what earlier attempts learned.
 */
export interface PriorAttempt {
  readonly attempt: number;
  readonly model: string | null;
  readonly outcome: FailureKind;
  readonly summary: string | null;
  readonly findings: readonly Finding[];
  readonly failure: string;
  /** Why the supervisor moved on (e.g. "escalated: agent reported higher complexity"). */
  readonly note: string | null;
}

export function toPriorAttempt(record: AttemptRecord): PriorAttempt {
  return {
    attempt: record.attempt,
    model: record.assignment?.model ?? record.result?.usage.model ?? null,
    outcome: record.failure?.kind ?? 'rejected',
    summary: record.result?.summary ?? null,
    findings: record.result?.findings ?? [],
    failure: record.failure?.message ?? 'not accepted',
    note: record.review?.action === 'retry' ? record.review.note : null,
  };
}

export interface PlanContext {
  readonly task: Task;
  readonly attempt: number;
  /** Earlier attempts of this task (including ones from previous runs), oldest first. */
  readonly history: readonly AttemptRecord[];
  readonly dependencyResults: readonly AgentResult[];
}

export interface ReviewContext {
  readonly task: Task;
  /** The attempt just finished (its `review` is still `null`). */
  readonly record: AttemptRecord;
  /** Earlier attempts, oldest first, NOT including `record`. */
  readonly history: readonly AttemptRecord[];
}

export interface AttemptSupervisor {
  plan(ctx: PlanContext): PlanDecision;
  review(ctx: ReviewContext): ReviewDecision;
}

/** Milestone 1 behaviour: one attempt, accept success, fail otherwise. */
export const SINGLE_ATTEMPT: AttemptSupervisor = {
  plan: () => ({
    action: 'run',
    assignment: {
      model: null,
      reason: 'single attempt (no supervisor)',
      escalationLevel: 0,
      estimatedCostUsd: null,
    },
  }),
  review: ({ record }) =>
    record.failure === null
      ? { action: 'accept' }
      : { action: 'fail', reason: record.failure.message },
};

const PROVIDER_KINDS: ReadonlySet<string> = new Set([
  'rate-limited',
  'unavailable',
  'timeout',
  'auth',
  'invalid-output',
]);

/**
 * Classify a thrown error. Provider errors (e.g. `ProviderError` from
 * @soot/provider-adapters) are recognised structurally by their `kind`, `provider`, and
 * `retryAfterMs` fields, so this package does not depend on any provider code.
 */
export function classifyError(error: unknown): AttemptFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof error === 'object' && error !== null) {
    const e = error as { kind?: unknown; provider?: unknown; retryAfterMs?: unknown };
    if (typeof e.kind === 'string' && PROVIDER_KINDS.has(e.kind)) {
      return {
        kind: e.kind as FailureKind,
        message: `provider error (${e.kind}): ${message}`,
        provider: typeof e.provider === 'string' ? e.provider : null,
        retryAfterMs: typeof e.retryAfterMs === 'number' ? e.retryAfterMs : null,
      };
    }
  }
  return { kind: 'crash', message: `agent error: ${message}`, provider: null, retryAfterMs: null };
}
