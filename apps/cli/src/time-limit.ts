/**
 * Wall-clock limits for model calls (ADR-040). A limit covers everything one logical call
 * does: the HTTP request, the adapter's own transient retries and (for the api runner) its
 * repair round. When it expires the in-flight request is aborted through its AbortSignal.
 */

/** Default limit for one model call: one api-runner try, or one planner call. */
export const DEFAULT_MODEL_CALL_TIMEOUT_MS = 120_000;

/**
 * How much later than the limit a per-request timeout from `requestTimeout()` comes due.
 * Without it, the adapter's `AbortSignal.timeout(time left)` and the limit's own timer came due
 * in the same millisecond (the time left is measured with `Date.now()`, the timers run on
 * Node's own millisecond clock), and the adapter's sometimes fired first: the caller then got
 * the adapter's generic "operation was aborted" timeout instead of `onTimeout()` — about 1–4%
 * of hung calls in a local stress run on Node 26, and flaky ADR-040 tests in CI. With the
 * margin the limit always fires first; the per-request timeout stays as a backstop for a
 * request that ignores the abort.
 */
export const REQUEST_TIMEOUT_MARGIN_MS = 1000;

/** "120s", "1.5s", "300 ms": short, human, exact enough for history and the dashboard. */
export function formatLimit(ms: number): string {
  if (ms < 1000) return `${String(ms)} ms`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? String(s) : s.toFixed(1)}s`;
}

/** Thrown when a time limit expires; `TimeLimitError.is` recognises it structurally. */
export class TimeLimitError extends Error {
  readonly limitMs: number;
  constructor(limitMs: number, what: string) {
    super(`${what} timed out after ${formatLimit(limitMs)}`);
    this.name = 'TimeLimitError';
    this.limitMs = limitMs;
  }
}

/**
 * Run `fn` with a signal that aborts when `signal` does or when `limitMs` passes. On expiry
 * the result rejects with `onTimeout()` even if `fn` ignores the abort, so a hung request can
 * never hold the caller past the limit. `requestTimeout()` is a per-request timeout to hand to
 * an adapter: the time left plus `REQUEST_TIMEOUT_MARGIN_MS`, so it never fires before the limit.
 */
export async function withTimeLimit<T>(
  limitMs: number,
  signal: AbortSignal | undefined,
  fn: (signal: AbortSignal, requestTimeout: () => number) => Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  const deadline = Date.now() + limitMs;
  const expiry = new AbortController();
  const combined = signal === undefined ? expiry.signal : AbortSignal.any([signal, expiry.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expiry.abort();
      reject(onTimeout());
    }, limitMs);
  });
  // Swallow the rejection when fn settles first; the race below still sees it otherwise.
  expired.catch(() => undefined);
  try {
    const requestTimeout = () => Math.max(1, deadline - Date.now()) + REQUEST_TIMEOUT_MARGIN_MS;
    return await Promise.race([fn(combined, requestTimeout), expired]);
  } catch (error) {
    if (expiry.signal.aborted && signal?.aborted !== true) throw onTimeout();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
