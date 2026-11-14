/**
 * `soot resume` end to end (ADR-054), with the BUILT `soot` binary in real child processes: a
 * run is SIGKILLed mid-task (a crash), stopped, or blocked, and `soot resume` continues it from
 * soot.sqlite and its branches. The agent is the scripted mock (a test double): no model, no
 * provider, no harness binary, no sign-in.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_1, cli, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';
import { CLI_BIN, buildWorkspace } from './helpers/workspace-build.js';

beforeAll(async () => {
  await buildWorkspace();
}, 180_000);

let repo: DemoRepo | null = null;
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  repo?.dispose();
  repo = null;
});

const SLOW = 90_000;

interface Spawned {
  readonly child: ChildProcessWithoutNullStreams;
  readonly out: () => string;
  readonly err: () => string;
  readonly exited: Promise<number | null>;
}

function soot(r: DemoRepo, args: string[]): Spawned {
  const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: r.root, env: r.env });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  return {
    child,
    out: () => out,
    err: () => err,
    exited: new Promise((resolve) => child.on('close', resolve)),
  };
}

interface StatusJson {
  state: string;
  resumable: boolean;
  sessions: {
    session: number;
    kind: string;
    state: string;
    kept: number;
    rerun: number;
    held: number;
    configChanges: string[];
  }[];
  tasks: {
    taskId: string;
    state: string;
    attempts: number;
    attemptDetails: { attempt: number; state: string; session: number | null }[];
  }[];
}

async function status(r: DemoRepo, runId: string): Promise<StatusJson> {
  const s = await cli(r, ['status', runId, '--json']);
  expect(s.code).toBe(0);
  return JSON.parse(s.stdout) as StatusJson;
}

async function waitFor(
  r: DemoRepo,
  runId: string,
  ok: (s: StatusJson) => boolean,
  what: string,
): Promise<StatusJson> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const s = await cli(r, ['status', runId, '--json']);
    if (s.code === 0) {
      const parsed = JSON.parse(s.stdout) as StatusJson;
      if (ok(parsed)) return parsed;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

const taskState = (s: StatusJson, id: string) => s.tasks.find((t) => t.taskId === id)?.state;
const worktrees = (r: DemoRepo) =>
  r.git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length ?? 0;

/** The demo mock script with per-task overrides (an array = one script per attempt). */
function script(r: DemoRepo, name: string, overrides: Record<string, unknown>): string {
  const base = JSON.parse(r.read('mock-agent.json')) as { tasks: Record<string, unknown> };
  for (const [id, value] of Object.entries(overrides)) {
    const original = base.tasks[id] as Record<string, unknown>;
    base.tasks[id] = Array.isArray(value)
      ? value.map((v: Record<string, unknown>) => ({ ...original, ...v }))
      : { ...original, ...(value as Record<string, unknown>) };
  }
  writeFileSync(join(r.top, name), JSON.stringify(base));
  return `../${name}`;
}

