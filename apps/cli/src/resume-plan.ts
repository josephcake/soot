import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  latestAttempt,
  type ConfigChange,
  type PersistedAttempt,
  type PersistedRun,
  type PersistedVerification,
} from '@soot/context-manager';

/*
 * What `soot resume` does with each task of an earlier run (ADR-054). Pure functions over the
 * persisted state, so the rules are tested (and mutation-checked) without a repository.
 *
 *   done (succeeded, with soot's persisted verdict)      → keep: not re-run, integrated again
 *   pending, interrupted mid-attempt, waiting to retry,
 *   cancelled because the run stopped, skipped           → rerun: a new attempt on a fresh worktree
 *   blocked (sign-in, approval, missing input), budget,
 *   escalation exhausted                                 → hold, unless --retry-blocked
 *   cancelled by a person (soot stop --task)             → hold (stays cancelled)
 */

export type ResumeAction = 'keep' | 'rerun' | 'hold';

export type HoldReason =
  'sign-in' | 'approval' | 'blocked' | 'budget' | 'escalation' | 'cancelled-by-user';

export interface TaskResumeDecision {
  readonly taskId: string;
  /** The task's persisted state before this resume (`pending` when it never started). */
  readonly previous: string;
  /** Attempt that state belongs to (`null` when it never started). */
  readonly attempt: number | null;
  readonly action: ResumeAction;
  /** Why a held task is held, or why a re-run task was held before `--retry-blocked`. */
  readonly hold: HoldReason | null;
  readonly reason: string;
}

export interface ResumePlanInput {
  readonly run: PersistedRun;
  /** soot's persisted verdicts for the run (`task_verifications`). */
  readonly verifications: readonly PersistedVerification[];
  /** Tasks a person cancelled with `soot stop <run> --task <id>`. */
  readonly cancelledByUser: ReadonlySet<string>;
  /** Tasks whose `running` attempt was just closed as interrupted (stale lease reclaimed). */
  readonly interrupted: ReadonlySet<string>;
  /** `--retry-blocked`: the person says the block is resolved; held tasks run again. */
  readonly retryBlocked: boolean;
}

/** Why a failed task stopped, from its last attempt (failure kind, review reason, summary). */
export function holdReasonOf(a: PersistedAttempt): Exclude<HoldReason, 'cancelled-by-user'> {
  const text = [a.error, a.failure?.message, a.result?.summary].filter(Boolean).join(' ');
  const blocked = a.failure?.kind === 'blocked' || a.result?.status === 'blocked';
  if (blocked) {
    if (/sign[ -]?in|auth[_ -]required|log ?in/i.test(text)) return 'sign-in';
    if (/approval|refused/i.test(text)) return 'approval';
    return 'blocked';
  }
  if (/budget/i.test(a.error ?? '')) return 'budget';
  return 'escalation';
}

const HOLD_TEXT: Readonly<Record<HoldReason, string>> = {
  'sign-in': 'blocked on a harness sign-in (soot never signs in; sign in yourself)',
  approval: 'blocked on an approval that was refused or unavailable',
  blocked: 'the agent reported it is blocked on missing or ambiguous input',
  budget: 'stopped by the task or run budget',
  escalation: 'retries and escalation were exhausted',
  'cancelled-by-user': 'cancelled by request (soot stop --task)',
};

export function planResume(input: ResumePlanInput): TaskResumeDecision[] {
  const { run } = input;
  const verified = new Map<string, PersistedVerification>();
  for (const v of input.verifications) verified.set(`${v.taskId}#${String(v.attempt)}`, v);
  return run.tasks.map((task): TaskResumeDecision => {
    const last = latestAttempt(run.attempts, task.id);
    const base = {
      taskId: task.id,
      attempt: last === undefined || last.attempt === 0 ? null : last.attempt,
    };
    if (last === undefined) {
      return { ...base, previous: 'pending', action: 'rerun', hold: null, reason: 'never started' };
    }
    const previous = last.state;
    switch (last.state) {
      case 'succeeded': {
        const v = verified.get(`${task.id}#${String(last.attempt)}`);
        if (last.result !== null && v !== undefined) {
          return {
            ...base,
            previous,
            action: 'keep',
            hold: null,
            reason: `done in attempt ${String(last.attempt)} (${v.verdict}${v.commit === null ? '' : ` at ${v.commit.slice(0, 12)}`}); not re-run`,
          };
        }
        return {
          ...base,
          previous,
          action: 'rerun',
          hold: null,
          reason:
            'succeeded, but soot has no persisted verdict for it (the run predates resume support); it runs again',
        };
      }
      case 'running':
      case 'interrupted':
        return {
          ...base,
          previous,
          action: 'rerun',
          hold: null,
          reason: input.interrupted.has(task.id)
            ? `attempt ${String(last.attempt)} was running when its process died; stale lease reclaimed, it runs again on a fresh worktree`
            : `attempt ${String(last.attempt)} was interrupted; it runs again on a fresh worktree`,
        };
      case 'retried':
        return {
          ...base,
          previous,
          action: 'rerun',
          hold: null,
          reason: `was waiting to retry after attempt ${String(last.attempt)}; the retry runs now`,
        };
      case 'skipped':
        return {
          ...base,
          previous,
          action: 'rerun',
          hold: null,
          reason: 'was skipped because a prerequisite did not succeed; re-evaluated',
        };
      case 'cancelled': {
        if (input.cancelledByUser.has(task.id)) {
          return {
            ...base,
            previous,
            action: 'hold',
            hold: 'cancelled-by-user',
            reason: HOLD_TEXT['cancelled-by-user'],
          };
        }
        return {
          ...base,
          previous,
          action: 'rerun',
          hold: null,
          reason: 'was cancelled when the run stopped; it runs again',
        };
      }
      case 'failed': {
        const hold = holdReasonOf(last);
        if (input.retryBlocked) {
          return {
            ...base,
            previous,
            action: 'rerun',
            hold,
            reason: `${HOLD_TEXT[hold]}; runs again because --retry-blocked was given`,
          };
        }
        return {
          ...base,
          previous,
          action: 'hold',
          hold,
          reason: `${HOLD_TEXT[hold]}; stays as it is (pass --retry-blocked once it is resolved)`,
        };
      }
    }
  });
}

/** Hash of a file's bytes (`none` when there is no such file in the config, `missing` when gone). */
export function fileHash(path: string | null): string {
  if (path === null) return 'none';
  if (!existsSync(path)) return 'missing';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Parts of two fingerprints that differ, in a stable order. */
export function fingerprintChanges(
  before: Readonly<Record<string, string>> | null,
  after: Readonly<Record<string, string>>,
): ConfigChange[] {
  if (before === null) {
    return [
      {
        part: 'fingerprint',
        before: null,
        after: 'not recorded: the run predates resume support, so changes cannot be detected',
      },
    ];
  }
  const parts = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return parts
    .filter((p) => before[p] !== after[p])
    .map((p) => ({ part: p, before: before[p] ?? null, after: after[p] ?? null }));
}
