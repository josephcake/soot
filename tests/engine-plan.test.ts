/**
 * The engine split (ADR-038): `plan()` decomposes without touching the store, worktrees or run
 * lock; `runPlan()` executes exactly that plan once; `run()` is the two together, so `soot run`
 * keeps its behaviour. `previewPlan()` routes like the supervisor's first assignment and adds a
 * worst case.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unattendedApprovals } from '../apps/cli/src/approvals.js';
import { SootEngine } from '../apps/cli/src/engine.js';
import { TEST_1, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';

let repo: DemoRepo | null = null;
afterEach(() => {
  repo?.dispose();
  repo = null;
});

const engineFor = (r: DemoRepo) =>
  new SootEngine({
    cwd: r.root,
    dataDir: r.dataDir,
    agent: { kind: 'mock', script: 'mock-agent.json' },
    approvals: unattendedApprovals(),
    gitEnv: r.env,
    modelEnv: {},
  });

describe('SootEngine.plan / runPlan', () => {
  it('plan() records nothing; runPlan() runs it once; the preview names each task’s model', async () => {
    const r = (repo = createDemoRepo());
    const engine = engineFor(r);
    const planned = await engine.plan({ prompt: TEST_1, runId: 'split-1' });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.graph.tasks.map((t) => t.id)).toEqual([
      'update-page-title',
      'update-button-color',
    ]);
    // No run, report, lock or worktree yet.
    expect((await engine.status()).data).toEqual({ runs: [] });
    expect(existsSync(join(r.dataDir, 'reports'))).toBe(false);
    expect(existsSync(join(r.dataDir, 'control'))).toBe(false);
    expect(r.git('branch', '--list', 'soot/*')).toBe('');

    const preview = engine.previewPlan(planned.plan);
    expect(preview.planner).toMatchObject({ kind: 'fixture', model: null, costUsd: null });
    expect(preview.tasks.map((t) => t.model)).toEqual([
      'anthropic/claude-haiku-5-5',
      'anthropic/claude-haiku-5-5',
    ]);
    for (const t of preview.tasks) {
      expect(t.estimateUsd).toEqual(expect.any(Number));
      expect(t.worstCaseUsd ?? 0).toBeGreaterThanOrEqual((t.estimateUsd ?? 0) * 5 - 1e-12);
    }
    expect(preview.worstCaseBasis).toMatch(/^up to 5 attempts per task/);
    expect(preview.estimatePartial).toBe(false);

    let started: string | null = null;
    const out = await engine.runPlan(planned.plan, undefined, {
      onRunStarted: (id) => (started = id),
    });
    expect(started).toBe('split-1');
    expect(out.ok).toBe(true);
    expect((out.data.report as { status: string }).status).toBe('incomplete');
    // The same plan never runs twice.
    const again = await engine.runPlan(planned.plan);
    expect(again.ok).toBe(false);
    expect(again.text).toMatch(/already run/);
    expect(readdirSync(join(r.dataDir, 'reports')).filter((f) => f.endsWith('.json'))).toEqual([
      'split-1.json',
    ]);
  });

  it('run() = plan() + runPlan(): same report shape as before the split', async () => {
    const r = (repo = createDemoRepo());
    const out = await engineFor(r).run({ prompt: TEST_1, runId: 'split-2' });
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/^soot run split-2 \(INCOMPLETE\)/);
    expect(Object.keys(out.data)).toEqual(
      expect.arrayContaining([
        'runId',
        'fixtureId',
        'decomposition',
        'agent',
        'agentLabel',
        'report',
        'costRecords',
        'costSummary',
        'reportPath',
        'auditLog',
      ]),
    );
  });

  it('plan() fails like run() did: no runner, unknown prompt, aborted', async () => {
    const r = (repo = createDemoRepo());
    const none = new SootEngine({
      cwd: r.root,
      dataDir: r.dataDir,
      agent: { kind: 'none' },
      approvals: unattendedApprovals(),
    });
    const a = await none.plan({ prompt: TEST_1 });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.output.text).toMatch(/no agent runner selected/);
    const b = await engineFor(r).plan({ prompt: 'something nobody recorded' });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.output.data.promptSha256).toEqual(expect.any(String));
    // A worst case honours a task budget from the escalation config.
    const cfg = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
    cfg.escalation = { taskBudgetUsd: 0.000001, maxAttemptsPerTask: 3 };
    writeFileSync(join(r.root, 'soot.config.json'), JSON.stringify(cfg));
    const c = await engineFor(r).plan({ prompt: TEST_1 });
    if (!c.ok) throw new Error(c.output.text);
    const p = engineFor(r).previewPlan(c.plan);
    expect(p.tasks.every((t) => t.worstCaseUsd === 0.000001)).toBe(true);
    expect(p.worstCaseBasis).toMatch(/^up to 3 attempts per task .* capped at \$0.000001 per task/);
  });
});
