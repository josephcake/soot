import { describe, expect, it } from 'vitest';
import {
  ModelRegistry,
  PRICE_CATALOG,
  PricingSchema,
  actualCostFromUsage,
  applyPriceCatalog,
  catalogPrice,
  estimateCost,
  parseRegistryConfig,
  providerHost,
  unpricedModels,
  unpricedWarning,
  type CatalogEntry,
} from './index.js';

/** Official vendor pricing pages: the only sources the catalog may cite (ADR-037). */
const OFFICIAL_SOURCES = new Set([
  'https://platform.openai.com/docs/pricing',
  'https://docs.anthropic.com/en/docs/about-claude/pricing',
  'https://ai.google.dev/gemini-api/docs/pricing',
  'https://docs.x.ai/docs/models',
  'https://api-docs.deepseek.com/quick_start/pricing',
  'https://docs.mistral.ai/inference/pricing',
]);

const overlaps = (a: CatalogEntry, b: CatalogEntry) =>
  (a.effectiveFrom ?? '0000-00-00') <= (b.effectiveUntil ?? '9999-12-31') &&
  (b.effectiveFrom ?? '0000-00-00') <= (a.effectiveUntil ?? '9999-12-31');

describe('shipped price catalog (ADR-037)', () => {
  it('every entry is a valid, sourced, dated price from an official vendor page', () => {
    expect(PRICE_CATALOG.length).toBeGreaterThan(0);
    for (const e of PRICE_CATALOG) {
      expect(() => PricingSchema.parse(e.pricing)).not.toThrow();
      expect(OFFICIAL_SOURCES.has(e.pricing.source), `${e.modelId}: ${e.pricing.source}`).toBe(
        true,
      );
      expect(e.pricing.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.hosts.length).toBeGreaterThan(0);
      if (e.effectiveFrom !== undefined && e.effectiveUntil !== undefined)
        expect(e.effectiveFrom <= e.effectiveUntil).toBe(true);
      const lc = e.pricing.longContext;
      if (lc !== undefined) {
        expect(lc.inputPerMTokUsd).toBeGreaterThanOrEqual(e.pricing.inputPerMTokUsd);
        expect(lc.outputPerMTokUsd).toBeGreaterThanOrEqual(e.pricing.outputPerMTokUsd);
      }
    }
  });

  it('no two entries for the same host and model are in effect on the same day', () => {
    for (const [i, a] of PRICE_CATALOG.entries()) {
      for (const b of PRICE_CATALOG.slice(i + 1)) {
        const sameModel = a.modelId === b.modelId && a.hosts.some((h) => b.hosts.includes(h));
        if (sameModel) expect(overlaps(a, b), `${a.modelId} has overlapping prices`).toBe(false);
      }
    }
  });

  it('has the grok-4.7 rates from xAI: $2 in / $6 out under 200k, $4 / $12 at 200k and above', () => {
    const p = catalogPrice('api.x.ai', 'grok-4.7', '2026-11-13');
    expect(p).toMatchObject({
      inputPerMTokUsd: 2,
      outputPerMTokUsd: 6,
      cacheReadPerMTokUsd: 0.5,
      longContext: { aboveInputTokens: 199_999, inputPerMTokUsd: 4, outputPerMTokUsd: 12 },
      source: 'https://docs.x.ai/docs/models',
      asOf: '2026-11-13',
    });
  });

  it('dated prices switch on the announced day', () => {
    expect(
      catalogPrice('generativelanguage.googleapis.com', 'gemini-4-carbon', '2026-11-30'),
    ).toMatchObject({ inputPerMTokUsd: 2, outputPerMTokUsd: 10 });
    expect(
      catalogPrice('generativelanguage.googleapis.com', 'gemini-4-carbon', '2026-12-01'),
    ).toMatchObject({ inputPerMTokUsd: 4, outputPerMTokUsd: 20 });
  });

  it('matches on the vendor API host, not just the model id', () => {
    expect(catalogPrice('api.anthropic.com', 'claude-opus-5-5', '2026-11-13')).not.toBeNull();
    expect(catalogPrice('openrouter.example', 'claude-opus-5-5', '2026-11-13')).toBeNull();
    expect(catalogPrice('api.anthropic.com', 'no-such-model', '2026-11-13')).toBeNull();
  });
});

