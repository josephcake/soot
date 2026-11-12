import { APICallError } from 'ai';

export type ProviderErrorKind =
  /** 429 or provider-specific rate/spend limit. Retryable after a delay. */
  | 'rate-limited'
  /** 5xx, 529 overloaded, network failure. Retryable; may trigger fallback. */
  | 'unavailable'
  | 'timeout'
  /** 401/403 or missing key. Not retryable; falls back to another provider. */
  | 'auth'
  /** 400/404/422: the request itself is wrong. Not retryable, no fallback. */
  | 'invalid-request'
  /** The model answered but the structured output failed validation. */
  | 'invalid-output'
  | 'aborted'
  /** soot refuses to call this provider (policy, listed-only, missing config). */
  | 'refused'
  | 'unknown';

/**
 * The only error type adapters let escape. It carries no request headers, request body, raw
 * cause, or response body, and its message is scrubbed of every known secret, so it can be
 * logged or stored safely.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status: number | null;
  /** Delay the provider asked for (`retry-after` / `retry-after-ms`), if any. */
  readonly retryAfterMs: number | null;

  constructor(init: {
    kind: ProviderErrorKind;
    provider: string;
    message: string;
    status?: number | null;
    retryAfterMs?: number | null;
  }) {
    super(`[${init.provider}] ${init.kind}: ${init.message}`);
    this.name = 'ProviderError';
    this.kind = init.kind;
    this.provider = init.provider;
    this.status = init.status ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
  }

  get retryable(): boolean {
    return this.kind === 'rate-limited' || this.kind === 'unavailable' || this.kind === 'timeout';
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      provider: this.provider,
      status: this.status,
      message: this.message,
    };
  }
}

/** Replace every occurrence of each secret with `[redacted]`. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  return out;
}

function retryAfterMs(
  headers: Record<string, string> | undefined,
  now: () => number,
): number | null {
  if (!headers) return null;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const ms = Number(lower['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = lower['retry-after'];
  if (raw === undefined) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - now());
}

function kindForStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate-limited';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'unavailable'; // includes Anthropic 529 overloaded
  if (status >= 400) return 'invalid-request';
  return 'unknown';
}

/** Map anything thrown by the AI SDK or fetch to a sanitized `ProviderError`. */
export function toProviderError(
  error: unknown,
  provider: string,
  secrets: readonly string[],
  now: () => number = Date.now,
): ProviderError {
  if (error instanceof ProviderError) return error;
  const scrub = (s: string) => redact(s, secrets);
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? null;
    return new ProviderError({
      kind: status === null ? 'unavailable' : kindForStatus(status),
      provider,
      status,
      retryAfterMs: retryAfterMs(error.responseHeaders, now),
      message: scrub(
        status === null ? `request failed: ${error.message}` : `HTTP ${status}: ${error.message}`,
      ),
    });
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError')
      return new ProviderError({ kind: 'aborted', provider, message: 'request aborted' });
    if (error.name === 'TimeoutError')
      return new ProviderError({ kind: 'timeout', provider, message: scrub(error.message) });
    // Network failures from fetch surface as TypeError ("fetch failed").
    if (error.name === 'TypeError' && /fetch|network|ECONN|socket/i.test(error.message)) {
      return new ProviderError({
        kind: 'unavailable',
        provider,
        message: scrub(`network error: ${error.message}`),
      });
    }
    return new ProviderError({
      kind: 'unknown',
      provider,
      message: scrub(`${error.name}: ${error.message}`),
    });
  }
  return new ProviderError({ kind: 'unknown', provider, message: scrub(String(error)) });
}
