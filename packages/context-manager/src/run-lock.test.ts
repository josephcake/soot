import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTaskGraph, type Task } from '@soot/task-graph';
import {
  STATE_DB_FILE,
  latestAttempt,
  lockState,
  openExecutionStore,
  type PersistedAttempt,
  type RunLockRow,
} from './index.js';

/* Run lock, sessions and resume persistence (ADR-054). */

const task = (id: string): Task => ({
  id,
  title: `Task ${id}`,
  instructions: `Do ${id}.`,
  acceptanceCriteria: [`${id} is done`],
  requiredCapabilities: ['code-edit'],
  complexity: 'low',
  estimate: { inputTokens: 100, outputTokens: 10, costUsd: null },
  files: { read: [], write: [] },
  dependsOn: [],
});

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'soot-lock-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const intake = { originalPrompt: 'p', promptSha256: 'a'.repeat(64) };

const row = (over: Partial<RunLockRow> = {}): RunLockRow => ({
  runId: 'r',
  owner: 'o',
  pid: 4242,
  host: 'box',
  session: 1,
  acquiredAt: '2026-11-14T00:00:00.000Z',
  heartbeatMs: 1_000_000,
  ...over,
});
const check = (over: { now?: number; host?: string; alive?: boolean } = {}) => ({
  now: over.now ?? 1_000_000 + 5_000,
  ttlMs: 60_000,
  host: over.host ?? 'box',
  isAlive: () => over.alive ?? true,
});

describe('lockState (ADR-054)', () => {
  it('no row is free', () => {
    expect(lockState(null, check()).state).toBe('free');
  });
  it('same host, pid alive, fresh heartbeat: live (never stolen)', () => {
    expect(lockState(row(), check()).state).toBe('live');
  });
  it('same host, pid gone: stale at once, even with a fresh heartbeat (crash)', () => {
    const s = lockState(row(), check({ alive: false }));
    expect(s).toMatchObject({ state: 'stale' });
    expect(s.state === 'stale' && s.reason).toMatch(/pid 4242 is not running/);
  });
  it('same host, pid alive but lease expired: stale (reused pid or frozen owner)', () => {
    expect(lockState(row(), check({ now: 1_000_000 + 60_001 })).state).toBe('stale');
    expect(lockState(row(), check({ now: 1_000_000 + 60_000 })).state).toBe('live');
  });
  it('other host: the lease alone decides (pid is never probed)', () => {
    const probed: number[] = [];
    const c = {
      ...check({ host: 'other' }),
      isAlive: (pid: number) => {
        probed.push(pid);
        return false;
      },
    };
    expect(lockState(row(), c).state).toBe('live');
    expect(lockState(row(), { ...c, now: 1_000_000 + 60_001 }).state).toBe('stale');
    expect(probed).toEqual([]);
  });
});