const config = () =>
  parseRegistryConfig({
    version: 1,
    providers: [
      { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      {
        id: 'xai',
        kind: 'openai-compatible',
        baseURL: 'https://api.x.ai/v1',
        apiKeyEnv: 'XAI_API_KEY',
      },
      { id: 'local', kind: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', local: true },
      { id: 'listed', kind: 'listed-only' },
    ],
    models: [
      {
        provider: 'anthropic',
        modelId: 'claude-sonnet-5-5',
        pricing: {
          inputPerMTokUsd: 9,
          outputPerMTokUsd: 9,
          source: 'my contract',
          asOf: '2026-11-01',
        },
      },
      { provider: 'anthropic', modelId: 'claude-haiku-5-5' },
      { provider: 'xai', modelId: 'grok-4.7' },
      { provider: 'local', modelId: 'my-local-coder' },
      { provider: 'listed', modelId: 'claude-opus-5-5' },
    ],
  });

describe('applyPriceCatalog / unpricedModels', () => {
  it('fills in catalog prices only for unpriced models; a configured price always wins', () => {
    const { config: priced, catalogPriced } = applyPriceCatalog(config(), { today: '2026-11-13' });
    expect(catalogPriced).toEqual(['anthropic/claude-haiku-5-5', 'xai/grok-4.7']);
    const byRef = new Map(priced.models.map((m) => [`${m.provider}/${m.modelId}`, m.pricing]));
    expect(byRef.get('anthropic/claude-sonnet-5-5')).toMatchObject({ source: 'my contract' });
    expect(byRef.get('anthropic/claude-haiku-5-5')).toMatchObject({ inputPerMTokUsd: 0.1 });
    expect(byRef.get('local/my-local-coder')).toBeNull();
    // Listed-only providers have no host and are never called: no catalog price, no warning.
    expect(byRef.get('listed/claude-opus-5-5')).toBeNull();
    expect(unpricedModels(priced)).toEqual(['local/my-local-coder']);
  });

  it('adds no models', () => {
    const before = config();
    expect(applyPriceCatalog(before).config.models).toHaveLength(before.models.length);
  });

  it('warns with the pricing prompt path, or not at all', () => {
    expect(unpricedWarning([])).toBeNull();
    expect(unpricedWarning(['local/my-local-coder'])).toMatch(
      /1 model\(s\) have no price \(local\/my-local-coder\); their costs show as "price not set"\. Run the update-model-pricing prompt \(skills\/update-model-pricing\/SKILL\.md\)/,
    );
  });

  it('providerHost uses baseURL, else the SDK default for native kinds', () => {
    const [anthropic, xai, local, listed] = config().providers;
    expect(anthropic && providerHost(anthropic)).toBe('api.anthropic.com');
    expect(xai && providerHost(xai)).toBe('api.x.ai');
    expect(local && providerHost(local)).toBe('127.0.0.1');
    expect(listed && providerHost(listed)).toBeNull();
  });
});

describe('long-context pricing tier', () => {
  const registry = new ModelRegistry(applyPriceCatalog(config(), { today: '2026-11-13' }).config);
  const grok = registry.get('xai/grok-4.7');
  if (grok === undefined) throw new Error('grok-4.7 missing');

  it('bills every token at the base rate up to the threshold', () => {
    const { costUsd } = estimateCost(grok, { inputTokens: 199_999, outputTokens: 1000 });
    expect(costUsd).toBeCloseTo((199_999 * 2 + 1000 * 6) / 1e6, 12);
  });

  it('bills every token at the long-context rate above it', () => {
    const { costUsd } = actualCostFromUsage(grok, {
      inputTokens: 200_000,
      outputTokens: 1000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: null,
    });
    expect(costUsd).toBeCloseTo((100_000 * 4 + 100_000 * 1 + 1000 * 12) / 1e6, 12);
  });
});
