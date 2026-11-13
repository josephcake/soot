/** M3-03 cost estimates, M3-04 selection (incl. history), M3-05 explanations. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ActualUsd, EstimatedUsd } from '@soot/observability';
import { RoutingLog, formatRoutingEntry } from '@soot/observability';
import { InMemorySuccessHistory, estimateReliability, historyFromAttempts } from './history.js';
import { customPolicy } from './policy.js';
import { routeTask, routeTasks } from './router.js';
import { makeTask, routingRegistry } from './test-fixtures.js';

const registry = routingRegistry();
const simple = makeTask('update-button-color', { requiredCapabilities: ['code-edit', 'css'] });
const medium = makeTask('add-dropdown', {
  requiredCapabilities: ['code-edit', 'react', 'testing'],
  complexity: 'medium',
  estimate: { inputTokens: 6000, outputTokens: 2500, costUsd: null },
});
const complex = makeTask('verify-auth-bug', {
  requiredCapabilities: ['code-read', 'debugging', 'testing'],
  complexity: 'high',
  estimate: { inputTokens: 12_000, outputTokens: 2000, costUsd: null },
});

describe('cost estimation per task per candidate (M3-03)', () => {
  it('prices every candidate from registry list prices and labels it an estimate with its source', () => {
    const d = routeTask(simple, { registry, policy: 'balanced' });
    const small = d.candidates.find((c) => c.ref === 'alpha/test-small');
    // 2000 in × $0.25/M + 300 out × $1.25/M
    expect(small?.estimate.kind).toBe('estimate');
    expect(small?.estimate.costUsd).toBeCloseTo(0.000875, 12);
    expect(small?.estimate.basis).toEqual({
      ref: 'alpha/test-small',
      source: 'test fixture (fictional)',
      asOf: '2026-11-12',
    });
    const mid = d.candidates.find((c) => c.ref === 'beta/test-mid');
    expect(mid?.estimate.costUsd).toBeCloseTo(0.0032, 12);
    expect(d.estimate).toEqual(small?.estimate);
  });

  it('uses a branded estimate type that cannot be mistaken for an actual', () => {
    const d = routeTask(simple, { registry, policy: 'balanced' });
    expectTypeOf(d.candidates[0]?.estimate.costUsd).toEqualTypeOf<
      EstimatedUsd | null | undefined
    >();
    expectTypeOf<EstimatedUsd>().not.toEqualTypeOf<ActualUsd>();
    // The task's own planner estimate is not overwritten by routing.
    expect(simple.estimate.costUsd).toBeNull();
  });

  it('keeps unknown prices unknown and excludes unpriced models unless the policy allows them', () => {
    const unpriced = routingRegistry({
      version: 1,
      providers: [
        { id: 'p', kind: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', local: true },
      ],
      models: [
        {
          provider: 'p',
          modelId: 'm',
          capabilities: { tools: true, structuredOutput: true },
          contextWindow: 100_000,
          reliability: { low: 0.9, source: 'test' },
        },
      ],
    });
    const strict = routeTask(simple, { registry: unpriced, policy: 'balanced' });
    expect(strict.status).toBe('unroutable');
    expect(strict.candidates[0]?.exclusions).toEqual(['unpriced']);
    const lenient = routeTask(simple, {
      registry: unpriced,
      policy: customPolicy({ allowUnpriced: true }),
    });
    expect(lenient.selected).toBe('p/m');
    expect(lenient.estimate?.costUsd).toBeNull();
  });
});

describe('model selection (M3-04)', () => {
  it('assigns a simple task to an inexpensive capable model', () => {
    const d = routeTask(simple, { registry, policy: 'balanced' });
    expect(d.selected).toBe('alpha/test-small');
    const pricedEligible = d.candidates.filter(
      (c) => c.outcome !== 'excluded' && c.estimate.costUsd !== null,
    );
    const cheapest = Math.min(...pricedEligible.map((c) => c.estimate.costUsd ?? Infinity));
    expect(d.estimate?.costUsd).toBe(cheapest);
  });

  it('assigns a complex task to a stronger model that meets the higher threshold', () => {
    const d = routeTask(complex, { registry, policy: 'balanced' });
    expect(d.threshold).toBe(0.9);
    expect(d.selected).toBe('alpha/test-large');
    expect(d.candidates.find((c) => c.ref === 'alpha/test-small')?.outcome).toBe('below-threshold');
    expect(d.candidates.find((c) => c.ref === 'beta/test-mid')?.outcome).toBe('below-threshold');
  });

  it('routes each task in one prompt independently: three tasks, three different models', () => {
    const decisions = routeTasks([simple, medium, complex], { registry, policy: 'balanced' });
    expect(decisions.map((d) => [d.taskId, d.selected])).toEqual([
      ['update-button-color', 'alpha/test-small'],
      ['add-dropdown', 'beta/test-mid'],
      ['verify-auth-bug', 'alpha/test-large'],
    ]);
    // Same decision when routed alone: no prompt-level coupling.
    expect(routeTask(medium, { registry, policy: 'balanced' }).selected).toBe('beta/test-mid');
  });

  it('uses historical success: repeated failures push a cheap model below the threshold', () => {
    const history = new InMemorySuccessHistory();
    for (let i = 0; i < 10; i++) history.record('alpha/test-small', 'low', false);
    const d = routeTask(simple, { registry, policy: 'balanced', history });
    const small = d.candidates.find((c) => c.ref === 'alpha/test-small');
    expect(small?.reliability).toMatchObject({ source: 'prior+history', samples: 10 });
    expect(small?.reliability.value).toBeCloseTo((0.9 * 5) / 15, 10);
    expect(small?.outcome).toBe('below-threshold');
    expect(d.selected).toBe('beta/test-mid');
  });

  it('uses historical success: proven successes lift a model with no prior into selection', () => {
    const noPrior = routingRegistry({
      version: 1,
      providers: [
        { id: 'p', kind: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', local: true },
      ],
      models: [
        {
          provider: 'p',
          modelId: 'fresh',
          capabilities: { tools: true, structuredOutput: true },
          contextWindow: 100_000,
          pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0, source: 'local', asOf: '2026-11-12' },
        },
      ],
    });
    expect(
      routeTask(simple, { registry: noPrior, policy: 'balanced' }).candidates[0]?.exclusions,
    ).toEqual(['unknown-reliability']);
    const history = historyFromAttempts([
      { model: 'p/fresh', tier: 'low', status: 'succeeded' },
      { model: 'p/fresh', tier: 'low', status: 'succeeded' },
      { model: 'p/fresh', tier: 'low', status: 'cancelled' },
      { model: 'p/fresh', tier: 'low', status: 'blocked' },
      { model: 'p/fresh', tier: 'low', status: 'succeeded' },
      { model: null, tier: 'low', status: 'failed' },
    ]);
    const d = routeTask(simple, { registry: noPrior, policy: 'balanced', history });
    expect(d.selected).toBe('p/fresh');
    expect(d.candidates[0]?.reliability).toMatchObject({ value: 1, source: 'history', samples: 3 });
  });

  it('reports an unroutable task instead of silently picking a model below the threshold', () => {
    const strict = customPolicy({ name: 'strict', thresholds: { high: 0.99 } });
    const d = routeTask(complex, { registry, policy: strict });
    expect(d.status).toBe('unroutable');
    expect(d.selected).toBeNull();
    expect(d.reason).toMatch(
      /no model meets the 0.99 reliability threshold for high-complexity work/,
    );
    const lenient = routeTask(complex, {
      registry,
      policy: { ...strict, onNoQualifying: 'most-reliable' },
    });
    expect(lenient.selected).toBe('beta/test-frontier');
    expect(lenient.reason).toMatch(/policy allows the most reliable remaining model/);
  });

  it('blends priors with history as documented', () => {
    expect(estimateReliability(0.8, { successes: 0, attempts: 0 }, 5, 3)).toEqual({
      value: 0.8,
      source: 'prior',
      prior: 0.8,
      samples: 0,
    });
    expect(estimateReliability(null, { successes: 2, attempts: 2 }, 5, 3).source).toBe('unknown');
  });
});

describe('routing explanations (M3-05)', () => {
  it('gives every decision a readable reason and the full candidate list', () => {
    const decisions = routeTasks([simple, medium, complex], { registry, policy: 'balanced' });
    for (const d of decisions) {
      expect(d.reason.length).toBeGreaterThan(40);
      expect(d.candidates.map((c) => c.ref).sort()).toEqual(
        registry
          .models()
          .map((m) => m.ref)
          .sort(),
      );
      for (const c of d.candidates) expect(c.detail).not.toBe('');
      expect(d.candidates.filter((c) => c.outcome === 'selected')).toHaveLength(1);
      expect(d.profile.reasons.length).toBeGreaterThan(0);
    }
    expect(decisions[0]?.reason).toBe(
      'Balanced: lowest estimated cost per success (est. $0.000972 = est. $0.000875 ÷ p≈0.90) among 4 model(s) meeting the 0.75 threshold for low-complexity work; 0 below threshold, 2 excluded.',
    );
  });

  it('writes each decision to the routing log in readable and JSON Lines form', () => {
    const log = new RoutingLog();
    routeTasks([simple, complex], {
      registry,
      policy: 'economy',
      log,
      runId: 'run-42',
      now: () => new Date('2026-11-12T09:30:00Z'),
    });
    const entries = log.entries({ runId: 'run-42' });
    expect(entries.map((e) => [e.taskId, e.selected])).toEqual([
      ['update-button-color', 'alpha/test-small'],
      ['verify-auth-bug', 'alpha/test-large'],
    ]);
    const text = formatRoutingEntry(entries[0] ?? (undefined as never));
    expect(text).toContain('[economy] update-button-color → alpha/test-small');
    expect(text).toContain('listed/test-listed');
    expect(text).toContain('listed only, never called');
    expect(log.toJSONL().split('\n')).toHaveLength(2);
  });
});
