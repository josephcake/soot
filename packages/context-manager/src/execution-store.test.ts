import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAgentRunner, runTaskGraph } from '@soot/agent-runtime';
import { buildTaskGraph, type Task } from '@soot/task-graph';
import { STATE_DB_FILE, openExecutionStore } from './index.js';

const task = (id: string, dependsOn: string[] = []): Task => ({
  id,
  title: `Task ${id}`,
  instructions: `Do ${id}.`,
  acceptanceCriteria: [`${id} is done`],
  requiredCapabilities: ['code-edit'],
  complexity: 'low',
  estimate: { inputTokens: 100, outputTokens: 10, costUsd: null },
  files: { read: [], write: [] },
  dependsOn,
});

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'soot-store-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const intake = { originalPrompt: '  Fix it 💜\r\n', promptSha256: 'a'.repeat(64) };

describe('execution store (M1-07)', () => {
  it('creates the database inside the data dir and round-trips the prompt exactly', () => {
    const dataDir = join(tempDir(), 'nested', 'state');
    const store = openExecutionStore({ dataDir });
    expect(store.path).toBe(join(dataDir, STATE_DB_FILE));
    const graph = buildTaskGraph([task('a'), task('b', ['a'])]);
    const runId = store.createRun({ intake, graph });
    store.close();

    const reopened = openExecutionStore({ dataDir });
    const run = reopened.loadRun(runId);
    expect(run.originalPrompt).toBe(intake.originalPrompt);
    expect(run.tasks).toEqual(graph.tasks);
    expect(run.graphRevision).toBe(1);
    expect(reopened.listRunIds()).toEqual([runId]);
    reopened.close();
  });

  it('journals a run and resumes it without re-running completed tasks', async () => {
    const dataDir = tempDir();
    const graph = buildTaskGraph([task('a'), task('b', ['a']), task('c')]);
    let store = openExecutionStore({ dataDir });
    const runId = store.createRun({ intake, graph });
    const first = await runTaskGraph(graph, {
      runner: new MockAgentRunner({ scripts: { b: { outcome: 'throw' } } }),
      journal: store.journal(runId),
    });
    expect(first.status).toBe('failed');
    store.close();

    store = openExecutionStore({ dataDir });
    const saved = store.loadRun(runId);
    expect([...saved.completed.keys()].sort()).toEqual(['a', 'c']);
    expect(saved.attemptCounts.get('b')).toBe(1);
    expect(saved.attempts.find((a) => a.taskId === 'b')).toMatchObject({
      state: 'failed',
      attempt: 1,
    });

    const runner = new MockAgentRunner();
    const resumed = await runTaskGraph(buildTaskGraph(saved.tasks), {
      runner,
      completed: saved.completed,
      previousAttempts: saved.attemptCounts,
      journal: store.journal(runId),
    });
    expect(resumed.status).toBe('succeeded');
    expect(runner.invokedTaskIds).toEqual(['b']);
    expect(resumed.outcomes.get('b')?.attempt).toBe(2);
    expect(
      store
        .loadRun(runId)
        .attempts.filter((a) => a.taskId === 'b')
        .map((a) => a.state),
    ).toEqual(['failed', 'succeeded']);
    store.close();
  });

  it('records tasks that never started (cancelled or skipped) with attempt 0', async () => {
    const dataDir = tempDir();
    const graph = buildTaskGraph([task('a'), task('b', ['a'])]);
    const store = openExecutionStore({ dataDir });
    const runId = store.createRun({ intake, graph });
    await runTaskGraph(graph, {
      runner: new MockAgentRunner({ scripts: { a: { outcome: 'fail' } } }),
      journal: store.journal(runId),
    });
    expect(store.loadRun(runId).attempts.find((a) => a.taskId === 'b')).toMatchObject({
      attempt: 0,
      state: 'skipped',
      error: 'prerequisite "a" did not succeed',
    });
    store.close();
  });

  it('persists graph revisions', () => {
    const store = openExecutionStore({ dataDir: tempDir() });
    const graph = buildTaskGraph([task('a')]);
    const runId = store.createRun({ intake, graph });
    store.saveGraph(runId, buildTaskGraph([task('a'), task('b')], 2));
    expect(store.loadRun(runId)).toMatchObject({ graphRevision: 2 });
    expect(store.loadRun(runId).tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(() => {
      store.saveGraph('nope', graph);
    }).toThrow(/Unknown run/);
    expect(() => store.loadRun('nope')).toThrow(/Unknown run/);
    store.close();
  });
});
