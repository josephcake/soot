import { describe, expect, it } from 'vitest';
import type { AttemptRecord, PlanContext } from '@soot/agent-runtime';
import { ProviderHealth } from '@soot/model-registry';
import { RoutingLog } from '@soot/observability';
import { ROUTING_CONFIG, makeTask, routingRegistry } from '../../model-router/src/test-fixtures.js';
import { AdaptiveSupervisor } from './supervisor.js';

/** The `reason` of a fail/stop decision, for regex assertions. */
const reasonOf = (d: object): string =>
  'reason' in d && typeof d.reason === 'string' ? d.reason : '';

const registry = routingRegistry();
const task = makeTask('t');

function failed(
  attempt: number,
  model: string,
  kind: 'rate-limited' | 'reported-failure',
  level = 0,
): AttemptRecord {
  return {
    taskId: 't',
    attempt,
    assignment: { model, reason: 'r', escalationLevel: level, estimatedCostUsd: 0.001 },
    result: null,
    failure: { kind, message: kind, provider: null, retryAfterMs: null },
    review: { action: 'retry', delayMs: 0, note: 'n' },
    startedAt: null,
    finishedAt: null,
  };
}
const ctx = (history: AttemptRecord[] = []): PlanContext => ({
  task,
  attempt: history.length + 1,
  history,
  dependencyResults: [],
});

describe('AdaptiveSupervisor', () => {
  it('routes the first attempt with model-router and logs the routing decision', () => {
    const log = new RoutingLog();
    const s = new AdaptiveSupervisor({
      registry,
      policy: 'balanced',
      routingLog: log,
      runId: 'r1',
    });
    expect(s.plan(ctx())).toMatchObject({
      action: 'run',
      assignment: { model: 'alpha/test-small', escalationLevel: 0 },
    });
    expect(log.entries()).toHaveLength(1);
  });

  it('turns a retry-same into a fallback when the provider has become unavailable', () => {
    const health = new ProviderHealth();
    const s = new AdaptiveSupervisor({ registry, policy: 'balanced', health });
    const history = [failed(1, 'alpha/test-small', 'rate-limited')];
    expect(s.plan(ctx(history))).toMatchObject({ assignment: { model: 'alpha/test-small' } });
    health.markUnavailable('alpha', 'outage');
    expect(s.plan(ctx(history))).toMatchObject({ assignment: { model: 'beta/test-mid' } });
    expect(s.events.at(-1)?.type).toBe('fallback');
  });

  it('escalates to an untried, strictly more reliable model and raises the level', () => {
    const s = new AdaptiveSupervisor({ registry, policy: 'economy' });
    const history = [
      failed(1, 'alpha/test-small', 'reported-failure'),
      failed(2, 'alpha/test-small', 'reported-failure'),
    ];
    const decision = s.plan(ctx(history));
    expect(decision).toMatchObject({ action: 'run', assignment: { escalationLevel: 1 } });
    expect(decision.action === 'run' ? decision.assignment.model : null).not.toBe(
      'alpha/test-small',
    );
  });

  it('stops before an attempt that would exceed the task budget; unpriced models are never assigned', () => {
    const tight = new AdaptiveSupervisor({
      registry,
      policy: 'balanced',
      config: { taskBudgetUsd: 0.0001 },
    });
    {
      const d = tight.plan(ctx());
      expect(d).toMatchObject({ action: 'stop' });
      expect(reasonOf(d)).toMatch(
        /^task budget exhausted: spent \$0\.000000 \+ next attempt \$0\.000875/,
      );
    }
    const unpriced = new AdaptiveSupervisor({
      registry: routingRegistry({
        ...ROUTING_CONFIG,
        models: ROUTING_CONFIG.models.map((m) => ({ ...m, pricing: null })),
      }),
      policy: 'balanced',
      config: { taskBudgetUsd: 1 },
    });
    // The router excludes unpriced models, so spend can always be estimated before an attempt.
    {
      const d = unpriced.plan(ctx());
      expect(d).toMatchObject({ action: 'stop' });
      expect(reasonOf(d)).toMatch(/^unroutable: /);
    }
  });

  it('never assigns DeepSeek even when it is the most reliable listed model', () => {
    const s = new AdaptiveSupervisor({ registry, policy: 'quality' });
    const history = [1, 2, 3, 4].map((n) => failed(n, 'beta/test-frontier', 'reported-failure', 2));
    void s.plan(ctx(history));
    expect(s.plan(ctx()).action === 'run').toBe(true);
    expect(s.events.some((e) => e.model?.startsWith('deepseek/') === true)).toBe(false);
  });
});
