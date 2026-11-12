import type { AttemptRecord } from '@soot/agent-runtime';
import type { Task } from '@soot/task-graph';
import type { EscalationConfig } from './config.js';

/*
 * M4-01: escalation trigger detection, and the pure "what next?" decision for a finished
 * attempt. Pure so that it gives the same answer when replayed from persisted history after
 * a restart (the supervisor calls it from both `review` and `plan`).
 */

export type TriggerKind =
  | 'repeated-failure'
  | 'unexpected-complexity'
  | 'unmet-criteria'
  | 'low-confidence'
  | 'tool-errors'
  | 'token-blowup'
  | 'invalid-output'
  | 'crash';

export interface Trigger {
  readonly kind: TriggerKind;
  readonly detail: string;
}

export type NextStep =
  | { readonly type: 'accept' }
  | { readonly type: 'retry-same'; readonly delayMs: number; readonly note: string }
  | { readonly type: 'fallback'; readonly provider: string | null; readonly note: string }
  | { readonly type: 'escalate'; readonly triggers: readonly Trigger[]; readonly note: string }
  | { readonly type: 'fail'; readonly reason: string };

const providerOf = (model: string | null | undefined) =>
  model == null ? null : (model.split('/')[0] ?? null);

/** Triggers visible in one attempt (agent self-report and usage), whatever its status. */
export function detectTriggers(
  record: AttemptRecord,
  task: Task,
  config: EscalationConfig,
): Trigger[] {
  const triggers: Trigger[] = [];
  const result = record.result;
  const signals = result?.signals;
  if (signals?.complexity === 'higher') {
    triggers.push({
      kind: 'unexpected-complexity',
      detail: 'agent reported higher complexity than planned',
    });
  }
  if (signals?.unmetCriteria !== undefined && signals.unmetCriteria.length > 0) {
    triggers.push({
      kind: 'unmet-criteria',
      detail: `unmet acceptance criteria: ${signals.unmetCriteria.join('; ')}`,
    });
  }
  if (signals?.confidence !== undefined && signals.confidence < config.minConfidence) {
    triggers.push({
      kind: 'low-confidence',
      detail: `confidence ${signals.confidence.toFixed(2)} < ${config.minConfidence.toFixed(2)}`,
    });
  }
  if (signals?.toolErrors !== undefined && signals.toolErrors >= config.toolErrorLimit) {
    triggers.push({
      kind: 'tool-errors',
      detail: `${signals.toolErrors} tool errors (limit ${config.toolErrorLimit})`,
    });
  }
  if (result !== null) {
    const planned = task.estimate.inputTokens + task.estimate.outputTokens;
    const used = result.usage.inputTokens + result.usage.outputTokens;
    if (planned > 0 && used > planned * config.tokenBlowupFactor) {
      triggers.push({
        kind: 'token-blowup',
        detail: `${used} tokens used vs ${planned} planned (> ${config.tokenBlowupFactor}×)`,
      });
    }
  }
  if (record.failure?.kind === 'invalid-output') {
    triggers.push({ kind: 'invalid-output', detail: record.failure.message });
  }
  if (record.failure?.kind === 'crash')
    triggers.push({ kind: 'crash', detail: record.failure.message });
  return triggers;
}

export const escalationLevel = (record: AttemptRecord | undefined) =>
  record?.assignment?.escalationLevel ?? 0;

/** Consecutive most-recent attempts (including `record`) on the same model. */
function sameModelStreak(record: AttemptRecord, earlier: readonly AttemptRecord[]): number {
  const model = record.assignment?.model ?? null;
  let n = 1;
  for (let i = earlier.length - 1; i >= 0; i--) {
    if ((earlier[i]?.assignment?.model ?? null) !== model) break;
    n++;
  }
  return n;
}

export function backoffDelay(
  config: EscalationConfig,
  retryNumber: number,
  retryAfterMs: number | null,
): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, config.backoff.maxDelayMs);
  return Math.min(
    config.backoff.baseDelayMs * 2 ** Math.max(0, retryNumber - 1),
    config.backoff.maxDelayMs,
  );
}

