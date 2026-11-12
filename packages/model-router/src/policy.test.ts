/** M3-06: Economy / Balanced / Quality / Custom route the same tasks differently. */
import { describe, expect, it } from 'vitest';
import { BALANCED, ECONOMY, QUALITY, customPolicy, resolvePolicy } from './policy.js';
import { routeTasks } from './router.js';
import { makeTask, routingRegistry } from './test-fixtures.js';

const registry = routingRegistry();
const tasks = [
  makeTask('update-button-color', { requiredCapabilities: ['code-edit', 'css'] }),
  makeTask('add-dropdown', {
    requiredCapabilities: ['code-edit', 'react', 'testing'],
    complexity: 'medium',
    estimate: { inputTokens: 6000, outputTokens: 2500, costUsd: null },
  }),
  makeTask('verify-auth-bug', {
    requiredCapabilities: ['code-read', 'debugging', 'testing'],
    complexity: 'high',
    estimate: { inputTokens: 12_000, outputTokens: 2000, costUsd: null },
  }),
];
const routeAll = (policy: Parameters<typeof routeTasks>[1]['policy']) =>
  Object.fromEntries(routeTasks(tasks, { registry, policy }).map((d) => [d.taskId, d.selected]));

describe('routing policies (M3-06)', () => {
  it('the same task set routes differently under each built-in policy', () => {
    const economy = routeAll('economy');
    const balanced = routeAll('balanced');
    const quality = routeAll('quality');
    expect(economy).toEqual({
      'update-button-color': 'alpha/test-small',
      'add-dropdown': 'alpha/test-small',
      'verify-auth-bug': 'alpha/test-large',
    });
    expect(balanced).toEqual({
      'update-button-color': 'alpha/test-small',
      'add-dropdown': 'beta/test-mid',
      'verify-auth-bug': 'alpha/test-large',
    });
    expect(quality).toEqual({
      'update-button-color': 'beta/test-frontier',
      'add-dropdown': 'beta/test-frontier',
      'verify-auth-bug': 'beta/test-frontier',
    });
    expect(
      new Set([JSON.stringify(economy), JSON.stringify(balanced), JSON.stringify(quality)]).size,
    ).toBe(3);
  });

  it('total estimated cost orders Economy ≤ Balanced ≤ Quality for this task set', () => {
    const total = (policy: 'economy' | 'balanced' | 'quality') =>
      routeTasks(tasks, { registry, policy }).reduce(
        (sum, d) => sum + (d.estimate?.costUsd ?? 0),
        0,
      );
    expect(total('economy')).toBeLessThanOrEqual(total('balanced'));
    expect(total('balanced')).toBeLessThan(total('quality'));
  });

  it('custom: user constraints (provider allow-list, local-only, cost cap) change routing', () => {
    expect(routeAll(customPolicy({ providers: ['beta'] }))).toEqual({
      'update-button-color': 'beta/test-mid',
      'add-dropdown': 'beta/test-mid',
      'verify-auth-bug': 'beta/test-frontier',
    });
    expect(
      routeAll(customPolicy({ excludeProviders: ['alpha'], extends: 'economy' }))[
        'verify-auth-bug'
      ],
    ).toBe('beta/test-frontier');
    const capped = routeTasks(tasks, {
      registry,
      policy: customPolicy({ maxEstimatedCostUsd: 0.05 }),
    });
    expect(capped.map((d) => d.status)).toEqual(['routed', 'routed', 'unroutable']);
    // Local-only: the local model's structured output is unknown, so nothing qualifies.
    const local = routeTasks(tasks, { registry, policy: customPolicy({ localOnly: true }) });
    expect(local.every((d) => d.status === 'unroutable')).toBe(true);
  });

  it('custom: thresholds and objective override the preset; invalid values are rejected', () => {
    const p = customPolicy({
      name: 'my-team',
      extends: 'quality',
      objective: 'cheapest',
      thresholds: { low: 0.5 },
    });
    expect(p).toMatchObject({
      name: 'my-team',
      objective: 'cheapest',
      thresholds: { low: 0.5, medium: 0.9, high: 0.95 },
    });
    expect(routeAll(p)['update-button-color']).toBe('alpha/test-small');
    expect(() => customPolicy({ thresholds: { low: 1.5 } })).toThrow();
    expect(() => resolvePolicy({ ...BALANCED, objective: 'random' as never })).toThrow();
  });

  it('presets are the documented values', () => {
    expect([ECONOMY.objective, BALANCED.objective, QUALITY.objective]).toEqual([
      'cheapest',
      'expected-cost',
      'most-reliable',
    ]);
    expect(ECONOMY.thresholds.high).toBeLessThan(BALANCED.thresholds.high);
    expect(BALANCED.thresholds.high).toBeLessThan(QUALITY.thresholds.high);
  });
});
