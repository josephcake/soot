import { describe, expect, it } from 'vitest';
import type { AttemptFailure, AttemptRecord, FailureKind } from '@soot/agent-runtime';
import type { AgentResult, AgentSignals } from '@soot/task-graph';
import { makeTask } from '../../model-router/src/test-fixtures.js';
import { DEFAULT_ESCALATION_CONFIG, escalationConfig } from './config.js';
import { backoffDelay, detectTriggers, nextStep } from './decide.js';

/** The `reason` of a fail/stop decision, for regex assertions. */
const reasonOf = (d: object): string =>
  'reason' in d && typeof d.reason === 'string' ? d.reason : '';

const task = makeTask('t'); // planned 2000 + 300 tokens
const config = DEFAULT_ESCALATION_CONFIG;

function record(
  attempt: number,
  opts: {
    model?: string;
    level?: number;
    status?: AgentResult['status'];
    failure?: FailureKind;
    signals?: AgentSignals;
    tokens?: number;
    retryAfterMs?: number;
    provider?: string;
  } = {},
): AttemptRecord {
  const model = opts.model ?? 'alpha/test-small';
  const status = opts.status ?? (opts.failure === 'reported-failure' ? 'failed' : 'succeeded');
  const hasResult =
    opts.failure === undefined ||
    opts.failure === 'reported-failure' ||
    opts.failure === 'rejected';
  const failure: AttemptFailure | null =
    opts.failure === undefined
      ? null
      : {
          kind: opts.failure,
          message: `scripted ${opts.failure}`,
          provider: opts.provider ?? null,
          retryAfterMs: opts.retryAfterMs ?? null,
        };
  return {
    taskId: 't',
    attempt,
    assignment: {
      model,
      reason: 'test',
      escalationLevel: opts.level ?? 0,
      estimatedCostUsd: 0.001,
    },
    result: hasResult
      ? {
          taskId: 't',
          attempt,
          status,
          summary: 's',
          findings: [],
          patch: null,
          evidence: [],
          usage: {
            inputTokens: opts.tokens ?? 1000,
            outputTokens: 0,
            durationMs: 1,
            costUsd: null,
            model,
          },
          ...(opts.signals === undefined ? {} : { signals: opts.signals }),
        }
      : null,
    failure,
    review: null,
    startedAt: 0,
    finishedAt: 1,
  };
}

describe('detectTriggers (M4-01)', () => {
  it('detects each trigger kind from signals, usage, and failure', () => {
    const kinds = (r: AttemptRecord) => detectTriggers(r, task, config).map((t) => t.kind);
    expect(kinds(record(1))).toEqual([]);
    expect(kinds(record(1, { signals: { complexity: 'higher' } }))).toEqual([
      'unexpected-complexity',
    ]);
    expect(kinds(record(1, { signals: { complexity: 'as-expected' } }))).toEqual([]);
    expect(kinds(record(1, { signals: { unmetCriteria: ['x'] } }))).toEqual(['unmet-criteria']);
    expect(kinds(record(1, { signals: { unmetCriteria: [] } }))).toEqual([]);
    expect(kinds(record(1, { signals: { confidence: 0.59 } }))).toEqual(['low-confidence']);
    expect(kinds(record(1, { signals: { confidence: 0.6 } }))).toEqual([]);
    expect(kinds(record(1, { signals: { toolErrors: 3 } }))).toEqual(['tool-errors']);
    expect(kinds(record(1, { signals: { toolErrors: 2 } }))).toEqual([]);
    expect(kinds(record(1, { tokens: 6901 }))).toEqual(['token-blowup']);
    expect(kinds(record(1, { tokens: 6900 }))).toEqual([]);
    expect(kinds(record(1, { failure: 'invalid-output' }))).toEqual(['invalid-output']);
    expect(kinds(record(1, { failure: 'crash' }))).toEqual(['crash']);
  });
});

