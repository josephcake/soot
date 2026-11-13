import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMANDS, SootNode, activate, treeFor } from './extension.js';
import { toRunView } from './core/view-model.js';
import { commands, fake } from './test-support/fake-vscode.js';

/*
 * Extension glue against a FAKE `vscode` module (src/test-support/fake-vscode.ts). This checks
 * wiring only; it does not show that the extension works in VS Code or Cursor.
 */

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  contributes: {
    commands: { command: string }[];
    views: Record<string, { id: string }[]>;
    configuration: { properties: Record<string, { default?: unknown }> };
  };
};

const context = () => ({ subscriptions: [] as unknown[] }) as never;

beforeEach(() => {
  fake.reset();
});

describe('package.json contract', () => {
  it('registers exactly the contributed commands and the soot.runs view', () => {
    const controller = activate(context());
    expect([...fake.commands.keys()].sort()).toEqual(
      pkg.contributes.commands.map((c) => c.command).sort(),
    );
    expect([...COMMANDS].sort()).toEqual([...fake.commands.keys()].sort());
    expect(fake.treeProviders.get('soot.runs')).toBe(controller.tree);
    expect(
      Object.values(pkg.contributes.views)
        .flat()
        .map((v) => v.id),
    ).toEqual(['soot.runs']);
  });
  it('is off by default and has no runtime dependencies', () => {
    expect(pkg.contributes.configuration.properties['soot.enabled']?.default).toBe(false);
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.devDependencies ?? {})).toEqual(['@types/vscode']);
  });
  it('never imports the soot engine packages: it only talks to the CLI (ADR-029)', () => {
    const files = readdirSync(join(PKG_DIR, 'src'), { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const src = readFileSync(join(PKG_DIR, 'src', f), 'utf8');
      expect(src, f).not.toMatch(/from '@soot\//);
      expect(src, f).not.toMatch(/approve-all|--yes\b|autoApprove/i);
    }
  });
});

describe('commands without a soot engine', () => {
  it('enable/disable flip the workspace setting and the tree root', async () => {
    const controller = activate(context());
    expect(controller.tree.getChildren()[0]?.label).toBe('Orchestration: off');
    await commands.executeCommand('soot.enable');
    expect(fake.settings.get('soot.enabled')).toBe(true);
    expect(controller.tree.getChildren()[0]?.label).toBe('Orchestration: on');
    await commands.executeCommand('soot.disable');
    expect(controller.tree.getChildren()[0]?.label).toBe('Orchestration: off');
  });
  it('refuses to run while orchestration is off, and asks for a CLI path when on', async () => {
    activate(context());
    await commands.executeCommand('soot.run');
    expect(fake.messages.at(-1)).toMatchObject({ level: 'warning' });
    expect(fake.messages.at(-1)?.text).toMatch(/orchestration is off/);
    fake.settings.set('soot.enabled', true);
    fake.workspaceFolder = '/nonexistent';
    await commands.executeCommand('soot.run');
    expect(fake.messages.at(-1)).toMatchObject({ level: 'error' });
    expect(fake.messages.at(-1)?.text).toMatch(/soot\.cliPath/);
  });
});

describe('tree nodes', () => {
  it('marks running tasks and runs so only they offer Cancel / Stop', () => {
    const view = toRunView({
      runId: 'r',
      state: 'running',
      running: true,
      tasks: [
        { taskId: 'a', state: 'succeeded', models: ['p/m'] },
        { taskId: 'b', state: 'running', dependsOn: ['a'], models: ['p/m'] },
      ],
    });
    const run = treeFor(true, view)[1];
    expect(run?.contextValue).toBe('soot.run.running');
    const tasks = run?.children.find((n) => n.label === 'Tasks')?.children ?? [];
    expect(tasks.map((t) => [t.taskId, t.contextValue])).toEqual([
      ['a', 'soot.task'],
      ['b', 'soot.task.active'],
    ]);
    expect(tasks[1]).toBeInstanceOf(SootNode);
    const graph = run?.children.find((n) => n.label === 'Task graph')?.children ?? [];
    expect(graph.map((n) => n.label)).toEqual([
      'L0 [■ a · m · 0x]',
      'L1 [▣ b · m · 0x]',
      '   └▶ b ← a',
    ]);
  });
});

