import { ProviderError } from './errors.js';

export interface RetryPolicy {
  /** Total attempts including the first. Default 3. */
  readonly maxAttempts: number;
  /** First backoff delay when the provider gives no retry-after. Default 500 ms. */
  readonly baseDelayMs: number;
  /** Cap for any single delay, including a provider's retry-after. Default 30 s. */
  readonly maxDelayMs: number;
  /** Injected for tests. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected for tests; returns [0, 1). */
  readonly random: () => number;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  sleep,
  random: Math.random,
};

/** Delay before retry number `retry` (1-based). Honors retry-after; else exponential + jitter. */
export function retryDelayMs(error: ProviderError, retry: number, policy: RetryPolicy): number {
  if (error.retryAfterMs !== null) return Math.min(error.retryAfterMs, policy.maxDelayMs);
  // Anthropic can return 429 without retry-after (research §6): back off exponentially.
  const exp = policy.baseDelayMs * 2 ** (retry - 1);
  return Math.min(policy.maxDelayMs, exp / 2 + policy.random() * (exp / 2));
}

/**
 * Run `attempt` until it succeeds, a non-retryable `ProviderError` occurs, or attempts run out.
 * Every error from `attempt` must already be a `ProviderError`.
 */
export async function withRetries<T>(
  attempt: (n: number) => Promise<T>,
  policy: RetryPolicy,
  signal?: AbortSignal,
  onRetry?: (error: ProviderError, delayMs: number, attempt: number) => void,
): Promise<{ value: T; attempts: number }> {
  for (let n = 1; ; n++) {
    try {
      return { value: await attempt(n), attempts: n };
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable || n >= policy.maxAttempts)
        throw error;
      const delay = retryDelayMs(error, n, policy);
      onRetry?.(error, delay, n);
      await policy.sleep(delay, signal);
    }
  }
}
