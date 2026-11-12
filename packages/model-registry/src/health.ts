/*
 * Provider availability with cooldowns. A provider that fails with an outage, a rate limit
 * after retries, or an auth error is marked unavailable until its cooldown passes, so
 * selection and fallback skip it. With a `ProviderHealthStore` (e.g. `soot.sqlite`, ADR-030),
 * timed cooldowns survive a restart: a restarted run still skips a provider that was down
 * until its cooldown ends. Session-long marks (auth, not configured) are not persisted: they
 * end with the process, so fixing a key and restarting is enough.
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

/** A persisted timed cooldown. `until` is epoch ms. */
export interface PersistedProviderCooldown {
  readonly provider: string;
  readonly reason: UnavailableReason;
  readonly until: number;
  readonly detail: string | null;
}

/** Where timed cooldowns are kept across restarts. */
export interface ProviderHealthStore {
  /** Cooldowns still in force at `now` (epoch ms). */
  providerCooldowns(now: number): PersistedProviderCooldown[];
  saveProviderCooldown(cooldown: PersistedProviderCooldown): void;
  clearProviderCooldown(provider: string): void;
}

export interface ProviderHealthOptions {
  readonly now?: () => number;
  readonly store?: ProviderHealthStore;
}

export class ProviderHealth {
  readonly #now: () => number;
  readonly #store: ProviderHealthStore | null;
  readonly #state = new Map<
    string,
    { reason: UnavailableReason; until: number; detail: string | null }
  >();

  /** `new ProviderHealth()`, `new ProviderHealth(clock)` or `new ProviderHealth({ now, store })`. */
  constructor(options: (() => number) | ProviderHealthOptions = {}) {
    const o = typeof options === 'function' ? { now: options } : options;
    this.#now = o.now ?? Date.now;
    this.#store = o.store ?? null;
    for (const c of this.#store?.providerCooldowns(this.#now()) ?? []) {
      this.#state.set(c.provider, { reason: c.reason, until: c.until, detail: c.detail });
    }
  }

  markUnavailable(
    provider: string,
    reason: UnavailableReason,
    options: { cooldownMs?: number; detail?: string } = {},
  ): void {
    const cooldown = options.cooldownMs ?? DEFAULT_COOLDOWN_MS[reason];
    const entry = { reason, until: this.#now() + cooldown, detail: options.detail ?? null };
    this.#state.set(provider, entry);
    if (Number.isFinite(entry.until)) this.#store?.saveProviderCooldown({ provider, ...entry });
    else this.#store?.clearProviderCooldown(provider);
  }

  markAvailable(provider: string): void {
    this.#state.delete(provider);
    this.#store?.clearProviderCooldown(provider);
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
