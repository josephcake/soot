import { describe, expect, it } from 'vitest';
import { TEST_CONFIG } from './test-fixtures.js';
import {
  ModelRegistry,
  ProviderHealth,
  actualCostFromUsage,
  estimateCost,
  isCallable,
  parseRegistryConfig,
  providerRestriction,
} from './index.js';

const registry = () => new ModelRegistry(parseRegistryConfig(TEST_CONFIG));

describe('model registry (M2-04, M2-05, M2-06)', () => {
  it('has no built-in models: an empty config is an empty registry', () => {
    expect(
      new ModelRegistry(parseRegistryConfig({ version: 1, providers: [], models: [] })).models(),
    ).toEqual([]);
  });

  it('selects callable models by requirements and explains every exclusion', () => {
    const { candidates, excluded } = registry().select({
      capabilities: ['tools', 'structuredOutput'],
    });
    expect(candidates.map((m) => m.ref)).toEqual([
      'anthropic/test-claude-small',
      'openai/test-gpt-large',
    ]);
    expect(excluded).toEqual([
      {
        ref: 'local-ollama/test-local-coder',
        reasons: ['missing-capability', 'unknown-capability'],
      },
      { ref: 'deepseek/test-deepseek-model', reasons: ['restricted', 'unknown-capability'] },
    ]);
  });

  it('treats unknown capabilities and context windows as not satisfying a requirement', () => {
    const sel = registry().select({ capabilities: ['vision'], minContextWindow: 100_000 });
    expect(sel.candidates.map((m) => m.ref)).toEqual(['anthropic/test-claude-small']);
    expect(sel.excluded.find((e) => e.ref === 'openai/test-gpt-large')?.reasons).toEqual([
      'unknown-capability',
    ]);
    expect(sel.excluded.find((e) => e.ref === 'local-ollama/test-local-coder')?.reasons).toContain(
      'unknown-context-window',
    );
  });

  it('selects dynamically by provider, locality, and current availability', () => {
    const r = registry();
    expect(r.select({ localOnly: true }).candidates.map((m) => m.ref)).toEqual([
      'local-ollama/test-local-coder',
    ]);
    expect(r.select({ providers: ['openai'] }).candidates.map((m) => m.ref)).toEqual([
      'openai/test-gpt-large',
    ]);

    let now = 1_000;
    const health = new ProviderHealth(() => now);
    health.markUnavailable('anthropic', 'outage', { cooldownMs: 5_000, detail: 'HTTP 503' });
    expect(r.select({}, health).candidates.map((m) => m.ref)).toEqual([
      'openai/test-gpt-large',
      'local-ollama/test-local-coder',
    ]);
    expect(health.status('anthropic')).toEqual({
      provider: 'anthropic',
      available: false,
      reason: 'outage',
      until: 6_000,
      detail: 'HTTP 503',
    });
    now = 6_000; // cooldown elapsed
    expect(r.select({}, health).candidates[0]?.ref).toBe('anthropic/test-claude-small');
    health.markUnavailable('openai', 'auth');
    now = 10 ** 12;
    expect(health.isAvailable('openai')).toBe(false);
  });

  describe('DeepSeek stays off the default path (ADR-016)', () => {
    it('is listed but never selectable or callable, however it is configured', () => {
      const r = new ModelRegistry(
        parseRegistryConfig({
          version: 1,
          providers: [
            { id: 'deepseek', kind: 'listed-only' },
            {
              id: 'cheap-compat',
              kind: 'openai-compatible',
              baseURL: 'https://api.deepseek.com/v1',
            },
          ],
          models: [
            { provider: 'deepseek', modelId: 'a', capabilities: { tools: true } },
            { provider: 'cheap-compat', modelId: 'b', capabilities: { tools: true } },
          ],
        }),
      );
      expect(r.models().map((m) => m.ref)).toEqual(['deepseek/a', 'cheap-compat/b']);
      expect(r.select().candidates).toEqual([]);
      for (const provider of r.providers()) {
        expect(providerRestriction(provider)).toBe('data-residency-review');
        expect(isCallable(provider)).toBe(false);
      }
    });
  });

  describe('discovery overlay', () => {
    it('marks configured models the provider no longer lists and adds unknown ones as unselectable', () => {
      const r = registry();
      const result = r.applyDiscovery('openai', ['test-gpt-new']);
      expect(result).toEqual({
        added: ['openai/test-gpt-new'],
        missing: ['openai/test-gpt-large'],
      });
      expect(r.get('openai/test-gpt-new')).toMatchObject({
        origin: 'discovered',
        selectable: false,
        contextWindow: null,
        pricing: null,
        capabilities: {
          tools: null,
          structuredOutput: null,
          vision: null,
          reasoning: null,
          streaming: null,
        },
      });
      const sel = r.select({ providers: ['openai'] });
      expect(sel.candidates).toEqual([]);
      expect(
        sel.excluded.filter((e) => e.ref.startsWith('openai/')).map((e) => [e.ref, e.reasons]),
      ).toEqual([
        ['openai/test-gpt-large', ['not-listed-by-provider']],
        ['openai/test-gpt-new', ['not-selectable']],
      ]);
      expect(() => r.applyDiscovery('ghost', [])).toThrow(/Unknown provider/);
    });
  });

  describe('pricing (M2-06)', () => {
    it('estimates from the sourced list price and keeps provenance', () => {
      const model = registry().get('anthropic/test-claude-small');
      if (!model) throw new Error('missing');
      const estimate = estimateCost(model, {
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        cacheReadTokens: 500_000,
      });
      // 500k uncached input * $1 + 500k cache read * $0.1 + 200k output * $5 per MTok
      expect(estimate.costUsd).toBeCloseTo(0.5 + 0.05 + 1);
      expect(estimate.basis).toEqual({
        ref: 'anthropic/test-claude-small',
        source: 'user-config',
        asOf: '2026-11-12',
      });
    });

    it('returns unknown (null) cost when the price or a needed figure is unknown', () => {
      const r = registry();
      const local = r.get('local-ollama/test-local-coder');
      const openai = r.get('openai/test-gpt-large');
      if (!local || !openai) throw new Error('missing');
      expect(estimateCost(local, { inputTokens: 10, outputTokens: 10 })).toEqual({
        costUsd: null,
        basis: null,
      });
      // openai has no cache-read price, so cached tokens make the estimate unknown rather than free.
      expect(
        estimateCost(openai, { inputTokens: 10, outputTokens: 10, cacheReadTokens: 5 }).costUsd,
      ).toBeNull();
      expect(
        actualCostFromUsage(openai, {
          inputTokens: null,
          outputTokens: 5,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        }).costUsd,
      ).toBeNull();
    });

    it('computes actual cost from reported usage separately from estimates', () => {
      const openai = registry().get('openai/test-gpt-large');
      if (!openai) throw new Error('missing');
      const actual = actualCostFromUsage(openai, {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: null,
      });
      expect(actual.costUsd).toBeCloseTo((1000 * 2 + 500 * 8) / 1e6);
      expect(actual.basis?.source).toBe('https://example.invalid/pricing');
    });
  });
});
