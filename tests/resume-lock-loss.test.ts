/**
 * The run lock's lease (ADR-054): a run refreshes its heartbeat while it works. If another process
 * took the lock over (after the lease expired), the run must stop instead of working on the same
 * run as a second owner. In-process engine, scripted mock agent (a test double).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { unattendedApprovals } from '../apps/cli/src/approvals.js';
import { SootEngine } from '../apps/cli/src/engine.js';
import { TEST_1, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';

let repo: DemoRepo | null = null;
afterEach(() => {
  repo?.dispose();
  repo = null;
});

describe('run lock heartbeat (ADR-054)', () => {
  it('a run whose lock was taken over stops at once and leaves the new owner’s lock alone', async () => {
    const r = (repo = createDemoRepo());
    const base = JSON.parse(r.read('mock-agent.json')) as {
      tasks: Record<string, Record<string, unknown>>;
    };
    // Both tasks would take 20 s; the abort ends them early.
    for (const id of Object.keys(base.tasks))
      base.tasks[id] = { ...base.tasks[id], delayMs: 20_000 };
    const mock = join(r.top, 'slow.json');
    writeFileSync(mock, JSON.stringify(base));
    const engine = new SootEngine({
      cwd: r.root,
      dataDir: r.dataDir,
      agent: { kind: 'mock', script: mock },
      approvals: unattendedApprovals(),
      gitEnv: r.env,
      modelEnv: { SOOT_LOCAL_MODELS: 'off' },
      runLockTtlMs: 200,
    });
    const started = Date.now();
    let intruded = false;
    const planned = await engine.plan({ prompt: TEST_1, runId: 'lost' });
    if (!planned.ok) throw new Error(planned.output.text);
    const out = await engine.runPlan(planned.plan, undefined, {
      onRunStarted: () => {
        setTimeout(() => {
          const db = new DatabaseSync(join(r.dataDir, 'soot.sqlite'));
          db.exec('PRAGMA busy_timeout = 5000');
          const changed = db
            .prepare('UPDATE run_locks SET owner = ?, pid = ?, heartbeat_ms = ? WHERE run_id = ?')
            .run('intruder', 1, Date.now() + 60_000, 'lost').changes;
          db.close();
          intruded = changed === 1;
        }, 300);
      },
    });
    expect(intruded).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((out.data.report as { status: string }).status).not.toBe('complete');
    const db = new DatabaseSync(join(r.dataDir, 'soot.sqlite'));
    const row = db.prepare('SELECT owner FROM run_locks WHERE run_id = ?').get('lost') as
      { owner: string } | undefined;
    db.close();
    expect(row?.owner).toBe('intruder');
  }, 40_000);
});
