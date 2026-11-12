/**
 * M1-07 exit check: execution state persisted in SQLite under SOOT_DATA_DIR survives the
 * process being killed (SIGKILL), and a restart resumes without re-running completed tasks.
 * The child runs the BUILT packages, so this test builds them first.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAgentRunner, runTaskGraph } from '@soot/agent-runtime';
import { STATE_DB_FILE, openExecutionStore } from '@soot/context-manager';
import { parseEnv } from '@soot/core';
import { createPromptIntake } from '@soot/planner';
import { buildTaskGraph, type Task } from '@soot/task-graph';

const root = fileURLToPath(new URL('../', import.meta.url));
const childScript = fileURLToPath(new URL('./fixtures/crash-child.mjs', import.meta.url));

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

let dataRoot = '';

beforeAll(() => {
  execFileSync(
    process.execPath,
    [join(root, 'node_modules/typescript/bin/tsc'), '-b', 'tsconfig.json'],
    {
      cwd: root,
      stdio: 'pipe',
    },
  );
  dataRoot = mkdtempSync(join(tmpdir(), 'soot-kill-'));
}, 120_000);

afterAll(() => {
  if (dataRoot !== '') rmSync(dataRoot, { recursive: true, force: true });
});

function runChildUntilReadyThenKill(
  env: NodeJS.ProcessEnv,
  runId: string,
): Promise<NodeJS.Signals | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript, runId], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child never became ready. stdout=${out} stderr=${err}`));
    }, 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('READY')) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('exit', (_code, signal) => {
      clearTimeout(timer);
      if (out.includes('UNEXPECTED-FINISH'))
        reject(new Error('child finished instead of being killed'));
      else resolve(signal);
    });
  });
}

describe('resume after kill (M1-07)', () => {
  it('a SIGKILLed run resumes from SQLite without re-running completed tasks', async () => {
    const env = { ...process.env, SOOT_DATA_DIR: join(dataRoot, 'state') };
    const { dataDir } = parseEnv(env);
    expect(dataDir).toBe(join(dataRoot, 'state'));

    // Graph: a -> c -> e, b -> d. In the child, c hangs forever.
    const graph = buildTaskGraph([
      task('a'),
      task('b'),
      task('c', ['a']),
      task('d', ['b']),
      task('e', ['c']),
    ]);
    const intake = createPromptIntake({ prompt: 'resume test prompt' });
    let store = openExecutionStore({ dataDir });
    const runId = store.createRun({ intake, graph });
    store.close();

    const signal = await runChildUntilReadyThenKill(env, runId);
    expect(signal).toBe('SIGKILL');
    expect(existsSync(join(dataDir, STATE_DB_FILE))).toBe(true);

    // State as the killed process left it.
    store = openExecutionStore({ dataDir });
    const afterKill = store.loadRun(runId);
    expect([...afterKill.completed.keys()].sort()).toEqual(['a', 'b', 'd']);
    expect(afterKill.attempts.find((a) => a.taskId === 'c')).toMatchObject({
      attempt: 1,
      state: 'running',
      finishedAt: null,
    });
    expect(afterKill.attempts.some((a) => a.taskId === 'e')).toBe(false);
    expect(afterKill.originalPrompt).toBe('resume test prompt');

    // Restart: close the dead attempt, then only the interrupted task and its dependent run.
    expect(store.recoverInterrupted(runId)).toEqual(['c']);
    const runner = new MockAgentRunner();
    const report = await runTaskGraph(buildTaskGraph(afterKill.tasks), {
      runner,
      completed: afterKill.completed,
      previousAttempts: afterKill.attemptCounts,
      journal: store.journal(runId),
    });
    expect(report.status).toBe('succeeded');
    expect(runner.invokedTaskIds).toEqual(['c', 'e']);
    expect(report.outcomes.get('c')).toMatchObject({ attempt: 2, resumed: false });
    for (const id of ['a', 'b', 'd']) expect(report.outcomes.get(id)?.resumed).toBe(true);

    const final = store.loadRun(runId);
    expect(final.attempts.filter((a) => a.taskId === 'c').map((a) => [a.attempt, a.state])).toEqual(
      [
        [1, 'interrupted'],
        [2, 'succeeded'],
      ],
    );
    expect(final.completed.size).toBe(5);
    store.close();
  }, 60_000);
});
