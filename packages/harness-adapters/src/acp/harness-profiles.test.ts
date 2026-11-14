import {
  InteractiveApprovalGate,
  UNATTENDED_APPROVALS,
  type AgentTaskInput,
  type ApprovalGate,
} from '@soot/agent-runtime';
import { validateAgentResult, type AgentResult, type Task } from '@soot/task-graph';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HARNESS_IDS,
  HARNESS_PROFILES,
  createHarnessRunner,
  createMockAcpAgent,
  forbiddenAgentArg,
  modeRefusal,
  simulatedHarnessScript,
  type AcpConnector,
  type AcpRouteRecord,
  type HarnessAgentConfig,
  type HarnessId,
  type MockAcpLog,
  type MockAcpScript,
} from '../index.js';

/*
 * The Claude Code and Codex runner profiles (ADR-047) against SIMULATED adapters: soot's own
 * mock ACP agent scripted to look like each harness's ACP adapter. No vendor binary, model,
 * login or network is involved; nothing here verifies a real harness.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'soot-harness-')));
  dirs.push(dir);
  return dir;
}

const task = (id: string, write: string[]): Task => ({
  id,
  title: `Task title for ${id}`,
  instructions: `Edit ${write.join(', ') || 'nothing'}.`,
  acceptanceCriteria: [`${id} done`],
  requiredCapabilities: ['code-edit'],
  complexity: 'low',
  estimate: { inputTokens: 100, outputTokens: 10, costUsd: null },
  files: { read: [], write },
  dependsOn: [],
});

interface Sim {
  readonly connect: AcpConnector;
  readonly log: MockAcpLog;
  readonly closed: { count: number };
}

function simulated(script: MockAcpScript): Sim {
  const log: MockAcpLog = { methods: [], permissionOutcomes: [], writeErrors: [], prompts: [] };
  const closed = { count: 0 };
  return {
    log,
    closed,
    connect: () => ({
      target: createMockAcpAgent(script, log).app,
      label: '/opt/simulated/adapter',
      close: () => {
        closed.count++;
      },
    }),
  };
}

const CONFIG: HarnessAgentConfig = { command: '/opt/simulated/adapter', args: [] };

async function runHarness(
  id: HarnessId,
  sim: Sim,
  root: string,
  gate: ApprovalGate,
  o: {
    config?: Partial<HarnessAgentConfig>;
    model?: string;
    signal?: AbortSignal;
    write?: string[];
    routes?: AcpRouteRecord[];
  } = {},
): Promise<AgentResult> {
  const runner = createHarnessRunner(
    id,
    { ...CONFIG, cancelGraceMs: 200, ...o.config },
    {
      approvals: gate.mode,
      connect: sim.connect,
      onRoute: (r) => o.routes?.push(r),
    },
  );
  const t = task('t', o.write ?? ['a.txt']);
  const input: AgentTaskInput = {
    task: t,
    attempt: 1,
    dependencyResults: [],
    workspace: { root, writeScope: t.files.write },
    permissions: { requestApproval: (r, s) => gate.request({ ...r, taskId: t.id }, s) },
    ...(o.model === undefined
      ? {}
      : {
          assignment: {
            model: o.model,
            reason: 'routed by test',
            escalationLevel: 0,
            estimatedCostUsd: null,
            tier: 'low',
          },
        }),
  };
  const parsed = validateAgentResult(
    await runner.run(input, o.signal ?? new AbortController().signal),
  );
  if (!parsed.ok) throw new Error('invalid result');
  return parsed.value;
}

const ALLOW_ONCE: Record<HarnessId, string> = { 'claude-code': 'allow', codex: 'approved' };
const REJECT: Record<HarnessId, string> = { 'claude-code': 'reject', codex: 'abort' };

describe.each(HARNESS_IDS)('%s runner profile (simulated adapter only)', (id) => {
  const profile = HARNESS_PROFILES[id];

  it('runs a task in the worktree; reports the mode; never authenticates or changes the mode', async () => {
    const root = workspace();
    const sim = simulated(
      simulatedHarnessScript(id, { default: { writes: { 'a.txt': 'hi' }, message: 'done' } }),
    );
    const result = await runHarness(id, sim, root, UNATTENDED_APPROVALS);
    expect(result.status).toBe('succeeded');
    expect(result.summary).toContain(`${id} runner (/opt/simulated/adapter`);
    expect(result.summary).toContain('(test double)');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('hi');
    expect(sim.log.methods).toEqual(['initialize', 'session/new', 'session/prompt']);
    expect(result.findings.map((f) => f.message)).toContain(
      `ACP session mode: ${simulatedHarnessScript(id).modes?.current ?? ''}`,
    );
    // ACP v1 reports no tokens: zero means "not reported"; the model is unknown (not routed).
    expect(result.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      model: null,
    });
    expect(sim.closed.count).toBe(1);
  });

  it('interactive approval picks the adapter\'s "allow once" option, never "always"', async () => {
    const root = workspace();
    const sim = simulated(
      simulatedHarnessScript(id, {
        default: { permission: { title: 'Edit a.txt' }, writes: { 'a.txt': 'approved' } },
      }),
    );
    const gate = new InteractiveApprovalGate();
    gate.onRequest((p) => {
      gate.answer(p.id, 'approved');
    });
    const result = await runHarness(id, sim, root, gate);
    expect(result.status).toBe('succeeded');
    expect(sim.log.permissionOutcomes).toEqual([{ outcome: 'selected', optionId: ALLOW_ONCE[id] }]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('approved');
  });

  it.each(['denied', 'unattended'] as const)(
    '%s: the permission is rejected, nothing is written, the task is blocked',
    async (how) => {
      const root = workspace();
      const sim = simulated(
        simulatedHarnessScript(id, {
          default: { permission: { title: 'Run tests' }, writes: { 'a.txt': 'x' } },
        }),
      );
      let gate: ApprovalGate = UNATTENDED_APPROVALS;
      if (how === 'denied') {
        const g = new InteractiveApprovalGate();
        g.onRequest((p) => {
          g.answer(p.id, 'denied');
        });
        gate = g;
      }
      const result = await runHarness(id, sim, root, gate);
      expect(result.status).toBe('blocked');
      expect(sim.log.permissionOutcomes).toEqual([{ outcome: 'selected', optionId: REJECT[id] }]);
      expect(existsSync(join(root, 'a.txt'))).toBe(false);
    },
  );

  it.each([
    ['session/new', { requireAuth: true }],
    ['the first prompt', { requireAuthAtPrompt: true }],
  ] as const)('sign-in needed at %s: blocked, user told to sign in themselves', async (_, o) => {
    const root = workspace();
    const sim = simulated(simulatedHarnessScript(id, o));
    const result = await runHarness(id, sim, root, UNATTENDED_APPROVALS);
    expect(result.status).toBe('blocked');
    expect(result.summary).toContain('requires authentication');
    expect(result.summary).toContain(`sign in to ${profile.harness} yourself`);
    expect(sim.log.methods).not.toContain('authenticate');
  });

  it.each(
    profile.bypassModes.filter((m) => simulatedHarnessScript(id).modes?.available.includes(m)),
  )('refuses to run in the bypass mode "%s" and does not change the mode', async (mode) => {
    const root = workspace();
    const sim = simulated(
      simulatedHarnessScript(id, { mode, default: { writes: { 'a.txt': 'x' } } }),
    );
    const result = await runHarness(id, sim, root, UNATTENDED_APPROVALS);
    expect(result.status).toBe('blocked');
    expect(result.summary).toContain(`session mode is "${mode}"`);
    expect(result.summary).toContain('soot never changes the mode');
    // No prompt was sent, and no mode or config change was attempted.
    expect(sim.log.methods).toEqual(['initialize', 'session/new']);
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
  });

  it('an adapter that switches itself into a bypass mode mid-turn is cancelled and refused', async () => {
    const root = workspace();
    const bypass = profile.bypassModes[0] ?? '';
    const sim = simulated(
      simulatedHarnessScript(id, {
        default: { switchMode: bypass, delayMs: 5000, writes: { 'a.txt': 'x' } },
      }),
    );
    const started = Date.now();
    const result = await runHarness(id, sim, root, UNATTENDED_APPROVALS);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.status).toBe('blocked');
    expect(result.summary).toContain(`"${bypass}"`);
    expect(sim.log.methods).toContain('session/cancel');
  });

  it('a self-approving mode runs, and the result says the harness may approve by itself', async () => {
    const root = workspace();
    const mode = profile.selfApprovingModes[0] ?? '';
    const sim = simulated(simulatedHarnessScript(id, { mode, default: { message: 'ok' } }));
    const result = await runHarness(id, sim, root, UNATTENDED_APPROVALS, { write: [] });
    expect(result.status).toBe('succeeded');
    expect(result.findings.map((f) => f.message).join('\n')).toContain(
      `ACP session mode: ${mode} (in this mode the harness may approve some actions itself`,
    );
  });

  it('allowedModes: a reported mode outside the list is refused', async () => {
    const root = workspace();
    const mode = profile.selfApprovingModes[0] ?? '';
    const sim = simulated(simulatedHarnessScript(id, { mode }));
    const result = await runHarness(id, sim, root, UNATTENDED_APPROVALS, {
      config: { allowedModes: ['plan-only-mode'] },
    });
    expect(result.status).toBe('blocked');
    expect(result.summary).toContain('is not in allowedModes');
  });

  it('cancel sends session/cancel and rejects as an abort', async () => {
    const root = workspace();
    const sim = simulated(simulatedHarnessScript(id, { default: { delayMs: 10_000 } }));
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 50);
    await expect(
      runHarness(id, sim, root, UNATTENDED_APPROVALS, { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(sim.log.methods).toContain('session/cancel');
    expect(sim.closed.count).toBe(1);
  });

  it('an adapter stuck at startup hits the startup limit and is closed', async () => {
    const root = workspace();
    const sim = simulated(simulatedHarnessScript(id, { hangOnInitialize: true }));
    const started = Date.now();
    await expect(
      runHarness(id, sim, root, UNATTENDED_APPROVALS, { config: { startupTimeoutMs: 150 } }),
    ).rejects.toThrow(
      /did not start a session for "t" within 150 ms .*sign in to the harness yourself/,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(sim.closed.count).toBe(1);
  });

  it('an abort during startup ends the attempt as an abort and closes the adapter', async () => {
    const root = workspace();
    const sim = simulated(simulatedHarnessScript(id, { hangOnInitialize: true }));
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 50);
    const started = Date.now();
    await expect(
      runHarness(id, sim, root, UNATTENDED_APPROVALS, { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(sim.closed.count).toBe(1);
  });
});

describe('model routing through the profiles (simulated adapters)', () => {
  it("claude-code: the user's models map turns a soot ref into the adapter's alias", async () => {
    const routes: AcpRouteRecord[] = [];
    const sim = simulated(simulatedHarnessScript('claude-code', { default: {} }));
    const result = await runHarness('claude-code', sim, workspace(), UNATTENDED_APPROVALS, {
      model: 'anthropic/claude-sonnet-x',
      config: { models: { 'anthropic/claude-sonnet-x': 'sonnet' } },
      routes,
      write: [],
    });
    expect(routes[0]).toMatchObject({ applied: true, agentValue: 'sonnet' });
    expect(result.usage.model).toBe('anthropic/claude-sonnet-x');
    expect(sim.log.methods).toContain('session/set_config_option');
  });

  it('claude-code: without a map, an unmatched ref is recorded as NOT applied (model unknown)', async () => {
    const routes: AcpRouteRecord[] = [];
    const sim = simulated(simulatedHarnessScript('claude-code', { default: {} }));
    const result = await runHarness('claude-code', sim, workspace(), UNATTENDED_APPROVALS, {
      model: 'anthropic/claude-sonnet-x',
      routes,
      write: [],
    });
    expect(routes[0]).toMatchObject({ applied: false });
    expect(routes[0]?.reason).toContain('offers no value for anthropic/claude-sonnet-x');
    expect(result.usage.model).toBeNull();
  });

  it('a mapped value the adapter does not offer is NOT applied, and says why', async () => {
    const routes: AcpRouteRecord[] = [];
    const sim = simulated(simulatedHarnessScript('claude-code', { default: {} }));
    await runHarness('claude-code', sim, workspace(), UNATTENDED_APPROVALS, {
      model: 'anthropic/claude-sonnet-x',
      config: { models: { 'anthropic/claude-sonnet-x': 'not-offered' } },
      routes,
      write: [],
    });
    expect(routes[0]).toMatchObject({ applied: false });
    expect(routes[0]?.reason).toContain('your modelMap sends');
    expect(sim.log.methods).not.toContain('session/set_config_option');
  });

  it('codex: a bare model id matches the adapter value; a refusing adapter is NOT applied', async () => {
    const ok: AcpRouteRecord[] = [];
    await runHarness(
      'codex',
      simulated(simulatedHarnessScript('codex', { default: {} })),
      workspace(),
      UNATTENDED_APPROVALS,
      {
        model: 'openai/gpt-5-codex-mini',
        routes: ok,
        write: [],
      },
    );
    expect(ok[0]).toMatchObject({ applied: true, agentValue: 'gpt-5-codex-mini' });
    const refused: AcpRouteRecord[] = [];
    const result = await runHarness(
      'codex',
      simulated(simulatedHarnessScript('codex', { default: {}, modelBehaviour: 'refuse' })),
      workspace(),
      UNATTENDED_APPROVALS,
      { model: 'openai/gpt-5-codex-mini', routes: refused, write: [] },
    );
    expect(refused[0]).toMatchObject({ applied: false });
    expect(result.usage.model).toBeNull();
  });
});

describe('approval-bypass guards', () => {
  it.each([
    ['--dangerously-skip-permissions'],
    ['--dangerously-bypass-approvals-and-sandbox'],
    ['--allow-dangerously-skip-permissions'],
    ['--yolo'],
    ['--full-auto'],
    ['--permission-mode', 'bypassPermissions'],
    ['--permission-mode=bypassPermissions'],
    ['--sandbox', 'danger-full-access'],
    ['-a', 'never'],
    ['--ask-for-approval', 'never'],
    ['--ask-for-approval=never'],
    ['-c', 'approval_policy="never"'],
  ])('refuses %s', (...args: string[]) => {
    expect(forbiddenAgentArg(args)).not.toBeNull();
  });

  it('allows ordinary arguments', () => {
    expect(forbiddenAgentArg(['--verbose', '-a', 'on-request', '--model', 'x'])).toBeNull();
    expect(forbiddenAgentArg([])).toBeNull();
  });

  it('createHarnessRunner refuses bypass flags and a command that is not an absolute path', () => {
    expect(() =>
      createHarnessRunner(
        'codex',
        { command: '/opt/a', args: ['--yolo'] },
        { approvals: 'unattended' },
      ),
    ).toThrow(/would skip or bypass/);
    expect(() =>
      createHarnessRunner('claude-code', { command: 'some-adapter' }, { approvals: 'unattended' }),
    ).toThrow(/must be an absolute path/);
  });

  it('modeRefusal: bypass modes and allowedModes', () => {
    const policy = { bypassModes: ['bypassPermissions'] };
    expect(modeRefusal('bypassPermissions', policy)).toContain('turns the harness');
    expect(modeRefusal('default', policy)).toBeNull();
    expect(modeRefusal(null, policy)).toBeNull();
    expect(modeRefusal(null, { ...policy, allowedModes: ['default'] })).toContain(
      'reports no session mode',
    );
  });
});
