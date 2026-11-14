/**
 * Wall-clock limits for model calls (ADR-040). A limit covers everything one logical call
 * does: the HTTP request, the adapter's own transient retries and (for the api runner) its
 * repair round. When it expires the in-flight request is aborted through its AbortSignal.
 */

/** Default limit for one model call: one api-runner try, or one planner call. */
export const DEFAULT_MODEL_CALL_TIMEOUT_MS = 120_000;

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
 * never hold the caller past the limit. `remaining()` is the time left, for per-request limits.
 */
export async function withTimeLimit<T>(
  limitMs: number,
  signal: AbortSignal | undefined,
  fn: (signal: AbortSignal, remaining: () => number) => Promise<T>,
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
    return await Promise.race([fn(combined, () => Math.max(1, deadline - Date.now())), expired]);
  } catch (error) {
    if (expiry.signal.aborted && signal?.aborted !== true) throw onTimeout();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