const audit = (r: DemoRepo, runId: string) =>
  readFileSync(join(r.dataDir, 'audit', `${runId}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map(
      (l) =>
        JSON.parse(l) as {
          seq: number;
          type: string;
          taskId: string | null;
          detail: Record<string, unknown>;
        },
    );

describe('soot resume (ADR-054)', () => {
  it(
    'a run SIGKILLed mid-task resumes to completion: done work kept, stale lease reclaimed, cost not double-counted, second resume is a no-op',
    async () => {
      const r = (repo = createDemoRepo());
      // Attempt 1 of the button task hangs (ignores abort) until the process is killed; the
      // resumed attempt 2 succeeds.
      const mock = script(r, 'crash.json', {
        'update-button-color': [{ outcome: 'hang' }, { delayMs: 50 }],
      });
      const head = r.git('rev-parse', 'HEAD');
      const first = soot(r, [
        'run',
        TEST_1,
        '--agent',
        'mock',
        '--mock-script',
        mock,
        '--run-id',
        'crash',
        '--json',
      ]);
      await waitFor(
        r,
        'crash',
        (s) =>
          taskState(s, 'update-page-title') === 'succeeded' &&
          taskState(s, 'update-button-color') === 'running',
        'title done, button running',
      );
      first.child.kill('SIGKILL');
      await first.exited;

      const crashed = await status(r, 'crash');
      expect(crashed).toMatchObject({ state: 'interrupted', resumable: true });
      expect(crashed.sessions).toMatchObject([{ session: 1, kind: 'run', state: 'crashed' }]);
      expect(worktrees(r)).toBeGreaterThan(1); // the dead process left its worktrees behind
      expect((await cli(r, ['status', 'crash'])).stdout).toMatch(/Resume with: soot resume crash/);

      // No --agent: the run's recorded agent and mock script are used. --apply lands the result.
      const resumed = await cli(r, ['resume', 'crash', '--apply', '--json']);
      expect(resumed.stderr).toBe('');
      expect(resumed.code).toBe(0);
      const out = JSON.parse(resumed.stdout) as {
        session: number;
        resume: {
          decisions: { taskId: string; action: string; previous: string; reason: string }[];
          reclaimed: { action: string }[];
        };
        report: {
          status: string;
          tasks: { taskId: string; verdict: string; integration: string }[];
        };
        costRecords: { taskId: string; attempt: number }[];
      };
      expect(out.session).toBe(2);
      expect(out.report.status).toBe('complete');
      expect(out.report.tasks.map((t) => [t.taskId, t.verdict, t.integration])).toEqual([
        ['update-page-title', 'verified', 'merged'],
        ['update-button-color', 'verified', 'merged'],
      ]);
      expect(out.resume.decisions.map((d) => [d.taskId, d.action, d.previous])).toEqual([
        ['update-page-title', 'keep', 'succeeded'],
        ['update-button-color', 'rerun', 'interrupted'],
      ]);
      expect(out.resume.decisions[1]?.reason).toMatch(/stale lease reclaimed/);
      expect(out.resume.reclaimed.map((a) => a.action)).toContain('worktree-removed');
      // The user's branch now has both changes; nothing is left behind.
      expect(r.git('rev-parse', 'HEAD')).not.toBe(head);
      expect(r.read('src/pages/index.html')).toContain('HELLO WORLD');
      expect(r.read('src/styles/button.css')).toContain('purple');
      expect(worktrees(r)).toBe(1);
      expect(r.git('status', '--porcelain')).toBe('');

      // The title task was not re-run: one attempt, from session 1. The button task has the
      // interrupted attempt 1 (session 1) and the new attempt 2 (session 2).
      const after = await status(r, 'crash');
      const tasks = Object.fromEntries(
        after.tasks.map((t) => [
          t.taskId,
          t.attemptDetails.map((a) => [a.attempt, a.state, a.session]),
        ]),
      );
      expect(tasks).toEqual({
        'update-page-title': [[1, 'succeeded', 1]],
        'update-button-color': [
          [1, 'interrupted', 1],
          [2, 'succeeded', 2],
        ],
      });
      expect(after.state).toBe('complete');
      expect(after.sessions.map((s) => [s.kind, s.state, s.kept, s.rerun, s.held])).toEqual([
        ['run', 'crashed', 0, 0, 0],
        ['resume', 'complete', 1, 1, 0],
      ]);
      expect((await cli(r, ['status', 'crash'])).stdout).toMatch(
        /#2 resume complete .*kept 1, re-ran 1, held 0/,
      );

      // Cost: every attempt counted once. The killed attempt reported no usage, so the actual
      // total is honestly unknown (never guessed); the reported actuals and the routed estimates
      // are each listed once per attempt.
      const cost = await cli(r, ['cost', 'crash']);
      expect(cost.stdout).toMatch(/attempt 1 \S+ succeeded: est \$0\.000350, actual \$0\.000760/);
      expect(cost.stdout).toMatch(/attempt 1 \S+ no-result: est \$0\.000400, actual unknown/);
      expect(cost.stdout).toMatch(/attempt 2 \S+ succeeded: est \$0\.000400, actual \$0\.000870/);
      expect(cost.stdout).toMatch(/Total actual: unknown over 3 attempts .*1 without usage/);
      expect(cost.stdout).toMatch(/Routed estimates: 3 attempts, \$0\.001150/);
      expect(cost.stdout.match(/attempt \d/g)).toHaveLength(3);
      const keys = out.costRecords.map((c) => `${c.taskId}#${String(c.attempt)}`);
      expect(new Set(keys).size).toBe(keys.length);

      // Audit: the takeover and the resume are recorded; seq stays unique across sessions.
      const entries = audit(r, 'crash');
      expect(entries.map((e) => e.type)).toEqual(
        expect.arrayContaining(['run-lock-reclaimed', 'run-resumed', 'worktree-reclaimed']),
      );
      expect(new Set(entries.map((e) => e.seq)).size).toBe(entries.length);

      // Resuming a complete run changes nothing.
      const again = await cli(r, ['resume', 'crash']);
      expect(again.code).toBe(0);
      expect(again.stdout).toMatch(/already complete; nothing to resume/);
      expect((await status(r, 'crash')).sessions).toHaveLength(2);
    },
    SLOW,
  );

  it(
    'refuses a run that is live in another process, and a second concurrent resume',
    async () => {
      const r = (repo = createDemoRepo());
      const mock = script(r, 'live.json', {
        'update-button-color': [{ outcome: 'hang' }, { delayMs: 4_000 }],
      });
      const first = soot(r, [
        'run',
        TEST_1,
        '--agent',
        'mock',
        '--mock-script',
        mock,
        '--run-id',
        'live',
        '--json',
      ]);
      await waitFor(
        r,
        'live',
        (s) => taskState(s, 'update-button-color') === 'running',
        'button running',
      );
      // The original run is alive: resume refuses and touches nothing.
      const refused = await cli(r, ['resume', 'live']);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/run live is live in another soot process .*not resumed/);
      expect((await status(r, 'live')).sessions).toHaveLength(1);

      first.child.kill('SIGKILL');
      await first.exited;
      // Resume A runs the slow attempt 2; resume B, started meanwhile, is refused.
      const a = soot(r, ['resume', 'live', '--json']);
      await waitFor(
        r,
        'live',
        (s) => s.sessions.length === 2 && s.state === 'running',
        'resume A running',
      );
      const b = await cli(r, ['resume', 'live']);
      expect(b.code).toBe(1);
      expect(b.stderr).toMatch(/is live in another soot process/);
      expect(await a.exited).toBe(2); // incomplete: unattended, the working tree is not updated
      const done = await status(r, 'live');
      expect(done.sessions.map((s) => [s.kind, s.state])).toEqual([
        ['run', 'crashed'],
        ['resume', 'incomplete'],
      ]);
      expect(done.tasks.map((t) => t.state)).toEqual(['succeeded', 'succeeded']);
    },
    SLOW,
  );

  it(
    'a stopped run resumes; a changed agent script is refused until --allow-config-change, and recorded',
    async () => {
      const r = (repo = createDemoRepo());
      const mock = script(r, 'stop.json', { 'update-button-color': { delayMs: 60_000 } });
      const first = soot(r, [
        'run',
        TEST_1,
        '--agent',
        'mock',
        '--mock-script',
        mock,
        '--run-id',
        'st',
        '--json',
      ]);
      await waitFor(
        r,
        'st',
        (s) =>
          taskState(s, 'update-page-title') === 'succeeded' &&
          taskState(s, 'update-button-color') === 'running',
        'title done',
      );
      expect((await cli(r, ['stop', 'st'])).code).toBe(0);
      expect(await first.exited).toBe(3);
      expect((await status(r, 'st')).sessions[0]?.state).toBe('cancelled');

      // Change the mock script the run uses: that is config drift.
      script(r, 'stop.json', { 'update-button-color': { delayMs: 50 } });
      const refused = await cli(r, ['resume', 'st']);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/was not resumed: what it depends on changed/);
      expect(refused.stderr).toMatch(/- mockScript: [0-9a-f]{12} → [0-9a-f]{12}/);
      expect(refused.stderr).toMatch(/--allow-config-change/);
      expect((await status(r, 'st')).sessions).toHaveLength(1);

      const resumed = await cli(r, ['resume', '--latest', '--allow-config-change', '--json']);
      expect(resumed.code).toBe(2);
      const out = JSON.parse(resumed.stdout) as {
        resume: {
          decisions: { taskId: string; action: string; previous: string }[];
          configChanges: { part: string }[];
        };
        report: { tasks: { verdict: string }[] };
      };
      expect(out.resume.configChanges.map((c) => c.part)).toEqual(['mockScript']);
      expect(out.resume.decisions.map((d) => [d.taskId, d.action, d.previous])).toEqual([
        ['update-page-title', 'keep', 'succeeded'],
        ['update-button-color', 'rerun', 'cancelled'],
      ]);
      expect(out.report.tasks.map((t) => t.verdict)).toEqual(['verified', 'verified']);
      expect((await status(r, 'st')).sessions[1]?.configChanges).toEqual(['mockScript']);
      const resumedEntry = audit(r, 'st').find((e) => e.type === 'run-resumed');
      expect(resumedEntry?.detail.configChanges).toEqual(['mockScript']);
    },
    SLOW,
  );

  it(
    'a blocked task stays blocked on resume; a pending approval is asked again, never auto-approved',
    async () => {
      const r = (repo = createDemoRepo());
      const approval = { action: 'destructive-command', detail: 'run the scripted risky step' };
      const mock = script(r, 'approve.json', { 'update-page-title': { approval } });
      // Unattended: the approval is unavailable, so the title task is blocked.
      const first = await cli(r, [
        'run',
        TEST_1,
        '--agent',
        'mock',
        '--mock-script',
        mock,
        '--run-id',
        'blk',
      ]);
      expect(first.code).toBe(2);
      const held = await cli(r, ['resume', 'blk', '--json']);
      expect(held.code).toBe(2);
      const heldOut = JSON.parse(held.stdout) as {
        resume: { decisions: { taskId: string; action: string; hold: string | null }[] };
        report: { tasks: { taskId: string; schedulerState: string; reason: string }[] };
      };
      expect(heldOut.resume.decisions.map((d) => [d.taskId, d.action, d.hold])).toEqual([
        ['update-page-title', 'hold', 'approval'],
        ['update-button-color', 'keep', null],
      ]);
      expect(heldOut.report.tasks[0]).toMatchObject({ schedulerState: 'failed' });
      expect(heldOut.report.tasks[0]?.reason).toMatch(/held on resume \(approval\)/);
      // Not re-run: still one attempt.
      expect((await status(r, 'blk')).tasks[0]?.attempts).toBe(1);

      // Now interactively: the person is asked again; nothing answers for them. A run killed
      // while the approval is waiting asks again on resume.
      const waiting = soot(r, ['resume', 'blk', '--retry-blocked', '--interactive', '--json']);
      const deadline = Date.now() + 20_000;
      while (!waiting.err().includes('approval needed (destructive-command)')) {
        if (Date.now() > deadline) throw new Error(`no approval prompt: ${waiting.err()}`);
        await new Promise((res) => setTimeout(res, 50));
      }
      waiting.child.kill('SIGKILL');
      await waiting.exited;
      const pending = await status(r, 'blk');
      expect(pending.state).toBe('interrupted');
      expect(pending.tasks[0]?.state).toBe('running'); // closed as interrupted by the next resume

      // The interrupted attempt is re-run (no flag needed: it was not blocked, it was waiting)
      // and its approval is asked again; the person answers "y" on stdin.
      const answered = await cli(r, ['resume', 'blk', '--interactive', '--apply', '--json'], {
        stdin: 'y\n',
      });
      expect(answered.stderr).toMatch(
        /approval needed \(destructive-command\) for update-page-title/,
      );
      expect(answered.code).toBe(0);
      const done = JSON.parse(answered.stdout) as { report: { status: string } };
      expect(done.report.status).toBe('complete');
      const answers = audit(r, 'blk').filter(
        (e) => e.type === 'approval-answered' && e.taskId === 'update-page-title',
      );
      expect(answers.map((e) => e.detail.decision)).toEqual(['unavailable', 'approved']);
      expect(
        (await status(r, 'blk')).tasks[0]?.attemptDetails.map((a) => [a.attempt, a.state]),
      ).toEqual([
        [1, 'failed'],
        [2, 'interrupted'],
        [3, 'succeeded'],
      ]);
    },
    SLOW,
  );

  it(
    'spend from before the crash counts against the run budget; a budget-stopped task stays held until the budget is raised and --retry-blocked',
    async () => {
      const r = (repo = createDemoRepo());
      const setBudget = (usd: number) => {
        const cfg = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
        r.write(
          'soot.config.json',
          `${JSON.stringify({ ...cfg, escalation: { runBudgetUsd: usd } }, null, 2)}\n`,
        );
        r.commitAll(`budget ${String(usd)}`);
      };
      setBudget(0.0012);
      const mock = script(r, 'budget.json', {
        'update-button-color': [{ outcome: 'hang' }, { delayMs: 50 }],
      });
      const first = soot(r, [
        'run',
        TEST_1,
        '--agent',
        'mock',
        '--mock-script',
        mock,
        '--run-id',
        'bud',
        '--json',
      ]);
      await waitFor(
        r,
        'bud',
        (s) =>
          taskState(s, 'update-page-title') === 'succeeded' &&
          taskState(s, 'update-button-color') === 'running',
        'title done, button running',
      );
      first.child.kill('SIGKILL');
      await first.exited;

      // Spent so far: title's actual $0.00076 + the killed attempt's routed estimate $0.0004
      // = $0.00116. The next attempt's estimate ($0.0004) would exceed $0.0012.
      const stopped = await cli(r, ['resume', 'bud', '--json']);
      expect(stopped.code).toBe(2);
      const out = JSON.parse(stopped.stdout) as {
        decisions: string[];
        report: { tasks: { taskId: string; reason: string }[] };
      };
      expect(out.decisions.join('\n')).toMatch(
        /run budget exhausted: spent \$0\.001160 \+ next attempt \$0\.000400 > \$0\.001200/,
      );
      expect(out.report.tasks[1]?.reason).toMatch(/budget/);

      // Resuming again holds it (budget), and runs nothing.
      const held = await cli(r, ['resume', 'bud', '--json']);
      const heldOut = JSON.parse(held.stdout) as {
        resume: { decisions: { taskId: string; action: string; hold: string | null }[] };
      };
      expect(heldOut.resume.decisions[1]).toMatchObject({ action: 'hold', hold: 'budget' });

      // Raising the budget is a config change; with it accepted and --retry-blocked the task runs.
      setBudget(1);
      const refused = await cli(r, ['resume', 'bud', '--retry-blocked']);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/- config: /);
      const retried = await cli(r, [
        'resume',
        'bud',
        '--retry-blocked',
        '--allow-config-change',
        '--json',
      ]);
      const done = JSON.parse(retried.stdout) as { report: { tasks: { verdict: string }[] } };
      expect(done.report.tasks.map((t) => t.verdict)).toEqual(['verified', 'verified']);
      // The button task: killed attempt 1 (session 1), the budget stop in session 2 started no
      // attempt, session 3 held it, and attempt 2 ran only after the budget was raised.
      expect(
        (await status(r, 'bud')).tasks[1]?.attemptDetails.map((a) => [
          a.attempt,
          a.state,
          a.session,
        ]),
      ).toEqual([
        [1, 'interrupted', 1],
        [2, 'succeeded', 4],
      ]);
    },
    SLOW,
  );

  it('refuses unknown runs, bad flags, and a missing run id', async () => {
    const r = (repo = createDemoRepo());
    expect((await cli(r, ['resume', 'nope'])).stderr).toMatch(/unknown run nope/);
    expect((await cli(r, ['resume'])).stderr).toMatch(/resume needs a run id or --latest/);
    expect((await cli(r, ['resume', '--latest'])).stderr).toMatch(/no runs yet/);
    expect((await cli(r, ['status', '--retry-blocked'])).stderr).toMatch(/only for soot resume/);
  });
});
