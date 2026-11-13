import type { ProviderConfig } from './config.js';

/**
 * True if soot may send requests to this provider. `listed-only` providers are never called.
 * There is no vendor-specific restriction: the DeepSeek data-residency hold (ADR-016) was
 * lifted in ADR-035, so a DeepSeek endpoint is callable like any other configured provider.
 */
export function isCallable(provider: ProviderConfig): boolean {
  return provider.kind !== 'listed-only';
}
