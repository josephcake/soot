/**
 * Process sandbox through the CLI (ADR-051), fixture-backed with soot's mock agent: soot-run
 * checks run under the configured sandbox, the backend is recorded in the report and in
 * soot.sqlite, `soot config` shows it honestly, and a sandbox that is required (or named
 * explicitly) but unavailable blocks tasks instead of running them unsandboxed. The bwrap case
 * is real and runs only where bwrap works; elsewhere it is skipped.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProgram, probeBackend } from '@soot/agent-runtime';
import { MOCK, TEST_1, cli, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';

const SLOW = 60_000;
let repo: DemoRepo | null = null;
afterEach(() => {
  repo?.dispose();
  repo = null;
});

const bwrap = findProgram('bwrap', process.env.PATH);
const bwrapWorks =
  process.platform === 'linux' && bwrap !== null && probeBackend('bwrap', bwrap) === null;

function configure(r: DemoRepo, change: (c: Record<string, unknown>) => void) {
  const path = join(r.root, 'soot.config.json');
  const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  change(config);
  writeFileSync(path, JSON.stringify(config, null, 2));
  r.commitAll('configure sandbox');
}

interface Check {
  name: string;
  status: string;
  sandbox: string | null;
}
interface RunJson {
  sandbox: { backend: string; isolation: boolean; blocked: string | null };
  report: {
    tasks: { taskId: string; verdict: string; reason: string; checks: Check[] }[];
  };
}

describe('process sandbox through the CLI (ADR-051)', () => {
  it(
    'default (auto): checks run under the chosen backend, recorded in the report, status and soot.sqlite',
    async () => {
      const r = (repo = createDemoRepo());
      const cfg = await cli(r, ['config', '--json']);
      expect(cfg.code).toBe(0);
      const sandbox = (JSON.parse(cfg.stdout) as { sandbox: RunJson['sandbox'] & { mode: string } })
        .sandbox;
      expect(sandbox.mode).toBe('auto');
      expect(sandbox.backend).toBe(bwrapWorks ? 'bwrap' : sandbox.backend);
      expect(sandbox.isolation).toBe(sandbox.backend !== 'none');
      expect(sandbox.blocked).toBeNull();
      const text = await cli(r, ['config']);
      expect(text.stdout).toMatch(/Sandbox \(mode auto\): /);
      if (sandbox.backend === 'none') expect(text.stdout).toContain('NOT isolation');

      const run = await cli(r, ['run', TEST_1, ...MOCK, '--run-id', 's1', '--json']);
      const out = JSON.parse(run.stdout) as RunJson;
      expect(out.sandbox.backend).toBe(sandbox.backend);
      const checks = out.report.tasks.flatMap((t) => t.checks);
      expect(checks.length).toBeGreaterThan(0);
      for (const c of checks) expect(c.sandbox).toBe(sandbox.backend);

      const status = await cli(r, ['status', 's1', '--json']);
      const st = JSON.parse(status.stdout) as {
        sandbox: { backend: string };
        commands: { stage: string; name: string; sandbox: string | null; taskId: string | null }[];
        tasks: { checks: Check[] }[];
      };
      expect(st.sandbox.backend).toBe(sandbox.backend);
      expect(st.commands.length).toBe(checks.length + 2); // + final validation (test, lint)
      expect(st.commands.every((c) => c.sandbox === sandbox.backend)).toBe(true);
      expect(st.commands.filter((c) => c.stage === 'final-validation')).toHaveLength(2);
      expect(st.tasks.flatMap((t) => t.checks).every((c) => c.sandbox === sandbox.backend)).toBe(
        true,
      );
      const human = await cli(r, ['status', 's1']);
      expect(human.stdout).toMatch(/Sandbox: (bwrap \(OS isolation\)|none \(NOT isolation\))/);
    },
    SLOW,
  );

  it(
    'a named backend that is unavailable blocks every task; nothing runs unsandboxed',
    async () => {
      const r = (repo = createDemoRepo());
      configure(r, (c) => {
        c.sandbox = { mode: 'bwrap', bwrapPath: '/nonexistent/bwrap' };
      });
      const cfg = await cli(r, ['config']);
      expect(cfg.stdout).toMatch(/BLOCKED: tasks will not run/);
      const head = r.git('rev-parse', 'HEAD');
      const run = await cli(r, ['run', TEST_1, ...MOCK, '--run-id', 'blk', '--json']);
      const out = JSON.parse(run.stdout) as RunJson;
      expect(out.sandbox.blocked).toMatch(/mode is "bwrap"/);
      for (const t of out.report.tasks) {
        expect(t.verdict).not.toBe('verified');
        expect(t.checks).toEqual([]);
      }
      const audit = readFileSync(join(r.dataDir, 'audit', 'blk.jsonl'), 'utf8');
      expect(audit).toContain('"sandbox-blocked"');
      expect(audit).not.toContain('"attempt-started"'); // the agent never started
      expect(r.git('rev-parse', 'HEAD')).toBe(head);
    },
    SLOW,
  );

  it('sandbox config is validated with clear errors', async () => {
    const r = (repo = createDemoRepo());
    for (const [sandbox, message] of [
      [{ mode: 'docker' }, /sandbox\.mode/],
      [{ writePaths: ['relative/dir'] }, /sandbox\.writePaths\.0: must be an absolute path/],
      [{ writePaths: ['/'] }, /not allowed: the filesystem root/],
      [{ writePaths: ['/srv/repo/.git'] }, /not allowed: git internals/],
      [{ required: true, mode: 'none' }, /"required": true cannot be combined with "mode": "none"/],
      [{ network: 'yes' }, /sandbox\.network/],
      [{ extra: 1 }, /sandbox/],
    ] as const) {
      configure(r, (c) => {
        c.sandbox = sandbox;
      });
      const out = await cli(r, ['config']);
      expect(out.code).not.toBe(0);
      expect(out.stderr + out.stdout).toMatch(message);
    }
  });

  it.skipIf(!bwrapWorks)(
    'real bwrap: a check that writes outside its worktree fails, and nothing lands outside',
    async () => {
      const r = (repo = createDemoRepo());
      const escape = join(r.top, 'escaped.txt');
      configure(r, (c) => {
        c.checks = [
          ...(c.checks as unknown[]),
          {
            name: 'escape',
            kind: 'test',
            argv: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(escape)}, 'x')`],
          },
        ];
      });
      const run = await cli(r, ['run', TEST_1, ...MOCK, '--run-id', 'esc', '--json']);
      const out = JSON.parse(run.stdout) as RunJson;
      expect(out.sandbox.backend).toBe('bwrap');
      const escapes = out.report.tasks.flatMap((t) => t.checks).filter((c) => c.name === 'escape');
      expect(escapes.length).toBeGreaterThan(0);
      for (const c of escapes) expect(c).toMatchObject({ status: 'failed', sandbox: 'bwrap' });
      expect(existsSync(escape)).toBe(false);
    },
    SLOW,
  );
});
