import type { EstimatedUsd } from './cost.js';

/*
 * Routing explanation log (M3-05). One entry per routing decision: which model was chosen for
 * which task, why, and how every candidate fared. Costs here are ESTIMATES (branded
 * `EstimatedUsd`); actual spend lives in `TaskCostRecord` attempts and never in this log.
 * No UI (ADR-009): entries are plain data, readable text, and JSON Lines.
 */

export interface RoutingCandidateLine {
  readonly ref: string;
  /** `selected`, `eligible` (qualified but not chosen), `below-threshold`, or `excluded`. */
  readonly outcome: 'selected' | 'eligible' | 'below-threshold' | 'excluded';
  readonly estimatedCostUsd: EstimatedUsd | null;
  readonly reliability: number | null;
  /** Short human-readable explanation, e.g. `missing capability: vision`. */
  readonly detail: string;
}

export interface RoutingLogEntry {
  /** ISO timestamp of the decision. */
  readonly at: string;
  readonly runId: string | null;
  readonly taskId: string;
  readonly policy: string;
  readonly status: 'routed' | 'unroutable';
  readonly selected: string | null;
  /** One readable sentence explaining the decision. */
  readonly reason: string;
  readonly candidates: readonly RoutingCandidateLine[];
}

export class RoutingLog {
  readonly #entries: RoutingLogEntry[] = [];

  append(entry: RoutingLogEntry): void {
    if (entry.reason.trim() === '') throw new Error('a routing decision needs a reason');
    this.#entries.push(
      Object.freeze({ ...entry, candidates: Object.freeze([...entry.candidates]) }),
    );
  }

  entries(
    filter: { readonly taskId?: string; readonly runId?: string } = {},
  ): readonly RoutingLogEntry[] {
    return this.#entries.filter(
      (e) =>
        (filter.taskId === undefined || e.taskId === filter.taskId) &&
        (filter.runId === undefined || e.runId === filter.runId),
    );
  }

  /** JSON Lines, one decision per line. */
  toJSONL(): string {
    return this.#entries.map((e) => JSON.stringify(e)).join('\n');
  }
}

const usd = (v: EstimatedUsd | null) => (v === null ? 'cost unknown' : `est. $${v.toFixed(6)}`);
const pct = (v: number | null) => (v === null ? 'reliability unknown' : `p≈${v.toFixed(2)}`);

/** Readable multi-line rendering of one decision. */
export function formatRoutingEntry(entry: RoutingLogEntry): string {
  const head = `[${entry.policy}] ${entry.taskId} → ${entry.selected ?? 'UNROUTABLE'}: ${entry.reason}`;
  const lines = entry.candidates.map(
    (c) =>
      `  ${c.outcome.padEnd(15)} ${c.ref} (${usd(c.estimatedCostUsd)}, ${pct(c.reliability)}) ${c.detail}`,
  );
  return [head, ...lines].join('\n');
}
