/**
 * Milestone 7 (local, mock-backed): the thin VS Code / Cursor extension (ADR-029) driving the
 * real built soot CLI in a child process, against a temporary copy of examples/demo-app with
 * `--agent mock`. The `vscode` module is a FAKE (apps/vscode-extension/src/test-support), so
 * these tests show the extension's logic against the real engine, NOT that it works in an
 * editor. The real-editor check is separate: VS Code 1.144 on macOS (M7-01, 2026-11-14);
 * Cursor and other editors are not run.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activate,
  type SootController,
  type SootNode,
} from '../apps/vscode-extension/src/extension.js';
import { SootCli } from '../apps/vscode-extension/src/core/soot-cli.js';
import {
  commands,
  extensionContext,
  fake,
} from '../apps/vscode-extension/src/test-support/fake-vscode.js';
import {
  REPO_ROOT,
  TEST_1,
  TEST_4,
  cli as cliInProcess,
  createDemoRepo,
  type DemoRepo,
} from './helpers/demo-repo.js';
import { buildWorkspace } from './helpers/workspace-build.js';

const SLOW = 90_000;
const CLI = join(REPO_ROOT, 'apps/cli/dist/bin.js');

beforeAll(async () => {
  await buildWorkspace();
}, 180_000);

let repo: DemoRepo | null = null;
const savedEnv = { ...process.env };
beforeEach(() => {
  fake.reset();
});
afterEach(() => {
  repo?.dispose();
  repo = null;
  for (const k of Object.keys(process.env))
    if (!(k in savedEnv)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, savedEnv);
});

/** A demo repo, the extension activated on it, and settings pointing at the built CLI. */
function setUp(mockScript = 'mock-agent.json'): { r: DemoRepo; ext: SootController } {
  const r = (repo = createDemoRepo());
  // The CLI child inherits the editor's environment; here, the demo repo's isolated git/HOME.
  Object.assign(process.env, r.env);
  fake.workspaceFolder = r.root;
  fake.settings.set('soot.enabled', true);
  fake.settings.set('soot.cliPath', CLI);
  fake.settings.set('soot.nodePath', process.execPath);
  fake.settings.set('soot.agent', 'mock');
  fake.settings.set('soot.mockScript', mockScript);
  fake.settings.set('soot.dataDir', r.dataDir);
  return { r, ext: activate(extensionContext() as never) };
}

const child = (n: SootNode | undefined, label: string) =>
  n?.children.find((c) => c.label === label);

