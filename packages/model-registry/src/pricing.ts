import { actualUsd, estimatedUsd, type ActualUsd, type EstimatedUsd } from '@soot/observability';
import type { Pricing } from './config.js';
import type { ModelEntry } from './registry.js';

/** Provenance of a computed cost: which list price it used. */
export interface PriceBasis {
  readonly ref: string;
  readonly source: string;
  readonly asOf: string;
}

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
}

/** Usage reported by a provider for a call that actually happened. `null` = not reported. */
export interface ReportedTokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

function priceOf(pricing: Pricing, t: TokenCounts): number | null {
  const cacheRead = t.cacheReadTokens ?? 0;
  const cacheWrite = t.cacheWriteTokens ?? 0;
  if (cacheRead > 0 && pricing.cacheReadPerMTokUsd === null) return null;
  if (cacheWrite > 0 && pricing.cacheWritePerMTokUsd === null) return null;
  const uncachedInput = Math.max(0, t.inputTokens - cacheRead - cacheWrite);
  return (
    (uncachedInput * pricing.inputPerMTokUsd +
      t.outputTokens * pricing.outputPerMTokUsd +
      cacheRead * (pricing.cacheReadPerMTokUsd ?? 0) +
      cacheWrite * (pricing.cacheWritePerMTokUsd ?? 0)) /
    1_000_000
  );
}

const basisOf = (model: ModelEntry, pricing: Pricing): PriceBasis => ({
  ref: model.ref,
  source: pricing.source,
  asOf: pricing.asOf,
});

/** Estimated cost of planned token counts. `costUsd: null` when the price is unknown. */
export function estimateCost(
  model: ModelEntry,
  tokens: TokenCounts,
): { readonly costUsd: EstimatedUsd | null; readonly basis: PriceBasis | null } {
  if (model.pricing === null) return { costUsd: null, basis: null };
  const usd = priceOf(model.pricing, tokens);
  return { costUsd: usd === null ? null : estimatedUsd(usd), basis: basisOf(model, model.pricing) };
}

/**
 * Cost of a call that happened, from the provider's REPORTED usage times the configured list
 * price. `null` when the price or any needed usage figure is unknown (never guessed as 0).
 * The provider APIs return usage, not dollars, so this is computed (see `basis`).
 */
export function actualCostFromUsage(
  model: ModelEntry,
  usage: ReportedTokenUsage,
): { readonly costUsd: ActualUsd | null; readonly basis: PriceBasis | null } {
  if (model.pricing === null || usage.inputTokens === null || usage.outputTokens === null) {
    return { costUsd: null, basis: model.pricing === null ? null : basisOf(model, model.pricing) };
  }
  const usd = priceOf(model.pricing, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  });
  return { costUsd: usd === null ? null : actualUsd(usd), basis: basisOf(model, model.pricing) };
}