describe('run sessions and the run lock in soot.sqlite (ADR-054)', () => {
  const setup = () => {
    const dataDir = tempDir();
    const store = openExecutionStore({ dataDir });
    const runId = store.createRun({ runId: 'r1', intake, graph: buildTaskGraph([task('a')]) });
    return { dataDir, store, runId };
  };
  const begin = (
    store: ReturnType<typeof openExecutionStore>,
    o: { alive?: boolean; pid?: number; kind?: 'run' | 'resume' } = {},
  ) =>
    store.beginSession('r1', {
      kind: o.kind ?? 'run',
      repoRoot: '/repo',
      fingerprint: { config: 'c1' },
      agent: { kind: 'mock', script: '/s.json' },
      ttlMs: 60_000,
      pid: o.pid ?? 1111,
      host: 'box',
      isAlive: () => o.alive ?? true,
    });

  it('a second owner is refused while the first is live; sessions are numbered', () => {
    const { store } = setup();
    const first = begin(store);
    expect(first).toMatchObject({ ok: true, session: 1, reclaimed: null });
    const second = begin(store, { kind: 'resume', pid: 2222 });
    expect(second.ok).toBe(false);
    expect(!second.ok && second.lock.reason).toMatch(/pid 1111/);
    // A refused begin writes no session row.
    expect(store.sessions('r1').map((s) => s.session)).toEqual([1]);
    store.close();
  });

  it("a dead owner's lock is reclaimed by the next session, and reported", () => {
    const { store } = setup();
    begin(store);
    const next = begin(store, { kind: 'resume', pid: 2222, alive: false });
    expect(next).toMatchObject({ ok: true, session: 2 });
    expect(next.ok && next.reclaimed?.holder.pid).toBe(1111);
    expect(store.runLock('r1')).toMatchObject({ pid: 2222, session: 2 });
    expect(store.sessions('r1').map((s) => [s.session, s.kind, s.status])).toEqual([
      [1, 'run', null],
      [2, 'resume', null],
    ]);
    store.close();
  });

  it('heartbeats fail once the lock was taken over; release only drops the own lock', () => {
    const { store } = setup();
    const first = begin(store);
    if (!first.ok) throw new Error('unreachable');
    expect(store.heartbeatRunLock('r1', first.owner)).toBe(true);
    const second = begin(store, { pid: 2222, alive: false });
    if (!second.ok) throw new Error('unreachable');
    expect(store.heartbeatRunLock('r1', first.owner)).toBe(false);
    store.releaseRunLock('r1', first.owner);
    expect(store.runLock('r1')?.owner).toBe(second.owner);
    store.releaseRunLock('r1', second.owner);
    expect(store.runLock('r1')).toBeNull();
    store.close();
  });

  it('two processes racing for a stale lock: exactly one wins (BEGIN IMMEDIATE)', () => {
    const { dataDir, store } = setup();
    begin(store); // owner 1111, about to be seen as dead
    const other = openExecutionStore({ dataDir });
    const a = begin(store, { pid: 3333, alive: false });
    // The second process now sees 3333's fresh lock; 3333 is "alive" to it.
    const b = other.beginSession('r1', {
      kind: 'resume',
      repoRoot: '/repo',
      fingerprint: {},
      agent: null,
      ttlMs: 60_000,
      pid: 4444,
      host: 'box',
      isAlive: (pid) => pid === 3333,
    });
    expect([a.ok, b.ok]).toEqual([true, false]);
    other.close();
    store.close();
  });

  it('persists session base, decisions, status, verifications, cancellations and attempt sessions', () => {
    const { store } = setup();
    const s = begin(store);
    if (!s.ok) throw new Error('unreachable');
    store.setSessionBase('r1', s.session, 'abc');
    store.setSessionDecisions('r1', s.session, [{ taskId: 'a', action: 'keep' }]);
    const journal = store.journal('r1', s.session);
    journal.taskStarted({ taskId: 'a', attempt: 1, at: 0 });
    store.finishSession('r1', s.session, 'incomplete');
    store.saveVerification('r1', {
      taskId: 'a',
      attempt: 1,
      model: null,
      verdict: 'verified',
      reason: 'ok',
      branch: 'soot/r1/a',
      base: 'abc',
      commit: 'def',
      files: [{ path: 'x', status: 'modified' }],
      checks: [],
    });
    store.recordTaskCancellation('r1', 'a');
    const [session] = store.sessions('r1');
    expect(session).toMatchObject({
      baseCommit: 'abc',
      status: 'incomplete',
      decisions: [{ taskId: 'a', action: 'keep' }],
      fingerprint: { config: 'c1' },
      agent: { kind: 'mock', script: '/s.json' },
    });
    expect(store.verifications('r1').map((v) => v.commit)).toEqual(['def']);
    expect(store.taskCancellations('r1')).toEqual(['a']);
    expect(store.loadRun('r1').attempts[0]?.session).toBe(1);
    store.close();
  });

  it('migrates a v5 database to v7 in place (old attempts have no session)', () => {
    const { dataDir, store } = setup();
    store.journal('r1').taskStarted({ taskId: 'a', attempt: 1, at: 0 });
    store.close();
    const db = new DatabaseSync(join(dataDir, STATE_DB_FILE));
    db.exec(`DROP TABLE run_sessions; DROP TABLE run_locks; DROP TABLE task_verifications;
      DROP TABLE task_cancellations; ALTER TABLE task_attempts DROP COLUMN session;
      UPDATE meta SET value = '5' WHERE key = 'schema_version';`);
    db.close();
    const migrated = openExecutionStore({ dataDir });
    expect(migrated.loadRun('r1').attempts[0]?.session).toBeNull();
    expect(migrated.sessions('r1')).toEqual([]);
    migrated.close();
  });
});

describe('latestAttempt', () => {
  const a = (
    attempt: number,
    state: string,
    finishedAt: string | null,
    startedAt: string | null = null,
  ) => ({ taskId: 't', attempt, state, finishedAt, startedAt }) as unknown as PersistedAttempt;
  it('the newest numbered attempt, unless a later attempt-0 row (skipped again) is newer', () => {
    expect(latestAttempt([a(1, 'failed', '1'), a(2, 'succeeded', '2')], 't')?.attempt).toBe(2);
    expect(latestAttempt([a(1, 'cancelled', '1'), a(0, 'skipped', '3')], 't')?.state).toBe(
      'skipped',
    );
    expect(latestAttempt([a(0, 'skipped', '1'), a(1, 'running', null, '2')], 't')?.state).toBe(
      'running',
    );
    expect(latestAttempt([], 't')).toBeUndefined();
  });
});