/*
 * A scripted stand-in for the soot CLI, so the test decides exactly when a status poll reads
 * the run's state and when it answers. Files in its directory are the controls: `state` (the
 * run, written by `run`), `hold-status` (hold the next poll that reads a running run),
 * `status-held` (that poll has read "running"), `release-status`, `release-run`.
 */
const FAKE_SOOT = String.raw`
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('.', import.meta.url));
const f = (n) => dir + n;
const until = async (n) => { while (!existsSync(f(n))) await new Promise((r) => setTimeout(r, 10)); };
const print = (o) => process.stdout.write(JSON.stringify(o));
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'run') {
  const runId = process.argv[process.argv.indexOf('--run-id') + 1];
  writeFileSync(f('state'), JSON.stringify({ runId, running: true }));
  await until('release-run');
  writeFileSync(f('state'), JSON.stringify({ runId, running: false }));
  print({ report: { status: 'incomplete', problems: [] } });
  process.exitCode = 2;
} else if (cmd === 'status') {
  const { runId, running } = JSON.parse(readFileSync(f('state'), 'utf8'));
  if (arg === '--json') print({ runs: [{ runId }] });
  else {
    if (running && existsSync(f('hold-status')) && !existsSync(f('release-status'))) {
      writeFileSync(f('status-held'), '');
      await until('release-status');
    }
    print({
      runId,
      state: running ? 'running' : 'incomplete',
      running,
      prompt: 'p',
      tasks: [{
        taskId: 'update-page-title',
        state: running ? 'running' : 'cancelled',
        dependsOn: [],
        models: ['anthropic/claude-haiku-5-5'],
        attemptDetails: [],
        verdict: running ? null : 'not-run',
        complete: false,
        reason: running ? null : 'cancelled: cancelled by request',
      }],
      events: [],
    });
  }
} else if (cmd === 'cost') print({});
`;

describe('refresh after a run ends', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const waitFor = async (what: string, ok: () => boolean) => {
    for (let i = 0; i < 1000 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(ok(), what).toBe(true);
  };

  it('a poll that read "running" before the run ended cannot leave that state in the view', async () => {
    const d = (dir = mkdtempSync(join(tmpdir(), 'soot-ext-refresh-')));
    writeFileSync(join(d, 'fake-soot.mjs'), FAKE_SOOT);
    fake.workspaceFolder = d;
    fake.settings.set('soot.enabled', true);
    fake.settings.set('soot.cliPath', join(d, 'fake-soot.mjs'));
    fake.settings.set('soot.nodePath', process.execPath);
    fake.settings.set('soot.agent', 'mock');
    const ext = activate(context());
    writeFileSync(join(d, 'hold-status'), '');
    fake.inputBoxAnswers.push('p');
    const started = commands.executeCommand('soot.run');
    await waitFor('run started', () => existsSync(join(d, 'state')));

    // A poll reads "running" and is held in flight...
    void ext.refresh();
    await waitFor('poll read running', () => existsSync(join(d, 'status-held')));
    // ...while the run ends and the extension starts its last refresh.
    writeFileSync(join(d, 'release-run'), '');
    await waitFor('run ended', () => readFileSync(join(d, 'state'), 'utf8').includes('false'));
    await new Promise((r) => setTimeout(r, 500));
    // Only now does the stale poll answer "running".
    writeFileSync(join(d, 'release-status'), '');
    await started;

    expect(ext.view?.running).toBe(false);
    expect(ext.view?.state).toBe('incomplete');
    expect(ext.view?.tasks.map((t) => [t.id, t.state, t.verdict, t.reason])).toEqual([
      ['update-page-title', 'cancelled', 'not-run', 'cancelled: cancelled by request'],
    ]);
    expect(ext.tree.getChildren()[1]?.label).toMatch(/^Run ide-\S+: incomplete$/);
  }, 30_000);
});
