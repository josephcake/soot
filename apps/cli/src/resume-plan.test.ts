import { describe, expect, it } from 'vitest';
import type { PersistedAttempt, PersistedRun, PersistedVerification } from '@soot/context-manager';
import type { Task } from '@soot/task-graph';
import { fingerprintChanges, holdReasonOf, planResume } from './resume-plan.js';

/* The per-task resume rules (ADR-054), without a repository. */

const task = (id: string): Task => ({
  id,
  title: id,
  instructions: id,
  acceptanceCriteria: [id],
  requiredCapabilities: ['code-edit'],
  complexity: 'low',
  estimate: { inputTokens: 1, outputTokens: 1, costUsd: null },
  files: { read: [], write: [] },
  dependsOn: [],
});

const attempt = (
  taskId: string,
  n: number,
  state: PersistedAttempt['state'],
  extra: Partial<PersistedAttempt> = {},
): PersistedAttempt => ({
  taskId,
  attempt: n,
  state,
  startedAt: n === 0 ? null : `2026-11-14T00:00:0${String(n)}.000Z`,
  finishedAt: state === 'running' ? null : `2026-11-14T00:00:0${String(n)}.500Z`,
  result: null,
  error: null,
  assignment: null,
  failure: null,
  review: null,
  session: 1,
  ...extra,
});

const succeededResult = (taskId: string) =>
  ({ taskId, attempt: 1, status: 'succeeded', summary: 'ok' }) as unknown as NonNullable<
    PersistedAttempt['result']
  >;

const runOf = (attempts: PersistedAttempt[], ids: string[]): PersistedRun => ({
  runId: 'r',
  createdAt: '',
  originalPrompt: '',
  promptSha256: '',
  graphRevision: 1,
  tasks: ids.map(task),
  attempts,
  completed: new Map(),
  attemptCounts: new Map(),
  attemptRecords: new Map(),
});

const verification = (taskId: string, n: number): PersistedVerification => ({
  taskId,
  attempt: n,
  model: null,
  verdict: 'verified',
  reason: 'ok',
  branch: `soot/r/${taskId}`,
  base: 'b',
  commit: 'c'.repeat(40),
  files: [],
  checks: [],
});

const plan = (
  attempts: PersistedAttempt[],
  ids: string[],
  o: {
    verifications?: PersistedVerification[];
    cancelled?: string[];
    interrupted?: string[];
    retryBlocked?: boolean;
  } = {},
) =>
  planResume({
    run: runOf(attempts, ids),
    verifications: o.verifications ?? [],
    cancelledByUser: new Set(o.cancelled ?? []),
    interrupted: new Set(o.interrupted ?? []),
    retryBlocked: o.retryBlocked ?? false,
  });

const actions = (d: ReturnType<typeof plan>) => d.map((x) => [x.taskId, x.action, x.hold]);

describe('planResume (ADR-054 state rules)', () => {
  it('keeps done work with a persisted verdict; re-runs it without one', () => {
    const attempts = [
      attempt('a', 1, 'succeeded', { result: succeededResult('a') }),
      attempt('b', 1, 'succeeded', { result: succeededResult('b') }),
    ];
    const d = plan(attempts, ['a', 'b'], { verifications: [verification('a', 1)] });
    expect(actions(d)).toEqual([
      ['a', 'keep', null],
      ['b', 'rerun', null],
    ]);
    expect(d[1]?.reason).toMatch(/no persisted verdict/);
  });

  it('a verdict for an older attempt does not keep a newer success', () => {
    const attempts = [
      attempt('a', 1, 'retried'),
      attempt('a', 2, 'succeeded', { result: succeededResult('a') }),
    ];
    expect(actions(plan(attempts, ['a'], { verifications: [verification('a', 1)] }))).toEqual([
      ['a', 'rerun', null],
    ]);
  });

  it('re-runs pending, interrupted, retry-waiting, skipped and run-stop-cancelled tasks', () => {
    const attempts = [
      attempt('i', 1, 'interrupted'),
      attempt('w', 1, 'retried'),
      attempt('s', 0, 'skipped'),
      attempt('c', 1, 'cancelled'),
    ];
    const d = plan(attempts, ['p', 'i', 'w', 's', 'c'], { interrupted: ['i'] });
    expect(d.map((x) => x.action)).toEqual(['rerun', 'rerun', 'rerun', 'rerun', 'rerun']);
    expect(d[1]?.reason).toMatch(/stale lease reclaimed/);
    expect(d[0]).toMatchObject({ previous: 'pending', attempt: null });
  });

  it('a task a person cancelled stays cancelled, even with --retry-blocked', () => {
    const attempts = [attempt('c', 1, 'cancelled')];
    for (const retryBlocked of [false, true]) {
      expect(actions(plan(attempts, ['c'], { cancelled: ['c'], retryBlocked }))).toEqual([
        ['c', 'hold', 'cancelled-by-user'],
      ]);
    }
  });

  it('blocked, budget-stopped and escalation-exhausted tasks are held unless --retry-blocked', () => {
    const attempts = [
      attempt('signin', 1, 'failed', {
        failure: {
          kind: 'blocked',
          message: 'agent reported blocked',
          provider: null,
          retryAfterMs: null,
        },
        result: {
          summary: 'soot never signs in; sign in to Claude Code yourself',
          status: 'blocked',
        } as never,
      }),
      attempt('approval', 1, 'failed', {
        failure: {
          kind: 'blocked',
          message: 'agent reported blocked',
          provider: null,
          retryAfterMs: null,
        },
        result: {
          summary: '[soot] refused: deleting x needs approval; unavailable',
          status: 'blocked',
        } as never,
      }),
      attempt('input', 1, 'failed', {
        failure: {
          kind: 'blocked',
          message: 'agent reported blocked',
          provider: null,
          retryAfterMs: null,
        },
      }),
      attempt('budget', 1, 'failed', {
        error: 'run budget exhausted: spent $1 + next attempt $1 > $1',
      }),
      attempt('esc', 2, 'failed', { error: 'no stronger model available' }),
    ];
    const ids = ['signin', 'approval', 'input', 'budget', 'esc'];
    expect(actions(plan(attempts, ids))).toEqual([
      ['signin', 'hold', 'sign-in'],
      ['approval', 'hold', 'approval'],
      ['input', 'hold', 'blocked'],
      ['budget', 'hold', 'budget'],
      ['esc', 'hold', 'escalation'],
    ]);
    const retried = plan(attempts, ids, { retryBlocked: true });
    expect(retried.map((x) => x.action)).toEqual(['rerun', 'rerun', 'rerun', 'rerun', 'rerun']);
    expect(retried[0]?.reason).toMatch(/--retry-blocked/);
  });

  it('holdReasonOf needs a blocked failure for sign-in/approval wording', () => {
    expect(
      holdReasonOf(attempt('x', 1, 'failed', { error: 'approval wording but a plain failure' })),
    ).toBe('escalation');
  });
});

describe('fingerprintChanges', () => {
  it('lists the parts that differ; a run without a fingerprint is one change', () => {
    expect(fingerprintChanges({ a: '1', b: '2' }, { a: '1', b: '3', c: '4' })).toEqual([
      { part: 'b', before: '2', after: '3' },
      { part: 'c', before: null, after: '4' },
    ]);
    expect(fingerprintChanges({ a: '1' }, { a: '1' })).toEqual([]);
    expect(fingerprintChanges(null, { a: '1' })).toHaveLength(1);
  });
});
