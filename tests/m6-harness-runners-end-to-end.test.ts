/**
 * Milestone 6 (M6-04 / M6-05, ADR-047), SIMULATED ONLY: `soot run --agent claude-code` and
 * `--agent codex` spawn the adapter command the user configured under "harnesses" and drive it
 * through the harness runner profiles over the generic ACP driver. The configured command here
 * is soot's own mock ACP agent running a script shaped like each harness's ACP adapter
 * (`simulatedHarnessScript`). No vendor binary, model, login, key or network is involved, and
 * nothing here verifies Claude Code or Codex.
 */
import { simulatedHarnessScript, type HarnessId, type MockAcpStep } from '@soot/harness-adapters';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_APP,
  REPO_ROOT,
  TEST_1,
  cli,
  createDemoRepo,
  type DemoRepo,
} from './helpers/demo-repo.js';
import { buildWorkspace } from './helpers/workspace-build.js';

const SLOW = 90_000;
const MOCK_ACP_BIN = join(REPO_ROOT, 'packages/harness-adapters/dist/acp/mock-agent-bin.js');

beforeAll(async () => {
  await buildWorkspace();
}, 180_000);

let repo: DemoRepo | null = null;
afterEach(() => {
  repo?.dispose();
  repo = null;
});

const demoWrites = (id: string): Record<string, string> => {
  const mock = JSON.parse(readFileSync(join(DEMO_APP, 'mock-agent.json'), 'utf8')) as {
    tasks: Record<string, { writes: Record<string, string> }>;
  };
  const step = mock.tasks[id];
  if (step === undefined) throw new Error(`no demo writes for ${id}`);
  return step.writes;
};

