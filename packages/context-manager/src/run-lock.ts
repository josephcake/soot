import type { PersistedAttempt } from './execution-store.js';

/*
 * Run-level lock and resume helpers (ADR-054). A run is owned by at most one soot process at a
 * time: the owner holds a row in `run_locks` (pid, host, random owner token) and refreshes its
 * heartbeat while it runs. A row left by a dead process is stale and may be taken over; a live
 * owner is never displaced. The decision is a pure function so the guards can be tested (and
 * mutated) directly.
 */

/** A row of `run_locks`. */
export interface RunLockRow {
  readonly runId: string;
  /** Random token of the owning process (one per session). */
  readonly owner: string;
  readonly pid: number;
  readonly host: string;
  readonly session: number;
  readonly acquiredAt: string;
  /** Last heartbeat, epoch ms. */
  readonly heartbeatMs: number;
}

export interface LockCheck {
  /** Epoch ms now. */
  readonly now: number;
  /** Heartbeats older than this mean the owner stopped refreshing its lease. */
  readonly ttlMs: number;
  /** Host name of the process asking. */
  readonly host: string;
  /** Whether a process with this pid exists on this host (signal 0 probe). */
  readonly isAlive: (pid: number) => boolean;
}

export type LockState =
  | { readonly state: 'free' }
  | { readonly state: 'live'; readonly holder: RunLockRow; readonly reason: string }
  | { readonly state: 'stale'; readonly holder: RunLockRow; readonly reason: string };

/** Default lease: an owner that has not refreshed its heartbeat for 2 minutes is stale. */
export const DEFAULT_RUN_LOCK_TTL_MS = 120_000;

/**
 * Whether a lock row still belongs to a live soot process.
 *
 * - Same host: live only while the pid exists AND the heartbeat is fresh. A dead pid is stale at
 *   once (the crash case). A pid that exists but stopped heartbeating for longer than the lease
 *   is treated as stale too: it is either a reused pid, or a frozen owner, which notices on its
 *   next heartbeat that it lost the lock and stops (see `heartbeatRunLock`).
 * - Other host (a shared state directory): the pid cannot be probed, so only the lease counts.
 */
export function lockState(row: RunLockRow | null, check: LockCheck): LockState {
  if (row === null) return { state: 'free' };
  const age = check.now - row.heartbeatMs;
  const fresh = age <= check.ttlMs;
  const ageText = `${String(Math.max(0, Math.round(age / 1000)))}s ago`;
  if (row.host === check.host) {
    if (!check.isAlive(row.pid)) {
      return {
        state: 'stale',
        holder: row,
        reason: `owner pid ${String(row.pid)} is not running (last heartbeat ${ageText})`,
      };
    }
    if (!fresh) {
      return {
        state: 'stale',
        holder: row,
        reason: `pid ${String(row.pid)} exists but its lease expired (last heartbeat ${ageText}, lease ${String(check.ttlMs)} ms); treating it as a reused pid`,
      };
    }
    return {
      state: 'live',
      holder: row,
      reason: `pid ${String(row.pid)} on this host holds it (heartbeat ${ageText})`,
    };
  }
  if (fresh) {
    return {
      state: 'live',
      holder: row,
      reason: `pid ${String(row.pid)} on host ${row.host} holds it (heartbeat ${ageText}; other hosts cannot be probed, so the lease decides)`,
    };
  }
  return {
    state: 'stale',
    holder: row,
    reason: `lease of pid ${String(row.pid)} on host ${row.host} expired (last heartbeat ${ageText})`,
  };
}

/**
 * The attempt row that describes a task's current state: the newest one. Attempt 0 rows
 * (cancelled or skipped before starting) can be written after numbered attempts when a resumed
 * run skips a task again, so recency, not the attempt number alone, decides.
 */
export function latestAttempt(
  attempts: readonly PersistedAttempt[],
  taskId: string,
): PersistedAttempt | undefined {
  const mine = attempts.filter((a) => a.taskId === taskId);
  const numbered = mine.filter((a) => a.attempt > 0).sort((a, b) => a.attempt - b.attempt);
  const last = numbered.at(-1);
  const zero = mine.find((a) => a.attempt === 0);
  if (zero === undefined) return last;
  if (last === undefined) return zero;
  const lastAt = last.finishedAt ?? last.startedAt ?? '';
  return (zero.finishedAt ?? '') >= lastAt ? zero : last;
}
