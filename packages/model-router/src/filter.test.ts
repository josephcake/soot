/** M3-02: the capability filter drops models lacking mandatory capabilities, per dimension. */
import { describe, expect, it } from 'vitest';
import { ProviderHealth } from '@soot/model-registry';
import { routeTask, type RoutingDecision } from './router.js';
import {
  makeTask,
  routingRegistry,
  ROUTING_CONFIG,
  ROUTING_CONFIG_WITH_DEEPSEEK,
} from './test-fixtures.js';

const outcome = (d: RoutingDecision, ref: string) => d.candidates.find((c) => c.ref === ref);
const route = (
  overrides: Parameters<typeof makeTask>[1],
  extra: Partial<Parameters<typeof routeTask>[1]> = {},
) =>
  routeTask(makeTask('t', overrides), { registry: routingRegistry(), policy: 'quality', ...extra });

function registryWith(ref: string, patch: Record<string, unknown>) {
  return routingRegistry({
    ...ROUTING_CONFIG,
    models: ROUTING_CONFIG.models.map((m) =>
      `${m.provider}/${m.modelId}` === ref ? { ...m, ...patch } : m,
    ),
  });
}

describe('capability filter (M3-02)', () => {
  it('tools: drops a model without tool calling', () => {
    const registry = registryWith('beta/test-frontier', {
      capabilities: {
        tools: false,
        structuredOutput: true,
        vision: true,
        reasoning: true,
        streaming: true,
      },
    });
    const d = routeTask(makeTask('t'), { registry, policy: 'quality' });
    expect(outcome(d, 'beta/test-frontier')?.outcome).toBe('excluded');
    expect(outcome(d, 'beta/test-frontier')?.detail).toContain(
      'missing a required capability (tools)',
    );
    expect(d.selected).toBe('alpha/test-large');
  });

  it('structuredOutput: drops a model whose structured output is unknown, not just false', () => {
    const d = route({});
    const local = outcome(d, 'local/test-local-coder');
    expect(local?.exclusions).toContain('unknown-capability');
    expect(local?.detail).toContain('structuredOutput');
  });

  it('vision: keeps only vision-capable models for visual work', () => {
    const d = route({ requiredCapabilities: ['ui-visual'] }, { policy: 'economy' });
    expect(outcome(d, 'alpha/test-small')?.exclusions).toContain('missing-capability');
    expect(d.selected).toBe('beta/test-mid');
  });

  it('reasoning: security review only goes to reasoning models', () => {
    const d = route(
      { requiredCapabilities: ['code-read', 'security-review'] },
      { policy: 'economy' },
    );
    for (const ref of ['alpha/test-small', 'beta/test-mid']) {
      expect(outcome(d, ref)?.exclusions).toContain('missing-capability');
    }
    expect(['alpha/test-large', 'beta/test-frontier']).toContain(d.selected);
  });

  it('streaming: drops a model that cannot stream when streaming is required', () => {
    const registry = registryWith('alpha/test-small', {
      capabilities: {
        tools: true,
        structuredOutput: true,
        vision: false,
        reasoning: false,
        streaming: false,
      },
    });
    const d = routeTask(makeTask('t', { requiredCapabilities: ['streaming'] }), {
      registry,
      policy: 'economy',
    });
    expect(outcome(d, 'alpha/test-small')?.detail).toContain('(streaming)');
    expect(d.selected).toBe('beta/test-mid');
  });

  it('context window: drops models that cannot hold the planned tokens', () => {
    const d = route({
      estimate: { inputTokens: 300_000, outputTokens: 4000, costUsd: null },
      complexity: 'high',
    });
    expect(outcome(d, 'alpha/test-large')?.exclusions).toContain('context-window-too-small');
    expect(outcome(d, 'alpha/test-small')?.exclusions).toContain('context-window-too-small');
    expect(d.selected).toBe('beta/test-frontier');
  });

  it('max output: drops models whose output limit is below the planned output', () => {
    const d = route(
      { estimate: { inputTokens: 1000, outputTokens: 10_000, costUsd: null } },
      { policy: 'economy' },
    );
    expect(outcome(d, 'alpha/test-small')?.exclusions).toContain('max-output-too-small');
    expect(d.selected).toBe('beta/test-mid');
  });

  it('availability: drops models of a provider marked unavailable', () => {
    const health = new ProviderHealth();
    health.markUnavailable('alpha', 'outage');
    const d = route({}, { policy: 'economy', health });
    expect(outcome(d, 'alpha/test-small')?.exclusions).toContain('provider-unavailable');
    expect(d.selected).toBe('beta/test-mid');
  });

  it('a listed-only model is never selected, even as the cheapest and most reliable on paper', () => {
    for (const policy of ['economy', 'balanced', 'quality'] as const) {
      const d = route({ requiredCapabilities: ['code-read', 'security-review'] }, { policy });
      expect(d.selected).not.toBe('listed/test-listed');
      expect(outcome(d, 'listed/test-listed')?.exclusions).toContain('listed-only');
    }
  });

  it('a configured DeepSeek model is an ordinary candidate (ADR-035)', () => {
    const registry = routingRegistry(ROUTING_CONFIG_WITH_DEEPSEEK);
    for (const policy of ['economy', 'balanced', 'quality'] as const) {
      const d = route(
        { requiredCapabilities: ['code-read', 'security-review'] },
        { policy, registry },
      );
      expect(outcome(d, 'deepseek/test-ds')?.exclusions).toEqual([]);
      expect(d.selected).toBe('deepseek/test-ds');
    }
  });
});
