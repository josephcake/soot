import type { ProviderHealth, UnavailableReason } from '@soot/model-registry';
import { ProviderError, toProviderError } from './errors.js';
import type { GenerateRequest, GenerateResponse, ModelClient } from './types.js';

export interface FallbackAttempt {
  readonly ref: string;
  readonly outcome: 'succeeded' | 'failed' | 'skipped-unavailable';
  readonly error: { readonly kind: ProviderError['kind']; readonly message: string } | null;
}

export interface FallbackResult<T> {
  readonly response: GenerateResponse<T>;
  readonly trail: readonly FallbackAttempt[];
}

const REASON: Partial<Record<ProviderError['kind'], UnavailableReason>> = {
  unavailable: 'outage',
  'rate-limited': 'rate-limited',
  timeout: 'timeout',
  auth: 'auth',
  refused: 'not-configured',
};

export class AllCandidatesFailedError extends Error {
  readonly trail: readonly FallbackAttempt[];
  constructor(trail: readonly FallbackAttempt[]) {
    super(
      `All ${trail.length} candidate models failed or were unavailable: ${trail.map((t) => `${t.ref} (${t.error?.kind ?? t.outcome})`).join(', ')}`,
    );
    this.name = 'AllCandidatesFailedError';
    this.trail = trail;
  }
}

/**
 * Try candidates in order (M2-05). A provider-level failure (outage, rate limit after retries,
 * timeout, auth) marks that provider unavailable in `health` and moves on to the next
 * candidate. Request-level failures (invalid request, invalid structured output) and aborts
 * stop immediately: another provider would not fix them, or the caller asked to stop.
 * The AI SDK's own fallback only covers unknown model ids, not outages (research §3.2).
 */
export async function generateWithFallback<T>(
  candidates: readonly ModelClient[],
  request: GenerateRequest<T>,
  health: ProviderHealth,
  signal?: AbortSignal,
): Promise<FallbackResult<T>> {
  const trail: FallbackAttempt[] = [];
  for (const client of candidates) {
    if (!health.isAvailable(client.provider)) {
      trail.push({ ref: client.ref, outcome: 'skipped-unavailable', error: null });
      continue;
    }
    try {
      const response = await client.generate(request, signal);
      trail.push({ ref: client.ref, outcome: 'succeeded', error: null });
      return { response, trail };
    } catch (raw) {
      const error = raw instanceof ProviderError ? raw : toProviderError(raw, client.provider, []);
      trail.push({
        ref: client.ref,
        outcome: 'failed',
        error: { kind: error.kind, message: error.message },
      });
      const reason = REASON[error.kind];
      if (reason === undefined) throw error;
      health.markUnavailable(client.provider, reason, {
        detail: error.message,
        ...(error.retryAfterMs === null ? {} : { cooldownMs: error.retryAfterMs }),
      });
    }
  }
  throw new AllCandidatesFailedError(trail);
}
