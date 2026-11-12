/*
 * Provider availability with cooldowns. A provider that fails with an outage, a rate limit
 * after retries, or an auth error is marked unavailable until its cooldown passes, so
 * selection and fallback skip it. In-memory for Milestone 2 (persisting cooldowns in SQLite is
 * tracked in TECHNICAL_DEBT.md).
 */

export type UnavailableReason = 'outage' | 'rate-limited' | 'auth' | 'not-configured' | 'timeout';

export interface ProviderStatus {
  readonly provider: string;
  readonly available: boolean;
  readonly reason: UnavailableReason | null;
  /** Epoch ms when the provider may be tried again; `null` when available. */
  readonly until: number | null;
  readonly detail: string | null;
}

export const DEFAULT_COOLDOWN_MS: Readonly<Record<UnavailableReason, number>> = {
  outage: 60_000,
  'rate-limited': 30_000,
  timeout: 30_000,
  // Auth and configuration problems do not fix themselves; keep them out for the session.
  auth: Number.POSITIVE_INFINITY,
  'not-configured': Number.POSITIVE_INFINITY,
};

export class ProviderHealth {
  readonly #now: () => number;
  readonly #state = new Map<
    string,
    { reason: UnavailableReason; until: number; detail: string | null }
  >();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  markUnavailable(
    provider: string,
    reason: UnavailableReason,
    options: { cooldownMs?: number; detail?: string } = {},
  ): void {
    const cooldown = options.cooldownMs ?? DEFAULT_COOLDOWN_MS[reason];
    this.#state.set(provider, {
      reason,
      until: this.#now() + cooldown,
      detail: options.detail ?? null,
    });
  }

  markAvailable(provider: string): void {
    this.#state.delete(provider);
  }

  status(provider: string): ProviderStatus {
    const entry = this.#state.get(provider);
    if (entry === undefined || entry.until <= this.#now()) {
      return { provider, available: true, reason: null, until: null, detail: null };
    }
    return {
      provider,
      available: false,
      reason: entry.reason,
      until: entry.until,
      detail: entry.detail,
    };
  }

  isAvailable(provider: string): boolean {
    return this.status(provider).available;
  }
}