/** Point `harnesses.<id>` at the mock ACP agent running a simulated adapter script. */
function useSimulatedHarness(
  r: DemoRepo,
  id: HarnessId,
  tasks: Record<string, MockAcpStep>,
  o: { mode?: string; requireAuth?: boolean; harness?: Record<string, unknown> } = {},
): { log: () => Record<string, unknown>[] } {
  const scriptPath = join(r.top, `simulated-${id}.json`);
  const logPath = join(r.top, `simulated-${id}.jsonl`);
  writeFileSync(
    scriptPath,
    JSON.stringify(
      simulatedHarnessScript(id, {
        tasks,
        ...(o.mode === undefined ? {} : { mode: o.mode }),
        ...(o.requireAuth === true ? { requireAuth: true } : {}),
      }),
    ),
  );
  const configPath = join(r.root, 'soot.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  config.harnesses = {
    [id]: { command: process.execPath, args: [MOCK_ACP_BIN, scriptPath, logPath], ...o.harness },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  r.commitAll(`use a simulated ${id} adapter`);
  return {
    log: () =>
      existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
  };
}

interface RunJson {
  agent: string;
  agentLabel: string;
  report: {
    status: string;
    tasks: {
      taskId: string;
      verdict: string;
      integration: string;
      complete: boolean;
      reason: string;
    }[];
  };
}
const parse = (stdout: string) => JSON.parse(stdout) as RunJson;
const taskOf = (r: RunJson, id: string) => r.report.tasks.find((t) => t.taskId === id);

const REJECT: Record<HarnessId, string> = { 'claude-code': 'reject', codex: 'abort' };
const BYPASS: Record<HarnessId, string> = {
  'claude-code': 'bypassPermissions',
  codex: 'agent-full-access',
};

describe.each(['claude-code', 'codex'] as const)(
  'soot run --agent %s with a simulated adapter (spec §17 Test 1 prompt)',
  (id) => {
    it(
      'unattended: the permission-asking task is refused; the other is verified and merged',
      async () => {
        const r = (repo = createDemoRepo());
        const sim = useSimulatedHarness(r, id, {
          'update-page-title': {
            permission: { title: 'Edit src/pages/index.html' },
            writes: demoWrites('update-page-title'),
          },
          'update-button-color': { writes: demoWrites('update-button-color'), message: 'ok' },
        });
        r.env.FAKE_PROVIDER_API_KEY = 'sk-should-never-reach-the-agent';
        const run = await cli(r, ['run', TEST_1, '--agent', id, '--run-id', `h-${id}`, '--json']);
        expect(run.code).toBe(2);
        const out = parse(run.stdout);
        expect(out.agent).toBe('acp');
        expect(out.agentLabel).toContain(`${id} (your ACP adapter command: ${process.execPath}`);
        expect(out.agentLabel).toContain('tested against simulated adapters only');
        expect(taskOf(out, 'update-button-color')).toMatchObject({
          verdict: 'verified',
          integration: 'merged',
          complete: true,
        });
        expect(taskOf(out, 'update-page-title')).toMatchObject({
          complete: false,
          reason: 'agent-not-succeeded: agent reported blocked',
        });
        expect(r.git('show', `soot/h-${id}/integration:src/styles/button.css`)).toContain('purple');

        const log = sim.log();
        for (const s of log.filter((e) => e.method === 'start')) {
          expect(String(s.cwd).startsWith(join(r.dataDir, 'worktrees', `h-${id}`))).toBe(true);
          expect(s.env as string[]).not.toContain('FAKE_PROVIDER_API_KEY');
        }
        const answers = log.filter((e) => e.method === 'permission-answer').map((e) => e.outcome);
        expect(answers.length).toBeGreaterThanOrEqual(1);
        for (const a of answers) expect(a).toEqual({ outcome: 'selected', optionId: REJECT[id] });
        const methods = log.map((e) => e.method);
        expect(methods).not.toContain('authenticate');
        expect(methods).not.toContain('session/set_mode');
        // Only the model option may be set, never the mode.
        for (const e of log.filter((x) => x.method === 'session/set_config_option')) {
          expect(e.configId).toBe('model');
        }
      },
      SLOW,
    );

    it(
      'an adapter in its bypass mode: every task is refused before any prompt is sent',
      async () => {
        const r = (repo = createDemoRepo());
        const sim = useSimulatedHarness(
          r,
          id,
          { 'update-button-color': { writes: demoWrites('update-button-color') } },
          { mode: BYPASS[id] },
        );
        const before = r.read('src/styles/button.css');
        const run = await cli(r, ['run', TEST_1, '--agent', id, '--run-id', `b-${id}`, '--json']);
        expect(run.code).toBe(2);
        const out = parse(run.stdout);
        for (const t of out.report.tasks) expect(t.complete).toBe(false);
        expect(sim.log().some((e) => e.method === 'session/prompt')).toBe(false);
        expect(r.read('src/styles/button.css')).toBe(before);
      },
      SLOW,
    );

    it(
      'sign-in needed: tasks are blocked and soot never authenticates',
      async () => {
        const r = (repo = createDemoRepo());
        const sim = useSimulatedHarness(r, id, {}, { requireAuth: true });
        const run = await cli(r, ['run', TEST_1, '--agent', id, '--run-id', `a-${id}`, '--json']);
        expect(run.code).toBe(2);
        for (const t of parse(run.stdout).report.tasks) expect(t.complete).toBe(false);
        expect(sim.log().some((e) => e.method === 'authenticate')).toBe(false);
      },
      SLOW,
    );
  },
);

describe('harness runners: explicit configuration only', () => {
  it('refuses without a harnesses entry and spawns nothing', async () => {
    const r = (repo = createDemoRepo());
    const run = await cli(r, ['run', TEST_1, '--agent', 'codex']);
    expect(run.code).toBe(1);
    expect(run.stderr + run.stdout).toContain('--agent codex needs "harnesses"');
    expect(run.stderr + run.stdout).toContain('never picks, installs or searches for one');
  });

  it.each([
    [{ command: 'claude-agent-acp' }, 'must be an absolute path'],
    [{ command: '/opt/x', args: ['--dangerously-skip-permissions'] }, 'would skip or bypass'],
    [{ command: '/opt/x', args: ['-a', 'never'] }, 'would skip or bypass'],
    [{ command: '/opt/x', passEnv: ['ANTHROPIC_API_KEY'] }, 'credential-like variables'],
  ])('rejects the harness config %j', async (entry, message) => {
    const r = (repo = createDemoRepo());
    const configPath = join(r.root, 'soot.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config.harnesses = { 'claude-code': entry };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    r.commitAll('bad harness config');
    const run = await cli(r, ['config', '--json']);
    expect(run.code).toBe(1);
    expect(run.stderr + run.stdout).toContain(message);
  });

  it('the generic acpAgent also refuses approval-bypass arguments', async () => {
    const r = (repo = createDemoRepo());
    const configPath = join(r.root, 'soot.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config.acpAgent = { command: '/opt/x', args: ['--yolo'] };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    r.commitAll('bad acp config');
    const run = await cli(r, ['config', '--json']);
    expect(run.code).toBe(1);
    expect(run.stderr + run.stdout).toContain('would skip or bypass');
  });

  it('soot config lists the harness runners as simulated-only', async () => {
    const r = (repo = createDemoRepo());
    useSimulatedHarness(r, 'claude-code', {});
    const run = await cli(r, ['config']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Harness runners (simulated-only, ADR-047): claude-code ');
    expect(run.stdout).toContain('codex not configured');
  });
});
