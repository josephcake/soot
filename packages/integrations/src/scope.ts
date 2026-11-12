import { pathsOverlap } from '@soot/task-graph';
import type { FileChange } from './repository.js';

/*
 * Write-scope leases and diff checks (M5-01/M5-02, ADR-019). A task may only change paths in
 * its declared write set; while it runs, it holds a lease on that set, and no other task may
 * hold an overlapping one. Scope is checked against the ACTUAL diff, not the agent's claims.
 */

/** True when `path` (a file) is inside one of the declared scope entries. */
export function withinScope(path: string, scope: readonly string[]): boolean {
  return scope.some((entry) => pathsOverlap(path, entry));
}

export type LeaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly heldBy: string; readonly paths: readonly string[] };

export class WriteLeases {
  readonly #held = new Map<string, readonly string[]>();

  acquire(taskId: string, paths: readonly string[]): LeaseResult {
    for (const [holder, held] of this.#held) {
      if (holder === taskId) continue;
      const overlap = paths.filter((p) => held.some((h) => pathsOverlap(p, h)));
      if (overlap.length > 0) return { ok: false, heldBy: holder, paths: overlap };
    }
    this.#held.set(taskId, [...paths]);
    return { ok: true };
  }

  release(taskId: string): void {
    this.#held.delete(taskId);
  }

  held(): ReadonlyMap<string, readonly string[]> {
    return this.#held;
  }
}

export interface TaskDiff {
  readonly taskId: string;
  readonly files: readonly FileChange[];
}

export interface DiffOverlap {
  readonly first: string;
  readonly second: string;
  readonly paths: readonly string[];
}

/** Pairs of tasks whose actual diffs touch the same files (M5-02). */
export function findDiffOverlaps(diffs: readonly TaskDiff[]): DiffOverlap[] {
  const overlaps: DiffOverlap[] = [];
  for (let i = 0; i < diffs.length; i++) {
    for (let j = i + 1; j < diffs.length; j++) {
      const a = diffs[i];
      const b = diffs[j];
      if (a === undefined || b === undefined) continue;
      const right = new Set(b.files.map((f) => f.path));
      const paths = a.files.map((f) => f.path).filter((p) => right.has(p));
      if (paths.length > 0)
        overlaps.push({ first: a.taskId, second: b.taskId, paths: paths.sort() });
    }
  }
  return overlaps;
}
