/** ADR-043: model tiers stand in for unmeasured reliability; auto-pool routing end to end. */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_REGISTRY_CONFIG,
  ModelRegistry,
  addAutoModels,
  parseRegistryConfig,
} from '@soot/model-registry';
import { InMemorySuccessHistory } from './history.js';
import { customPolicy } from './policy.js';
import { routeTask } from './router.js';
import { makeTask } from './test-fixtures.js';

const DAY = '2026-11-14';
function pool(...keys: string[]): ModelRegistry {
  const r = addAutoModels(EMPTY_REGISTRY_CONFIG, {
    keyIsSet: (p) => p.apiKeyEnv !== undefined && keys.includes(p.apiKeyEnv),
    today: DAY,
  });
  return new ModelRegistry(r.config, { autoRefs: r.autoRefs });
}

const light = makeTask('rename-label', { requiredCapabilities: ['code-edit', 'css'] });
const medium = makeTask('add-dropdown', {
  requiredCapabilities: ['code-edit', 'react', 'testing'],
  complexity: 'medium',
  estimate: { inputTokens: 6000, outputTokens: 2500, costUsd: null },
});
const hard = makeTask('fix-race', {
  requiredCapabilities: ['code-read', 'debugging'],
  complexity: 'high',
  estimate: { inputTokens: 12_000, outputTokens: 2000, costUsd: null },
});

describe('tiered routing with only xAI and DeepSeek keys', () => {
  const registry = pool('XAI_API_KEY', 'DEEPSEEK_API_KEY');

  it('sends light work to the cheapest low-tier model', () => {
    const d = routeTask(light, { registry, policy: 'balanced' });
    expect(d.status).toBe('routed');
    expect(d.selected).toBe('deepseek/deepseek-flash');
    expect(d.reason).toMatch(/routed by tier \(low model for low work\)/);
  });

  it('keeps low-tier models off medium work and picks the cheapest medium-tier one', () => {
    const d = routeTask(medium, { registry, policy: 'balanced' });
    expect(d.selected).toBe('xai/grok-4.3');
    const flash = d.candidates.find((c) => c.ref === 'deepseek/deepseek-flash');
    expect(flash?.outcome).toBe('below-threshold');
    expect(flash?.detail).toBe('tier low is below medium-tier work (reliability not measured yet)');
  });

  it('falls back to the strongest available tier for hard work, and says so', () => {
    const d = routeTask(hard, { registry, policy: 'economy' });
    expect(d.status).toBe('routed');
    expect(d.selected).toBe('xai/grok-4.7');
    expect(d.reason).toMatch(/no available model's tier reaches high-complexity work/);
  });

  it('fails instead when the policy turns the tier fallback off', () => {
    const d = routeTask(hard, {
      registry,
      policy: customPolicy({ name: 'strict', tierFallback: false }),
    });
    expect(d.status).toBe('unroutable');
    expect(d.selected).toBeNull();
  });

  it('lets measured history take over from the tier', () => {
    const history = new InMemorySuccessHistory();
    for (let i = 0; i < 10; i++) history.record('deepseek/deepseek-flash', 'medium', true);
    const d = routeTask(medium, { registry, policy: 'balanced', history });
    expect(d.selected).toBe('deepseek/deepseek-flash');
    expect(d.candidates[0]?.reliability.source).toBe('history');
  });
});

describe('tiered routing with an Anthropic key', () => {
  const registry = pool('ANTHROPIC_API_KEY');

  it('uses the cheapest high-tier model for hard work and the cheapest model for light work', () => {
    expect(routeTask(hard, { registry, policy: 'balanced' }).selected).toBe(
      'anthropic/claude-opus-5-5',
    );
    expect(routeTask(light, { registry, policy: 'balanced' }).selected).toBe(
      'anthropic/claude-haiku-5-5',
    );
  });

  it('prefers the higher tier under the quality policy', () => {
    expect(routeTask(light, { registry, policy: 'quality' }).selected).toBe(
      'anthropic/claude-opus-5-5',
    );
  });

  it('does not guess capabilities: reasoning-only work stays unroutable on auto models', () => {
    const security = makeTask('audit-auth', { requiredCapabilities: ['security-review'] });
    const d = routeTask(security, { registry, policy: 'balanced' });
    expect(d.status).toBe('unroutable');
    expect(d.candidates[0]?.detail).toMatch(/a required capability is unknown \(reasoning\)/);
  });
});

describe('a user-configured model with a prior', () => {
  it('outranks tier-only models under the balanced policy', () => {
    const r = addAutoModels(
      parseRegistryConfig({
        version: 1,
        providers: [
          { id: 'mine', kind: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', local: true },
        ],
        models: [
          {
            provider: 'mine',
            modelId: 'my-model',
            capabilities: { tools: true, structuredOutput: true },
            contextWindow: 100_000,
            pricing: { inputPerMTokUsd: 5, outputPerMTokUsd: 5, source: 'user-config', asOf: DAY },
            reliability: { low: 0.95, medium: 0.95, high: 0.95, source: 'user judgement' },
          },
        ],
      }),
      { keyIsSet: (p) => p.apiKeyEnv === 'XAI_API_KEY', today: DAY },
    );
    const registry = new ModelRegistry(r.config, { autoRefs: r.autoRefs });
    expect(routeTask(medium, { registry, policy: 'balanced' }).selected).toBe('mine/my-model');
  });

  it('a tier set in the models file works the same way (e.g. a free proxy for light work)', () => {
    const registry = new ModelRegistry(
      parseRegistryConfig({
        version: 1,
        providers: [
          {
            id: 'freellmapi',
            kind: 'openai-compatible',
            baseURL: 'http://localhost:3001/v1',
            apiKeyEnv: 'FREELLMAPI_KEY',
          },
        ],
        models: [
          {
            provider: 'freellmapi',
            modelId: 'auto',
            capabilities: { tools: true, structuredOutput: true },
            pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0, source: 'user-config', asOf: DAY },
            tier: 'low',
          },
        ],
      }),
    );
    expect(routeTask(light, { registry, policy: 'balanced' }).selected).toBe('freellmapi/auto');
  });
});