const ESCALATING: ReadonlySet<TriggerKind> = new Set([
  'unexpected-complexity',
  'unmet-criteria',
  'low-confidence',
  'tool-errors',
  'token-blowup',
]);

/** Decide what follows `record`, given the attempts before it. Applies all loop bounds. */
export function nextStep(
  task: Task,
  record: AttemptRecord,
  earlier: readonly AttemptRecord[],
  config: EscalationConfig,
): NextStep {
  const triggers = detectTriggers(record, task, config);
  const streak = sameModelStreak(record, earlier);
  let step: NextStep;

  // A succeeded result the review did not accept is recorded as `rejected`; replaying it (on
  // plan, or after a restart) must reach the same decision as the review did.
  const reviewable = record.failure?.kind === 'rejected' && record.result?.status === 'succeeded';
  const failure = reviewable ? null : record.failure;
  if (failure === null) {
    const blocking = triggers.filter(
      (t) => t.kind === 'low-confidence' || t.kind === 'unmet-criteria',
    );
    if (blocking.length === 0) return { type: 'accept' };
    step = {
      type: 'escalate',
      triggers: blocking,
      note: `escalate: success not accepted (${blocking.map((t) => t.detail).join('; ')})`,
    };
  } else {
    switch (failure.kind) {
      case 'blocked':
        return {
          type: 'fail',
          reason: 'agent is blocked on missing or ambiguous input; another model would not help',
        };
      case 'cancelled':
      case 'rejected':
        return { type: 'fail', reason: failure.message };
      case 'rate-limited':
      case 'timeout': {
        if (streak <= config.transientRetries) {
          step = {
            type: 'retry-same',
            delayMs: backoffDelay(config, streak, failure.retryAfterMs),
            note: `retry same model after ${failure.kind} (${streak}/${config.transientRetries})`,
          };
        } else {
          step = {
            type: 'fallback',
            provider: failure.provider ?? providerOf(record.assignment?.model),
            note: `fall back to another provider: ${failure.kind} persisted after ${config.transientRetries} retries`,
          };
        }
        break;
      }
      case 'unavailable':
      case 'auth':
        step = {
          type: 'fallback',
          provider: failure.provider ?? providerOf(record.assignment?.model),
          note: `fall back to another provider: ${failure.kind === 'auth' ? 'authentication failed' : 'provider outage'}`,
        };
        break;
      case 'invalid-output':
      case 'crash':
      case 'reported-failure': {
        const strong = triggers.filter((t) => ESCALATING.has(t.kind));
        if (strong.length > 0) {
          step = {
            type: 'escalate',
            triggers: strong,
            note: `escalate: ${strong.map((t) => t.detail).join('; ')}`,
          };
        } else if (streak <= config.sameModelRetries) {
          step = {
            type: 'retry-same',
            delayMs: 0,
            note: `retry same model after ${failure.kind} (${streak}/${config.sameModelRetries})`,
          };
        } else {
          const repeated: Trigger = {
            kind: 'repeated-failure',
            detail: `${streak} unsuccessful attempts on ${record.assignment?.model ?? 'the same model'}`,
          };
          step = {
            type: 'escalate',
            triggers: [...triggers, repeated],
            note: `escalate: ${repeated.detail}`,
          };
        }
        break;
      }
    }
  }

  const attempts = earlier.length + 1;
  if (attempts >= config.maxAttemptsPerTask) {
    return {
      type: 'fail',
      reason: `attempt limit reached (${attempts}/${config.maxAttemptsPerTask}); last: ${failure?.message ?? step.type}`,
    };
  }
  if (step.type === 'escalate' && escalationLevel(record) >= config.maxEscalationsPerTask) {
    return {
      type: 'fail',
      reason: `escalation limit reached (${config.maxEscalationsPerTask}); last: ${step.note}`,
    };
  }
  return step;
}
