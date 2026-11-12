import type { ProviderConfig } from './config.js';

/**
 * Why soot refuses to call a provider even if it is configured.
 * `data-residency-review`: DeepSeek is out of the default MVP path and out of any demo that
 * sends code to its API until Joseph reviews data residency (ADR-016). The registry may still
 * list its models.
 */
export type ProviderRestriction = 'data-residency-review';

const DEEPSEEK_HOST = /(^|\.)deepseek\.com$/i;

/** Restriction for a provider, or `null` when soot may call it. */
export function providerRestriction(provider: ProviderConfig): ProviderRestriction | null {
  const host = provider.baseURL === undefined ? '' : new URL(provider.baseURL).hostname;
  if (DEEPSEEK_HOST.test(host) || /deepseek/i.test(provider.id)) return 'data-residency-review';
  return null;
}

/** True if soot may send requests to this provider. `listed-only` providers are never called. */
export function isCallable(provider: ProviderConfig): boolean {
  return provider.kind !== 'listed-only' && providerRestriction(provider) === null;
}
