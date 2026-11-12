import type { AgentResultStatus, Complexity } from '@soot/task-graph';

/*
 * Historical success per model and reliability tier (M3-04, spec §5: "use historical
 * performance data"). In memory for Milestone 3; the source records are the attempts that the
 * runtime already stores (model ref + status). Persisted aggregation is debt (ADR-023).
 */

export interface SuccessStats {
  readonly successes: number;
  readonly attempts: number;
}

export interface SuccessHistory {
  stats(modelRef: string, tier: Complexity): SuccessStats;
}

export class InMemorySuccessHistory implements SuccessHistory {
  readonly #counts = new Map<string, { successes: number; attempts: number }>();

  record(modelRef: string, tier: Complexity, succeeded: boolean): void {
    const key = `${modelRef}\u0000${tier}`;
    const current = this.#counts.get(key) ?? { successes: 0, attempts: 0 };
    this.#counts.set(key, {
      successes: current.successes + (succeeded ? 1 : 0),
      attempts: current.attempts + 1,
    });
  }

  stats(modelRef: string, tier: Complexity): SuccessStats {
    return this.#counts.get(`${modelRef}\u0000${tier}`) ?? { successes: 0, attempts: 0 };
  }
}

/** Build history from finished attempts (e.g. `AttemptActual` records plus the task's tier). */
export function historyFromAttempts(
  attempts: Iterable<{
    readonly model: string | null;
    readonly tier: Complexity;
    readonly status: AgentResultStatus;
  }>,
): InMemorySuccessHistory {
  const history = new InMemorySuccessHistory();
  for (const a of attempts) {
    // Only succeeded/failed say something about the model. Cancelled and blocked attempts
    // (stopped by the caller, or waiting on missing input) are not counted; nor are unknown models.
    if (a.model === null || (a.status !== 'succeeded' && a.status !== 'failed')) continue;
    history.record(a.model, a.tier, a.status === 'succeeded');
  }
  return history;
}

export type ReliabilitySource = 'prior' | 'history' | 'prior+history' | 'unknown';

export interface ReliabilityEstimate {
  /** Estimated probability of success, or `null` when unknown. */
  readonly value: number | null;
  readonly source: ReliabilitySource;
  readonly prior: number | null;
  readonly samples: number;
}

/**
 * Blend a configured prior with measured history: (prior·k + successes) / (k + attempts).
 * Without a prior, history alone counts once it has `minSamples` attempts. Otherwise unknown.
 */
export function estimateReliability(
  prior: number | null,
  stats: SuccessStats,
  priorWeight: number,
  minSamples: number,
): ReliabilityEstimate {
  const { successes, attempts } = stats;
  if (prior !== null) {
    return {
      value: (prior * priorWeight + successes) / (priorWeight + attempts),
      source: attempts > 0 ? 'prior+history' : 'prior',
      prior,
      samples: attempts,
    };
  }
  if (attempts >= minSamples) {
    return { value: successes / attempts, source: 'history', prior, samples: attempts };
  }
  return { value: null, source: 'unknown', prior, samples: attempts };
}