describe('nextStep (M4-01, M4-03, M4-05)', () => {
  it('accepts a clean success and escalates a low-confidence one', () => {
    expect(nextStep(task, record(1), [], config)).toEqual({ type: 'accept' });
    expect(nextStep(task, record(1, { signals: { confidence: 0.2 } }), [], config)).toMatchObject({
      type: 'escalate',
      triggers: [{ kind: 'low-confidence' }],
    });
  });

  it('replays a rejected success to the same decision as its review', () => {
    const live = record(1, { signals: { unmetCriteria: ['x'] } });
    const replay = {
      ...live,
      failure: { kind: 'rejected' as const, message: 'm', provider: null, retryAfterMs: null },
    };
    expect(nextStep(task, replay, [], config)).toEqual(nextStep(task, live, [], config));
  });

  it('retries once on the same model, then escalates for repeated failure', () => {
    const a1 = record(1, { failure: 'reported-failure' });
    const a2 = record(2, { failure: 'reported-failure' });
    expect(nextStep(task, a1, [], config)).toMatchObject({ type: 'retry-same', delayMs: 0 });
    expect(nextStep(task, a2, [a1], config)).toMatchObject({
      type: 'escalate',
      triggers: [
        { kind: 'repeated-failure', detail: '2 unsuccessful attempts on alpha/test-small' },
      ],
    });
  });

  it('escalates at once on strong triggers (tool errors, token blowup, higher complexity)', () => {
    for (const r of [
      record(1, { failure: 'reported-failure', signals: { toolErrors: 5 } }),
      record(1, { failure: 'reported-failure', tokens: 50_000 }),
      record(1, { failure: 'reported-failure', signals: { complexity: 'higher' } }),
    ]) {
      expect(nextStep(task, r, [], config).type).toBe('escalate');
    }
  });

  it('retries transient failures with retry-after or backoff, then falls back', () => {
    const a1 = record(1, { failure: 'rate-limited', retryAfterMs: 1234 });
    const a2 = record(2, { failure: 'timeout' });
    const a3 = record(3, { failure: 'timeout' });
    expect(nextStep(task, a1, [], config)).toMatchObject({ type: 'retry-same', delayMs: 1234 });
    expect(nextStep(task, a2, [a1], config)).toMatchObject({ type: 'retry-same', delayMs: 2000 });
    expect(nextStep(task, a3, [a1, a2], config)).toMatchObject({
      type: 'fallback',
      provider: 'alpha',
    });
  });

  it('falls back on outage or auth, using the failing provider', () => {
    expect(
      nextStep(task, record(1, { failure: 'unavailable', provider: 'beta' }), [], config),
    ).toMatchObject({
      type: 'fallback',
      provider: 'beta',
    });
    expect(nextStep(task, record(1, { failure: 'auth' }), [], config)).toMatchObject({
      type: 'fallback',
      provider: 'alpha',
    });
  });

  it('fails blocked, cancelled, and rejected attempts without retrying', () => {
    for (const failure of ['cancelled', 'rejected'] as const) {
      expect(nextStep(task, record(1, { failure, status: 'failed' }), [], config).type).toBe(
        'fail',
      );
    }
    {
      const d = nextStep(task, record(1, { failure: 'blocked', status: 'blocked' }), [], config);
      expect(d).toMatchObject({ type: 'fail' });
      expect(reasonOf(d)).toMatch(/another model would not help/);
    }
  });

  it('enforces the attempt and escalation limits', () => {
    const history = [1, 2, 3, 4].map((n) =>
      record(n, { model: `alpha/m${String(n)}`, failure: 'rate-limited' }),
    );
    {
      const d = nextStep(task, record(5, { failure: 'rate-limited' }), history, config);
      expect(d).toMatchObject({ type: 'fail' });
      expect(reasonOf(d)).toMatch(/^attempt limit reached \(5\/5\)/);
    }
    const atCap = record(2, { level: 2, failure: 'reported-failure', signals: { toolErrors: 9 } });
    {
      const d = nextStep(task, atCap, [record(1)], config);
      expect(d).toMatchObject({ type: 'fail' });
      expect(reasonOf(d)).toMatch(/^escalation limit reached \(2\)/);
    }
  });

  it('backoff doubles and is capped', () => {
    const c = escalationConfig({ backoff: { baseDelayMs: 100, maxDelayMs: 350 } });
    expect([1, 2, 3, 4].map((n) => backoffDelay(c, n, null))).toEqual([100, 200, 350, 350]);
    expect(backoffDelay(c, 1, 10_000)).toBe(350);
  });

  it('rejects invalid configuration', () => {
    expect(() => escalationConfig({ maxAttemptsPerTask: 0 })).toThrow();
    expect(() => escalationConfig({ minConfidence: 2 })).toThrow();
  });
});
