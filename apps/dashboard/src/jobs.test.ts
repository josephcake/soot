import { describe, expect, it } from 'vitest';
import { JobStore, MAX_PROMPT_BYTES, type DashboardAgent, type PlanResult } from './jobs.js';

/*
 * The composer's job lifecycle (ADR-038): submit plans and then runs at once (no approve step),
 * one live job per project, idempotent retries, stop while planning or running, and close()
 * aborting what this dashboard started.
 */

const PROJECT = {
  id: 'p_0123456789abcdef',
  label: 'demo-app',
  path: '/tmp/demo-app',
  config: { ok: true, policy: 'balanced', checks: ['test'], error: null },
  planner: { model: null, status: 'not-configured' as const, reason: null, roughCostUsd: null },
  runnerLabel: 'mock (test double)',
};

function fakeAgent(opts: { planMs?: number; runMs?: number; planFails?: boolean } = {}) {
  const calls: string[] = [];
  const stops: string[] = [];
  const agent: DashboardAgent = {
    runner: { kind: 'mock', label: 'mock (test double)' },
    projects: () => [PROJECT],
    keyStatus: () => null,
    plan: async (id, prompt, signal): Promise<PlanResult> => {
      calls.push(`plan ${id} ${prompt}`);
      await new Promise((r) => setTimeout(r, opts.planMs ?? 5));
      if (signal.aborted) return { ok: false, code: 'cancelled', message: 'aborted' };
      if (opts.planFails === true) return { ok: false, code: 'no_fixture', message: 'no fixture' };
      return {
        ok: true,
        preview: { tasks: [{ taskId: 't1' }] },
        start: async (runSignal, onRunStarted) => {
          calls.push('start');
          onRunStarted('run-1');
          const until = Date.now() + (opts.runMs ?? 5);
          while (Date.now() < until && !runSignal.aborted)
            await new Promise((r) => setTimeout(r, 5));
          return runSignal.aborted
            ? { ok: true, status: 'cancelled', message: 'cancelled' }
            : { ok: true, status: 'complete', message: 'soot run run-1 (COMPLETE)' };
        },
      };
    },
    stop: (runId, taskId) => {
      stops.push(`${runId} ${taskId ?? ''}`);
      return Promise.resolve({ ok: true, message: 'ok' });
    },
  };
  return { agent, calls, stops };
}

const settle = async (store: JobStore, id: string) => {
  for (let i = 0; i < 400; i++) {
    const j = store.get(id);
    if (j !== null && j.state !== 'planning' && j.state !== 'running') return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not settle');
};

describe('JobStore', () => {
  it('plans and runs straight away, with no approve step', async () => {
    const { agent, calls } = fakeAgent();
    const store = new JobStore(agent);
    const out = store.submit(PROJECT.id, 'do it', null);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.job.state).toBe('planning');
    const done = await settle(store, out.job.id);
    expect(done).toMatchObject({ state: 'done', runId: 'run-1', result: { status: 'complete' } });
    expect(done.preview).toEqual({ tasks: [{ taskId: 't1' }] });
    expect(calls).toEqual([`plan ${PROJECT.id} do it`, 'start']);
    expect(store.ownsRun('run-1')).toBe(true);
    expect(store.ownsRun('run-2')).toBe(false);
  });

  it('refuses unknown projects, empty or oversized prompts, and a second job in a busy project', () => {
    const { agent } = fakeAgent({ planMs: 50 });
    const store = new JobStore(agent);
    expect(store.submit('p_ffffffffffffffff', 'x', null)).toMatchObject({
      status: 404,
      code: 'unknown_project',
    });
    expect(store.submit('/tmp/demo-app', 'x', null)).toMatchObject({ code: 'unknown_project' });
    expect(store.submit(42, 'x', null)).toMatchObject({ code: 'unknown_project' });
    expect(store.submit(PROJECT.id, '   ', null)).toMatchObject({
      status: 422,
      code: 'prompt_invalid',
    });
    expect(store.submit(PROJECT.id, 'é'.repeat(MAX_PROMPT_BYTES / 2 + 1), null)).toMatchObject({
      status: 413,
      code: 'prompt_too_long',
    });
    expect(store.submit(PROJECT.id, 'one', null).ok).toBe(true);
    expect(store.submit(PROJECT.id, 'two', null)).toMatchObject({
      status: 409,
      code: 'project_busy',
    });
  });

  it('an idempotency key replays the same job instead of planning twice', async () => {
    const { agent, calls } = fakeAgent();
    const store = new JobStore(agent);
    const a = store.submit(PROJECT.id, 'p', 'key-12345678');
    const b = store.submit(PROJECT.id, 'p', 'key-12345678');
    expect(a.ok && b.ok && a.job.id === b.job.id).toBe(true);
    expect(b.ok && b.replay).toBe(true);
    if (a.ok) await settle(store, a.job.id);
    expect(calls.filter((c) => c.startsWith('plan'))).toHaveLength(1);
  });

  it('stop while planning: nothing runs', async () => {
    const { agent, calls } = fakeAgent({ planMs: 40 });
    const store = new JobStore(agent);
    const out = store.submit(PROJECT.id, 'p', null);
    if (!out.ok) throw new Error('submit failed');
    await store.cancel(out.job.id);
    const j = await settle(store, out.job.id);
    expect(j.state).toBe('cancelled');
    expect(j.runId).toBeNull();
    expect(calls).not.toContain('start');
  });

  it('stop while running goes through the run stop API', async () => {
    const { agent, stops } = fakeAgent({ runMs: 2000 });
    const store = new JobStore(agent);
    const out = store.submit(PROJECT.id, 'p', null);
    if (!out.ok) throw new Error('submit failed');
    for (let i = 0; i < 200 && store.get(out.job.id)?.runId == null; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(store.get(out.job.id)?.state).toBe('running');
    const after = await store.cancel(out.job.id);
    expect(after?.stopRequested).toBe(true);
    expect(stops).toEqual(['run-1 ']);
    // The fake ignores stop files; close() aborts the in-process run.
    await store.close();
    expect((await settle(store, out.job.id)).state).toBe('cancelled');
  });

  it('a planning failure is a failed job with the code and message', async () => {
    const { agent } = fakeAgent({ planFails: true });
    const store = new JobStore(agent);
    const out = store.submit(PROJECT.id, 'p', null);
    if (!out.ok) throw new Error('submit failed');
    expect(await settle(store, out.job.id)).toMatchObject({
      state: 'failed',
      error: { code: 'no_fixture', message: 'no fixture' },
    });
  });

  it('close() aborts live jobs and refuses new ones', async () => {
    const { agent } = fakeAgent({ runMs: 5000 });
    const store = new JobStore(agent);
    const out = store.submit(PROJECT.id, 'p', null);
    if (!out.ok) throw new Error('submit failed');
    await store.close(2000);
    expect(store.get(out.job.id)?.state).toBe('cancelled');
    expect(store.submit(PROJECT.id, 'again', null)).toMatchObject({ status: 503, code: 'closing' });
  });
});