describe('soot: Run a prompt → tree and board show what the engine reported', () => {
  it(
    'Test 1 with the mock agent: graph, models, verdicts, cost; unattended, so nothing is approved',
    async () => {
      const { ext } = setUp();
      fake.inputBoxAnswers.push(TEST_1);
      await commands.executeCommand('soot.run');
      const view = ext.view;
      expect(view?.running).toBe(false);
      expect(view?.state).toBe('incomplete');
      expect(view?.tasks.map((t) => [t.id, t.state, t.verdict, t.models])).toEqual([
        ['update-page-title', 'succeeded', 'verified', ['anthropic/claude-haiku-5-5']],
        ['update-button-color', 'succeeded', 'verified', ['anthropic/claude-haiku-5-5']],
      ]);
      expect(view?.cost?.estimatedUsd).toBeGreaterThan(0);
      expect(view?.cost?.actualUsd).toBeCloseTo(0.00163, 6);
      // Unattended: the result waits on the integration branch; the extension approved nothing.
      expect(fake.messages.at(-1)).toMatchObject({ level: 'warning' });
      expect(fake.messages.at(-1)?.text).toMatch(
        /incomplete \(working tree not updated: approval unavailable/,
      );
      expect(fake.output.join('\n')).toMatch(/approvals are refused, never given/);

      const run = ext.tree.getChildren()[1];
      expect(run?.label).toMatch(/^Run ide-\d{8}-\d{6}-[0-9a-f]{4}: incomplete$/);
      expect(child(run, 'Task graph')?.children.map((n) => n.label)).toEqual([
        'L0 [■ update-page-title · claude-haiku-5-5 · 1x] [■ update-button-color · claude-haiku-5-5 · 1x]',
      ]);
      expect(child(run, 'Cost')?.children[0]?.label).toMatch(
        /^estimate \$0\.\d+ \| actual \$0\.001630$/,
      );

      await commands.executeCommand('soot.showBoard');
      const board = fake.documents.at(-1)?.content ?? '';
      expect(fake.documents.at(-1)?.language).toBe('plaintext');
      for (const heading of [
        'Task graph',
        'Active agents',
        'Escalations (0)',
        'Retries and other events',
        'Failures',
        'Verdicts',
        'Cost',
      ])
        expect(board).toContain(`== ${heading} ==`);
    },
    SLOW,
  );

  it(
    'Test 4 shows a layered graph built from the planner dependencies',
    async () => {
      const { ext } = setUp();
      fake.inputBoxAnswers.push(TEST_4);
      await commands.executeCommand('soot.run');
      const tasks = ext.view?.tasks ?? [];
      expect(tasks.length).toBeGreaterThanOrEqual(3);
      expect(Math.max(...tasks.map((t) => t.layer))).toBeGreaterThanOrEqual(1);
      const graph =
        child(ext.tree.getChildren()[1], 'Task graph')?.children.map((n) => n.label) ?? [];
      expect(graph.some((l) => l.startsWith('L1 '))).toBe(true);
      expect(graph.some((l) => /└▶ \S+ ← /.test(l))).toBe(true);
    },
    SLOW,
  );
});

describe('escalations and failures are visible', () => {
  it(
    'a failed first attempt shows as a failure, then an escalation to a stronger model',
    async () => {
      const { r, ext } = setUp('../flaky.json');
      const config = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
      config.escalation = { sameModelRetries: 0 };
      r.write('soot.config.json', `${JSON.stringify(config, null, 2)}\n`);
      r.commitAll('escalate on first failure');
      const good = JSON.parse(r.read('mock-agent.json')) as { tasks: Record<string, unknown> };
      const goodButton = good.tasks['update-button-color'] as Record<string, unknown>;
      const bad = {
        ...goodButton,
        writes: { 'src/styles/button.css': '.btn-primary {\n  background: violet;\n}\n' },
      };
      writeFileSync(
        join(r.top, 'flaky.json'),
        JSON.stringify({
          version: 1,
          tasks: { ...good.tasks, 'update-button-color': [bad, goodButton] },
        }),
      );
      fake.inputBoxAnswers.push(TEST_1);
      await commands.executeCommand('soot.run');
      const button = ext.view?.tasks.find((t) => t.id === 'update-button-color');
      expect(button?.models).toEqual(['anthropic/claude-haiku-5-5', 'openai/gpt-6.1-terra']);
      expect(button?.attempts.map((a) => [a.attempt, a.model])).toEqual([
        [1, 'anthropic/claude-haiku-5-5'],
        [2, 'openai/gpt-6.1-terra'],
      ]);
      expect(button?.attempts[0]?.failure).not.toBeNull();
      const escalate = ext.view?.events.find((e) => e.type === 'escalate');
      expect(escalate).toMatchObject({
        taskId: 'update-button-color',
        attempt: 2,
        model: 'openai/gpt-6.1-terra',
      });
      const run = ext.tree.getChildren()[1];
      // M7-06 (ADR-070): the escalation names task, attempt, from ──▶ to, level, why, trigger.
      expect(ext.view?.escalations).toMatchObject([
        {
          taskId: 'update-button-color',
          attempt: 2,
          fromModel: 'anthropic/claude-haiku-5-5',
          toModel: 'openai/gpt-6.1-terra',
          level: 1,
          triggers: [{ kind: 'repeated-failure' }],
        },
      ]);
      const escalation = child(run, 'Escalations (1)')?.children[0];
      expect(escalation?.label).toBe(
        'update-button-color #2 · claude-haiku-5-5 ──▶ gpt-6.1-terra · L1',
      );
      expect(escalation?.children.map((n) => n.label)).toEqual([
        'from  anthropic/claude-haiku-5-5 (attempt #1)',
        'to    openai/gpt-6.1-terra (attempt #2, level 1)',
        expect.stringMatching(/^why {3}escalate: 1 unsuccessful attempts on /),
        expect.stringMatching(/^· repeated-failure: /),
      ]);
      expect(child(run, 'Failures')?.children[0]?.label).toMatch(/^✕ update-button-color #1 /);
      expect(child(run, 'Task graph')?.children[0]?.label).toContain(
        '[■ update-button-color · claude-haiku-5-5→gpt-6.1-terra · 2x]',
      );
    },
    SLOW,
  );
});

describe('task cancellation from the extension (soot stop <run> --task <id>)', () => {
  it(
    'cancels one running task while the other task finishes',
    async () => {
      const { r, ext } = setUp('../slow.json');
      const demo = JSON.parse(r.read('mock-agent.json')) as {
        tasks: Record<string, Record<string, unknown>>;
      };
      writeFileSync(
        join(r.top, 'slow.json'),
        JSON.stringify({
          version: 1,
          tasks: {
            ...demo.tasks,
            'update-page-title': { ...demo.tasks['update-page-title'], delayMs: 60_000 },
          },
        }),
      );
      fake.inputBoxAnswers.push(TEST_1);
      const started = commands.executeCommand('soot.run');
      // Wait until the extension sees the slow task running and the other one done.
      let slow: SootNode | undefined;
      for (let i = 0; i < 200 && slow === undefined; i++) {
        await new Promise((res) => setTimeout(res, 100));
        await ext.refresh();
        const done =
          ext.view?.tasks.find((t) => t.id === 'update-button-color')?.state === 'succeeded';
        const tasks = child(ext.tree.getChildren()[1], 'Tasks')?.children ?? [];
        const node = tasks.find(
          (n) => n.taskId === 'update-page-title' && n.contextValue === 'soot.task.active',
        );
        if (done && node !== undefined) slow = node;
      }
      expect(slow, 'slow task seen running').toBeDefined();
      expect(ext.view?.running).toBe(true);
      expect(child(ext.tree.getChildren()[1], 'Active agents')?.children[0]?.label).toMatch(
        /^▣ update-page-title on claude-haiku-5-5/,
      );
      const t0 = Date.now();
      await commands.executeCommand('soot.cancelTask', slow);
      await started;
      expect(Date.now() - t0).toBeLessThan(30_000);
      // The run's last refresh can join a poll that started before the run ended (one refresh
      // at a time), so the view may still be one poll behind. Refresh until it shows the
      // finished run; the expected end state below is unchanged.
      const pageTitleState = () => ext.view?.tasks.find((t) => t.id === 'update-page-title')?.state;
      for (
        let i = 0;
        i < 100 && (ext.view?.running !== false || pageTitleState() !== 'cancelled');
        i++
      ) {
        await ext.refresh();
        if (ext.view?.running === false && pageTitleState() === 'cancelled') break;
        await new Promise((res) => setTimeout(res, 100));
      }
      expect(ext.view?.running).toBe(false);
      const tasks = ext.view?.tasks ?? [];
      expect(tasks.find((t) => t.id === 'update-page-title')?.state).toBe('cancelled');
      expect(tasks.find((t) => t.id === 'update-button-color')).toMatchObject({
        state: 'succeeded',
        verdict: 'verified',
      });
      const cancelled = tasks.find((t) => t.id === 'update-page-title');
      expect(cancelled).toMatchObject({
        verdict: 'not-run',
        reason: 'cancelled: cancelled by request',
      });
      expect(cancelled?.attempts[0]).toMatchObject({ state: 'cancelled', actualCostUsd: null });
      expect(child(ext.tree.getChildren()[1], 'Failures')?.children[0]?.label).toBe(
        '✕ update-page-title #1 cancelled: cancelled by request',
      );

      // After the run, cancel requests are refused rather than left lying around.
      const cli = new SootCli({
        nodePath: process.execPath,
        cliPath: CLI,
        cwd: r.root,
        dataDir: r.dataDir,
      });
      const late = await cli.stop(ext.view?.runId ?? '', 'update-page-title');
      expect(late.code).toBe(1);
      expect(String(late.data?.error)).toMatch(/is not running/);
    },
    SLOW,
  );
});

describe('soot stop --task input checks (engine side)', () => {
  it('refuses bad task ids and runs that are not running, without writing anything', async () => {
    const r = (repo = createDemoRepo());
    const bad = await cliInProcess(r, ['stop', 'r1', '--task', '../etc', '--json']);
    expect(bad.code).toBe(1);
    const idle = await cliInProcess(r, ['stop', 'r1', '--task', 'update-page-title']);
    expect(idle.code).toBe(1);
    expect(idle.stderr + idle.stdout).toMatch(/run r1 is not running/);
  });
});
