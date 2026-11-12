/**
 * Milestone 3 exit criteria, end to end, with fixtures only (no network, no keys, no model
 * calls): spec prompt → fixture decomposer → per-task routing against a fictional registry →
 * explanation log → routed estimates in cost records.
 *
 *  EC1 simple tasks are assigned to inexpensive capable models
 *  EC2 complex tasks can be assigned to stronger models
 *  EC3 model selection is made independently per task
 *  EC4 routing decisions are logged and explainable
 */
import { describe, expect, it } from 'vitest';
import { ProviderHealth } from '@soot/model-registry';
import { evaluateTask, routeTasks, type RoutingDecision } from '@soot/model-router';
import {
  RoutingLog,
  createCostRecord,
  formatRoutingEntry,
  summarizeCosts,
} from '@soot/observability';
import { FixtureDecomposer, SPEC_FIXTURES, createPromptIntake } from '@soot/planner';
import type { Task } from '@soot/task-graph';
import { routingRegistry } from '../packages/model-router/src/test-fixtures.js';

const TEST_1 = 'Change the page title to HELLO WORLD and update the primary button to purple.';
const TEST_2 =
  'Change the button color to purple, add a reusable dropdown component, and investigate the previous authentication bug.';
const TEST_4 =
  'Implement a new feature, add tests, and review the implementation for security issues.';

async function decompose(prompt: string): Promise<Task[]> {
  const intake = createPromptIntake({ prompt, context: { name: 'demo-app' } });
  const { tasks } = await new FixtureDecomposer(SPEC_FIXTURES).decompose(intake);
  return [...tasks];
}

const registry = routingRegistry();
const selected = (ds: readonly RoutingDecision[]) =>
  Object.fromEntries(ds.map((d) => [d.taskId, d.selected]));
const priceOf = (ref: string | null) => {
  const pricing = ref === null ? null : registry.get(ref)?.pricing;
  return pricing == null ? Infinity : pricing.inputPerMTokUsd + pricing.outputPerMTokUsd;
};

describe('Milestone 3 end to end: fixture prompts → per-task routing', () => {
  it('M3-01: classifies every fixture task with recorded reasons', async () => {
    const tasks = (await decompose(TEST_2)).concat(await decompose(TEST_4));
    const profiles = tasks.map((t) => evaluateTask(t));
    expect(
      Object.fromEntries(profiles.map((p) => [p.taskId, [p.complexity, p.reliabilityTier]])),
    ).toEqual({
      'update-button-color': ['low', 'low'],
      'add-dropdown-component': ['medium', 'medium'],
      'verify-auth-bug': ['high', 'high'],
      'implement-feature': ['medium', 'medium'],
      'add-feature-tests': ['low', 'low'],
      'security-review': ['high', 'high'],
    });
    for (const p of profiles) expect(p.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('EC1: simple tasks go to the inexpensive capable model (spec §17 Test 1)', async () => {
    const decisions = routeTasks(await decompose(TEST_1), { registry, policy: 'balanced' });
    expect(selected(decisions)).toEqual({
      'update-page-title': 'alpha/test-small',
      'update-button-color': 'alpha/test-small',
    });
    for (const d of decisions) {
      const eligiblePrices = d.candidates
        .filter((c) => c.outcome !== 'excluded')
        .map((c) => priceOf(c.ref));
      expect(priceOf(d.selected)).toBe(Math.min(...eligiblePrices));
    }
  });

  it('EC2 + EC3: mixed complexity gets different models per task (spec §17 Test 2)', async () => {
    const decisions = routeTasks(await decompose(TEST_2), { registry, policy: 'balanced' });
    expect(selected(decisions)).toEqual({
      'update-button-color': 'alpha/test-small',
      'add-dropdown-component': 'beta/test-mid',
      'verify-auth-bug': 'alpha/test-large',
    });
    expect(new Set(decisions.map((d) => d.selected)).size).toBe(3);
    const [cheap, , strong] = decisions;
    expect(priceOf(strong?.selected ?? null)).toBeGreaterThan(priceOf(cheap?.selected ?? null));
  });

  it('EC3: cross-provider assignment when beneficial; security review needs a reasoning model (Test 4)', async () => {
    const decisions = routeTasks(await decompose(TEST_4), { registry, policy: 'balanced' });
    expect(selected(decisions)).toEqual({
      'implement-feature': 'beta/test-mid',
      'add-feature-tests': 'alpha/test-small',
      'security-review': 'alpha/test-large',
    });
    expect(new Set(decisions.map((d) => d.selected?.split('/')[0])).size).toBe(2);
  });

  it('EC4 + M3-06: decisions are logged, explained, and policy-sensitive', async () => {
    const tasks = await decompose(TEST_2);
    const log = new RoutingLog();
    const byPolicy = Object.fromEntries(
      (['economy', 'balanced', 'quality'] as const).map((policy) => [
        policy,
        selected(routeTasks(tasks, { registry, policy, log, runId: policy })),
      ]),
    );
    expect(byPolicy.economy?.['add-dropdown-component']).toBe('alpha/test-small');
    expect(byPolicy.balanced?.['add-dropdown-component']).toBe('beta/test-mid');
    expect(byPolicy.quality?.['add-dropdown-component']).toBe('beta/test-frontier');

    expect(log.entries()).toHaveLength(9);
    for (const entry of log.entries()) {
      expect(entry.reason).toMatch(/threshold/);
      expect(entry.candidates).toHaveLength(registry.models().length);
      expect(entry.candidates.filter((c) => c.outcome === 'selected')).toHaveLength(1);
    }
    const text = formatRoutingEntry(
      log.entries({ runId: 'balanced', taskId: 'verify-auth-bug' })[0] ?? (undefined as never),
    );
    expect(text.split('\n')[0]).toBe(
      '[balanced] verify-auth-bug → alpha/test-large: Balanced: lowest estimated cost per success (est. $0.122222 = est. $0.110000 ÷ p≈0.90) among 2 model(s) meeting the 0.90 threshold for high-complexity work; 2 below threshold, 2 excluded.',
    );
  });

  it('routed estimates flow into cost records as estimates; actuals stay empty', async () => {
    const tasks = await decompose(TEST_2);
    const decisions = routeTasks(tasks, { registry, policy: 'balanced' });
    const records = tasks.map((t, i) =>
      createCostRecord({
        ...t,
        estimate: { ...t.estimate, costUsd: decisions[i]?.estimate?.costUsd ?? null },
      }),
    );
    const summary = summarizeCosts(records);
    expect(summary.estimated.tasksWithoutCostEstimate).toEqual([]);
    expect(summary.estimated.costUsd).toBeCloseTo(0.001 + 0.016 + 0.11, 9); // 2500·0.25+300·1.25, 6000·1+2500·4, 12000·5+2000·25 (per M);
    expect(summary.actual.costUsd).toBe(0);
    expect(summary.actual.attempts).toBe(0);
  });

  it('never selects DeepSeek and reroutes around an unavailable provider', async () => {
    const tasks = await decompose(TEST_2);
    const health = new ProviderHealth();
    health.markUnavailable('alpha', 'outage');
    for (const policy of ['economy', 'balanced', 'quality'] as const) {
      for (const d of routeTasks(tasks, { registry, policy, health })) {
        expect(d.selected).not.toBe('deepseek/test-ds');
        expect(d.selected?.startsWith('alpha/') ?? false).toBe(false);
      }
    }
  });
});
