/** ADR-043: the key-based auto pool (pure: the caller says which keys are set). */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_REGISTRY_CONFIG,
  KNOWN_PROVIDERS,
  TIER_BANDS,
  addAutoModels,
  describeAutoPool,
  tierFromPrice,
} from './auto-pool.js';
import { parseRegistryConfig, structuredOutputMode } from './config.js';
import { PRICE_CATALOG, providerHost } from './price-catalog.js';
import { ModelRegistry } from './registry.js';

const DAY = '2026-11-14';
const keys =
  (...names: string[]) =>
  (p: { apiKeyEnv?: string | undefined }) =>
    p.apiKeyEnv !== undefined && names.includes(p.apiKeyEnv);

describe('tierFromPrice', () => {
  it('bands on the list output price', () => {
    expect(tierFromPrice({ outputPerMTokUsd: 0.5 })).toBe('low');
    expect(tierFromPrice({ outputPerMTokUsd: TIER_BANDS.medium - 0.01 })).toBe('low');
    expect(tierFromPrice({ outputPerMTokUsd: TIER_BANDS.medium })).toBe('medium');
    expect(tierFromPrice({ outputPerMTokUsd: 10 })).toBe('medium');
    expect(tierFromPrice({ outputPerMTokUsd: TIER_BANDS.high })).toBe('high');
    expect(tierFromPrice({ outputPerMTokUsd: 50 })).toBe('high');
  });
});

describe('KNOWN_PROVIDERS', () => {
  it('name a key variable and a host the price catalog covers', () => {
    for (const { provider } of KNOWN_PROVIDERS) {
      expect(provider.apiKeyEnv).toMatch(/^[A-Z][A-Z0-9_]*_API_KEY$/);
      const host = providerHost(provider);
      expect(host).not.toBeNull();
      expect(PRICE_CATALOG.some((e) => e.hosts.includes(host ?? ''))).toBe(true);
    }
  });
});

describe('addAutoModels', () => {
  it('adds nothing when no key is set', () => {
    const r = addAutoModels(EMPTY_REGISTRY_CONFIG, { keyIsSet: () => false, today: DAY });
    expect(r.config.providers).toEqual([]);
    expect(r.config.models).toEqual([]);
    expect(r.providers.map((p) => p.status)).toEqual(['no-key', 'no-key', 'no-key', 'no-key']);
  });

  it('adds every catalog model for each vendor whose key is set, priced with source and asOf, tiered by price', () => {
    const r = addAutoModels(EMPTY_REGISTRY_CONFIG, {
      keyIsSet: keys('XAI_API_KEY', 'DEEPSEEK_API_KEY'),
      today: DAY,
    });
    // The result is a valid registry config.
    const config = parseRegistryConfig(r.config);
    expect(config.providers.map((p) => p.id)).toEqual(['xai', 'deepseek']);
    expect(r.autoRefs).toEqual([
      'xai/grok-build-0.1',
      'xai/grok-4.3',
      'xai/grok-4.7',
      'deepseek/deepseek-flash',
      'deepseek/deepseek-v4-pro',
    ]);
    for (const m of config.models) {
      expect(m.pricing?.source).toMatch(/^https:\/\//);
      expect(m.pricing?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.capabilities.tools).toBe(true);
      expect(m.capabilities.structuredOutput).toBe(true);
      // Nothing else is guessed.
      expect(m.capabilities.reasoning).toBeNull();
      expect(m.reliability.source).toBeNull();
      expect(m.contextWindow).toBeNull();
    }
    const tiers = Object.fromEntries(
      config.models.map((m) => [`${m.provider}/${m.modelId}`, m.tier]),
    );
    expect(tiers).toEqual({
      'xai/grok-build-0.1': 'low',
      'xai/grok-4.3': 'medium',
      'xai/grok-4.7': 'medium',
      'deepseek/deepseek-flash': 'low',
      'deepseek/deepseek-v4-pro': 'medium',
    });
    // DeepSeek needs json_object structured output (ADR-036).
    const deepseek = config.providers.find((p) => p.id === 'deepseek');
    expect(deepseek && structuredOutputMode(deepseek, {})).toBe('json_object');
    const registry = new ModelRegistry(config, { autoRefs: r.autoRefs });
    expect(registry.models().every((m) => m.origin === 'auto')).toBe(true);
  });

  it('gives strong frontier models the high tier', () => {
    const r = addAutoModels(EMPTY_REGISTRY_CONFIG, {
      keyIsSet: keys('ANTHROPIC_API_KEY'),
      today: DAY,
    });
    const tiers = Object.fromEntries(r.config.models.map((m) => [m.modelId, m.tier]));
    expect(tiers['claude-haiku-5-5']).toBe('low');
    expect(tiers['claude-sonnet-5-5']).toBe('medium');
    expect(tiers['claude-opus-5-5']).toBe('high');
  });

  it('never touches a vendor the models file configures (same provider id or key variable)', () => {
    const base = parseRegistryConfig({
      version: 1,
      providers: [
        {
          id: 'my-grok',
          kind: 'openai-compatible',
          baseURL: 'https://api.x.ai/v1',
          apiKeyEnv: 'XAI_API_KEY',
        },
        { id: 'deepseek', kind: 'listed-only' },
      ],
      models: [{ provider: 'my-grok', modelId: 'grok-4.7', tier: 'high' }],
    });
    const r = addAutoModels(base, {
      keyIsSet: keys('XAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'),
      today: DAY,
    });
    expect(r.config.models.filter((m) => m.provider === 'my-grok')).toEqual(base.models);
    expect(r.config.providers.map((p) => p.id)).toEqual(['my-grok', 'deepseek', 'openai']);
    const status = Object.fromEntries(r.providers.map((p) => [p.id, p.status]));
    expect(status).toEqual({
      anthropic: 'no-key',
      openai: 'added',
      xai: 'configured',
      deepseek: 'configured',
    });
    expect(r.autoRefs.every((ref) => ref.startsWith('openai/'))).toBe(true);
  });

  it('is off with enabled: false', () => {
    const r = addAutoModels(EMPTY_REGISTRY_CONFIG, {
      keyIsSet: () => true,
      enabled: false,
      today: DAY,
    });
    expect(r.config.models).toEqual([]);
    expect(r.providers.every((p) => p.status === 'off')).toBe(true);
  });

  it('describes vendors by key variable name only', () => {
    const r = addAutoModels(EMPTY_REGISTRY_CONFIG, { keyIsSet: keys('XAI_API_KEY'), today: DAY });
    const lines = describeAutoPool(r.providers).join('\n');
    expect(lines).toContain('$XAI_API_KEY is set');
    expect(lines).toContain('xai/grok-build-0.1 [low]');
    expect(lines).toContain('$ANTHROPIC_API_KEY is not set');
  });
});
