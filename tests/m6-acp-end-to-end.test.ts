/**
 * Milestone 6 (local, mock-backed): `soot run --agent acp` spawns the ACP agent command the user
 * configured and drives it with soot's generic ACP driver (ADR-027). The configured command
 * here is soot's own scripted mock ACP agent (`node .../mock-agent-bin.js`); no vendor harness,
 * model, key or network is involved, and nothing here verifies any vendor integration.
 */
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

interface MockStep {
  writes?: Record<string, string>;
  permission?: { title: string };
  message?: string;
}

const demoWrites = (id: string): Record<string, string> => {
  const mock = JSON.parse(readFileSync(join(DEMO_APP, 'mock-agent.json'), 'utf8')) as {
    tasks: Record<string, { writes: Record<string, string> }>;
  };
  const step = mock.tasks[id];
  if (step === undefined) throw new Error(`no demo writes for ${id}`);
  return step.writes;
};

/** Configure the demo repo to spawn the mock ACP agent; script and log live outside the repo. */
function useMockAcpAgent(
  r: DemoRepo,
  tasks: Record<string, MockStep>,
  extra: Record<string, unknown> = {},
  scriptExtra: Record<string, unknown> = {},
): { log: () => Record<string, unknown>[]; logPath: string } {
  const scriptPath = join(r.top, 'mock-acp-script.json');
  const logPath = join(r.top, 'mock-acp-log.jsonl');
  writeFileSync(
    scriptPath,
    JSON.stringify({ version: 1, label: 'test double', tasks, ...scriptExtra }),
  );
  const configPath = join(r.root, 'soot.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  config.acpAgent = {
    command: process.execPath,
    args: [MOCK_ACP_BIN, scriptPath, logPath],
    ...extra,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  r.commitAll('use the mock ACP agent');
  return {
    logPath,
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
  historySamples: number;
  acpRoutes: {
    taskId: string;
    attempt: number;
    routed: string | null;
    applied: boolean;
    reason: string;
  }[];
  report: {
    status: string;
    workingTree: { updated: boolean; reason: string };
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

describe('soot run --agent acp with the mock ACP agent (spec §17 Test 1 prompt)', () => {
  it(
    'unattended: the task whose agent asks permission is refused; the independent task is verified and merged',
    async () => {
      const r = (repo = createDemoRepo());
      const acp = useMockAcpAgent(r, {
        'update-page-title': {
          permission: { title: 'Edit src/pages/index.html' },
          writes: demoWrites('update-page-title'),
        },
        'update-button-color': {
          writes: demoWrites('update-button-color'),
          message: 'button done',
        },
      });
      const head = r.git('rev-parse', 'HEAD');
      const before = r.read('src/pages/index.html');
      // A key-like variable in soot's environment must never reach the agent process.
      r.env.FAKE_PROVIDER_API_KEY = 'sk-should-never-reach-the-agent';

      const run = await cli(r, ['run', TEST_1, '--agent', 'acp', '--run-id', 'acp1', '--json']);
      expect(run.code).toBe(2);
      const out = parse(run.stdout);
      expect(out.agent).toBe('acp');
      expect(out.agentLabel).toContain('generic ACP driver');
      expect(taskOf(out, 'update-button-color')).toMatchObject({
        verdict: 'verified',
        integration: 'merged',
        complete: true,
      });
      const title = taskOf(out, 'update-page-title');
      expect(title?.complete).toBe(false);
      // Refused, not retried or escalated: a refused approval is terminal (ADR-018).
      expect(title).toMatchObject({
        reason: 'agent-not-succeeded: agent reported blocked',
        integration: 'not-integrated',
        attempts: 1,
      });
      const audit = readFileSync(join(r.dataDir, 'audit', 'acp1.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l.includes('approval-answered'));
      const answered = audit.join('\n');
      expect(answered).toContain('"harness-permission"');
      expect(answered).toContain('"unavailable"');

      // The user's tree is untouched; the verified change waits on the integration branch.
      expect(r.git('rev-parse', 'HEAD')).toBe(head);
      expect(r.read('src/pages/index.html')).toBe(before);
      expect(r.git('show', 'soot/acp1/integration:src/styles/button.css')).toContain('purple');
      expect(r.git('show', 'soot/acp1/integration:src/pages/index.html')).toBe(before.trimEnd());

      const log = acp.log();
      const methods = log.map((e) => e.method);
      // One agent process per attempt, each started in its own soot worktree.
      const starts = log.filter((e) => e.method === 'start');
      expect(starts.length).toBeGreaterThanOrEqual(2);
      expect(new Set(starts.map((s) => s.pid)).size).toBe(starts.length);
      for (const s of starts) {
        expect(String(s.cwd).startsWith(join(r.dataDir, 'worktrees', 'acp1'))).toBe(true);
        const names = s.env as string[];
        expect(names).not.toContain('FAKE_PROVIDER_API_KEY');
        expect(names).not.toContain('SOOT_DATA_DIR');
        expect(names).not.toContain('GIT_CONFIG_GLOBAL');
        expect(names).toContain('HOME');
      }
      // The permission request was rejected for the agent; soot never selected an allow option.
      const answers = log.filter((e) => e.method === 'permission-answer').map((e) => e.outcome);
      expect(answers.length).toBeGreaterThanOrEqual(1);
      for (const a of answers) expect(a).toEqual({ outcome: 'selected', optionId: 'reject' });
      // soot never authenticates or changes the agent's mode/config (host approval settings).
      for (const m of ['authenticate', 'session/set_mode', 'session/set_config_option']) {
        expect(methods).not.toContain(m);
      }
    },
    SLOW,
  );

  it(
    'interactive: a person approves the tool call and the fast-forward; both tasks land',
    async () => {
      const r = (repo = createDemoRepo());
      const acp = useMockAcpAgent(r, {
        'update-page-title': {
          permission: { title: 'Edit src/pages/index.html' },
          writes: demoWrites('update-page-title'),
        },
        'update-button-color': { writes: demoWrites('update-button-color') },
      });
      const run = await cli(
        r,
        ['run', TEST_1, '--agent', 'acp', '--run-id', 'acp2', '--interactive', '--json'],
        { stdin: 'y\ny\n' },
      );
      expect(run.stderr).toContain('approval needed (harness-permission) for update-page-title');
      expect(run.stderr).toContain('approval needed (integrate-into-working-tree)');
      expect(run.code).toBe(0);
      const out = parse(run.stdout);
      expect(out.report.status).toBe('complete');
      expect(out.report.workingTree.updated).toBe(true);
      expect(r.read('src/pages/index.html')).toContain('HELLO WORLD');
      expect(r.read('src/styles/button.css')).toContain('purple');
      const answers = acp.log().filter((e) => e.method === 'permission-answer');
      expect(answers.map((e) => e.outcome)).toEqual([{ outcome: 'selected', optionId: 'allow' }]);
    },
    SLOW,
  );

  it(
    'the agent advertises a "model" option: soot applies the routed model per attempt and records it',
    async () => {
      const r = (repo = createDemoRepo());
      const acp = useMockAcpAgent(
        r,
        {
          'update-page-title': { writes: demoWrites('update-page-title') },
          'update-button-color': { writes: demoWrites('update-button-color') },
        },
        {},
        {
          models: {
            current: 'claude-opus-5-5',
            values: ['claude-haiku-5-5', 'gpt-6.1-terra', 'claude-opus-5-5'],
          },
        },
      );
      const run = await cli(r, ['run', TEST_1, '--agent', 'acp', '--run-id', 'route1', '--json']);
      const out = parse(run.stdout);
      expect(out.acpRoutes.map((x) => [x.taskId, x.routed, x.applied]).sort()).toEqual([
        ['update-button-color', 'anthropic/claude-haiku-5-5', true],
        ['update-page-title', 'anthropic/claude-haiku-5-5', true],
      ]);
      // The agent really ran each prompt on the model soot routed.
      const prompts = acp.log().filter((e) => e.method === 'session/prompt');
      expect(prompts.map((e) => e.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5']);
      const sets = acp.log().filter((e) => e.method === 'session/set_config_option');
      expect(sets.map((e) => [e.configId, e.value])).toEqual([
        ['model', 'claude-haiku-5-5'],
        ['model', 'claude-haiku-5-5'],
      ]);
      // Applied routes count as routing history: the next run sees them.
      const second = await cli(r, [
        'run',
        TEST_1,
        '--agent',
        'acp',
        '--run-id',
        'route2',
        '--json',
      ]);
      expect(parse(second.stdout).historySamples).toBe(2);
      const text = await cli(r, ['status', 'route1']);
      expect(text.code).toBe(0);
    },
    SLOW,
  );

  it(
    'the agent does not advertise a "model" option: the report says the route was not applied, and nothing is credited',
    async () => {
      const r = (repo = createDemoRepo());
      const acp = useMockAcpAgent(r, {
        'update-page-title': { writes: demoWrites('update-page-title') },
        'update-button-color': { writes: demoWrites('update-button-color') },
      });
      const run = await cli(r, ['run', TEST_1, '--agent', 'acp', '--run-id', 'route3']);
      expect(run.stdout).toContain('ACP model routing:');
      expect(run.stdout).toMatch(
        /- update-page-title #1: NOT applied: route not applied: the agent does not advertise a "model" config option/,
      );
      expect(run.stderr).toContain('ACP model NOT applied');
      expect(acp.log().some((e) => e.method === 'session/set_config_option')).toBe(false);
      const saved = JSON.parse(
        readFileSync(join(r.dataDir, 'reports', 'route3.json'), 'utf8'),
      ) as RunJson;
      expect(saved.acpRoutes).toHaveLength(2);
      expect(
        saved.acpRoutes.every((x) => !x.applied && x.routed === 'anthropic/claude-haiku-5-5'),
      ).toBe(true);
      const second = await cli(r, [
        'run',
        TEST_1,
        '--agent',
        'acp',
        '--run-id',
        'route4',
        '--json',
      ]);
      expect(parse(second.stdout).historySamples).toBe(0);
    },
    SLOW,
  );
});

describe('soot run --agent acp: explicit configuration only', () => {
  it('refuses without an acpAgent command and spawns nothing', async () => {
    const r = (repo = createDemoRepo());
    const run = await cli(r, ['run', TEST_1, '--agent', 'acp']);
    expect(run.code).toBe(1);
    expect(run.stderr + run.stdout).toContain('needs an "acpAgent" command');
    expect(run.stderr + run.stdout).toContain('never picks or searches for one');
  });

  it('the default path is unchanged: no --agent still refuses, and --mock-script is not accepted with acp', async () => {
    const r = (repo = createDemoRepo());
    useMockAcpAgent(r, {});
    const none = await cli(r, ['run', TEST_1]);
    expect(none.code).toBe(1);
    expect(none.stderr + none.stdout).toContain('no agent runner selected');
    const both = await cli(r, [
      'run',
      TEST_1,
      '--agent',
      'acp',
      '--mock-script',
      'mock-agent.json',
    ]);
    expect(both.code).toBe(1);
  });

  it('rejects credential-like passEnv names in the config', async () => {
    const r = (repo = createDemoRepo());
    useMockAcpAgent(r, {}, { passEnv: ['OPENAI_API_KEY'] });
    const run = await cli(r, ['config', '--json']);
    expect(run.code).toBe(1);
    expect(run.stderr + run.stdout).toContain('credential-like variables are never passed');
  });

  it('soot config shows the configured ACP command', async () => {
    const r = (repo = createDemoRepo());
    useMockAcpAgent(r, {});
    const run = await cli(r, ['config']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`ACP agent command: ${process.execPath} ${MOCK_ACP_BIN}`);
  });
});
