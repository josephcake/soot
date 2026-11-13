import {
  InteractiveApprovalGate,
  UNATTENDED_APPROVALS,
  type AgentTaskInput,
  type ApprovalGate,
  type ApprovalRequest,
} from '@soot/agent-runtime';
import { validateAgentResult, type AgentResult, type Task } from '@soot/task-graph';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcpAgentRunner,
  createMockAcpAgent,
  permissionOutcome,
  matchModelValue,
  type AcpConnector,
  type AcpRouteRecord,
  type MockAcpLog,
  type MockAcpScript,
} from '../index.js';

/*
 * The generic ACP driver against soot's own scripted mock ACP agent (in process, official ACP
 * SDK on both sides). No vendor binary, model or network is involved.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'soot-acp-')));
  dirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\nworld\n');
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

interface Harness {
  readonly connect: AcpConnector;
  readonly log: MockAcpLog;
  readonly closed: { count: number };
}

function mock(script: MockAcpScript): Harness {
  const log: MockAcpLog = { methods: [], permissionOutcomes: [], writeErrors: [], prompts: [] };
  const closed = { count: 0 };
  return {
    log,
    closed,
    connect: () => ({
      target: createMockAcpAgent(script, log).app,
      label: 'in-process mock',
      close: () => {
        closed.count++;
      },
    }),
  };
}

function input(
  t: Task,
  root: string,
  gate: ApprovalGate,
  asked: ApprovalRequest[] = [],
): AgentTaskInput {
  return {
    task: t,
    attempt: 1,
    dependencyResults: [],
    workspace: { root, writeScope: t.files.write },
    permissions: {
      requestApproval: (r, s) => {
        const req = { ...r, taskId: t.id };
        asked.push(req);
        return gate.request(req, s);
      },
    },
  };
}

async function runOnce(
  h: Harness,
  t: Task,
  root: string,
  gate: ApprovalGate,
  asked: ApprovalRequest[] = [],
  signal = new AbortController().signal,
): Promise<AgentResult> {
  const runner = new AcpAgentRunner({
    connect: h.connect,
    approvals: gate.mode,
    cancelGraceMs: 200,
  });
  const raw = await runner.run(input(t, root, gate, asked), signal);
  const parsed = validateAgentResult(raw);
  if (!parsed.ok) throw new Error('invalid result');
  return parsed.value;
}

describe('AcpAgentRunner (generic ACP driver) with the mock ACP agent', () => {
  it('starts a session in the worktree, sends the task, and receives the result', async () => {
    const root = workspace();
    const h = mock({
      version: 1,
      tasks: {
        title: {
          writes: { 'src/index.html': '<title>HELLO</title>' },
          reads: ['README.md'],
          message: 'done',
          costUsd: 0.25,
        },
      },
    });
    const result = await runOnce(h, task('title', ['src/index.html']), root, UNATTENDED_APPROVALS);

    expect(result.status).toBe('succeeded');
    expect(result.summary).toContain('ended its turn');
    expect(result.summary).toContain('done');
    expect(result.usage.costUsd).toBe(0.25);
    expect(result.usage.model).toBeNull();
    expect(readFileSync(join(root, 'src/index.html'), 'utf8')).toBe('<title>HELLO</title>');
    // Exactly the ACP calls soot needs: no authenticate, no set_mode / set_config_option.
    expect(h.log.methods).toEqual(['initialize', 'session/new', 'session/prompt']);
    expect(h.log.writeErrors).toEqual([]);
    expect(h.log.prompts[0]).toContain('Task title: Task title for title');
    expect(h.log.prompts[0]).toContain('You may write only: src/index.html');
    expect(h.closed.count).toBe(1);
  });

  it('unattended: a permission request is rejected, nothing is written, and the task is refused', async () => {
    const root = workspace();
    const h = mock({
      version: 1,
      tasks: { t: { permission: { title: 'Edit config' }, writes: { 'a.txt': 'x' } } },
    });
    const asked: ApprovalRequest[] = [];
    const result = await runOnce(h, task('t', ['a.txt']), root, UNATTENDED_APPROVALS, asked);

    expect(result.status).toBe('blocked');
    expect(result.summary).toContain('approval unavailable');
    expect(asked).toEqual([
      {
        taskId: 't',
        action: 'harness-permission',
        detail: expect.stringContaining('Edit config') as string,
      },
    ]);
    expect(h.log.permissionOutcomes).toEqual([{ outcome: 'selected', optionId: 'reject' }]);
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
  });

  it('interactive: soot waits for a person; approval selects "allow once", never "always"', async () => {
    const root = workspace();
    const h = mock({
      version: 1,
      tasks: { t: { permission: { title: 'Edit a.txt' }, writes: { 'a.txt': 'approved' } } },
    });
    const gate = new InteractiveApprovalGate();
    let seenWhilePending: string[] = [];
    gate.onRequest((p) => {
      seenWhilePending = [...h.log.methods];
      setTimeout(() => {
        gate.answer(p.id, 'approved');
      }, 30);
    });
    const result = await runOnce(h, task('t', ['a.txt']), root, gate);

    expect(seenWhilePending).toEqual(['initialize', 'session/new', 'session/prompt']);
    expect(result.status).toBe('succeeded');
    expect(h.log.permissionOutcomes).toEqual([{ outcome: 'selected', optionId: 'allow' }]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('approved');
  });

  it('interactive: a denial rejects the tool call and refuses the task', async () => {
    const root = workspace();
    const h = mock({
      version: 1,
      tasks: {
        t: { permission: { title: 'Delete things', kind: 'delete' }, writes: { 'a.txt': 'x' } },
      },
    });
    const gate = new InteractiveApprovalGate();
    gate.onRequest((p) => {
      gate.answer(p.id, 'denied');
    });
    const result = await runOnce(h, task('t', ['a.txt']), root, gate);
    expect(result.status).toBe('blocked');
    expect(result.summary).toContain('approval denied');
    expect(h.log.permissionOutcomes).toEqual([{ outcome: 'selected', optionId: 'reject' }]);
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
  });

  it('refuses writes outside the write lease or the worktree, and reads outside the worktree', async () => {
    const root = workspace();
    const outside = workspace();
    const h = mock({
      version: 1,
      tasks: {
        t: {
          writes: {
            'allowed.txt': 'ok',
            'other.txt': 'no',
            [join(outside, 'escape.txt')]: 'no',
            '.git/config': 'no',
          },
          reads: [join(outside, 'README.md')],
        },
      },
    });
    const result = await runOnce(h, task('t', ['allowed.txt']), root, UNATTENDED_APPROVALS);

    expect(readFileSync(join(root, 'allowed.txt'), 'utf8')).toBe('ok');
    expect(existsSync(join(root, 'other.txt'))).toBe(false);
    expect(existsSync(join(outside, 'escape.txt'))).toBe(false);
    expect(h.log.writeErrors).toHaveLength(4);
    expect(result.findings.filter((f) => f.kind === 'issue').map((f) => f.message)).toEqual([
      expect.stringContaining('read outside the task worktree refused') as string,
      expect.stringContaining("write outside the task's write lease refused: other.txt") as string,
      expect.stringContaining('write outside the task worktree refused') as string,
      expect.stringContaining('write outside the task worktree refused') as string,
    ]);
  });

  it('read-only tasks cannot write at all', async () => {
    const root = workspace();
    const h = mock({ version: 1, tasks: { r: { writes: { 'x.txt': 'no' } } } });
    await runOnce(h, task('r', []), root, UNATTENDED_APPROVALS);
    expect(existsSync(join(root, 'x.txt'))).toBe(false);
    expect(h.log.writeErrors).toHaveLength(1);
  });

  it('never signs in: an agent that needs authentication blocks the task', async () => {
    const root = workspace();
    const h = mock({ version: 1, requireAuth: true, tasks: {} });
    const result = await runOnce(h, task('t', ['a.txt']), root, UNATTENDED_APPROVALS);
    expect(result.status).toBe('blocked');
    expect(result.summary).toContain('requires authentication');
    expect(h.log.methods).toEqual(['initialize', 'session/new']);
  });

  it('maps stop reasons other than end_turn to failure', async () => {
    const root = workspace();
    const h = mock({ version: 1, tasks: { t: { stopReason: 'refusal', message: 'no' } } });
    const result = await runOnce(h, task('t', ['a.txt']), root, UNATTENDED_APPROVALS);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('stopped (refusal)');
  });

  it('cancellation sends session/cancel and rejects as an abort', async () => {
    const root = workspace();
    const h = mock({ version: 1, tasks: { t: { delayMs: 10_000 } } });
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 50);
    const started = Date.now();
    await expect(
      runOnce(h, task('t', ['a.txt']), root, UNATTENDED_APPROVALS, [], ac.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(h.log.methods).toContain('session/cancel');
    expect(h.closed.count).toBe(1);
  });

  it('an agent that ignores cancel is cut off after the grace period', async () => {
    const root = workspace();
    const h = mock({ version: 1, tasks: { t: { delayMs: 10_000, ignoreCancel: true } } });
    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 50);
    const started = Date.now();
    await expect(
      runOnce(h, task('t', ['a.txt']), root, UNATTENDED_APPROVALS, [], ac.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses to run without a soot worktree', async () => {
    const h = mock({ version: 1, tasks: {} });
    const runner = new AcpAgentRunner({ connect: h.connect, approvals: 'unattended' });
    await expect(
      runner.run(
        { task: task('t', []), attempt: 1, dependencyResults: [] },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/needs a soot worktree/);
    expect(h.log.methods).toEqual([]);
  });
});

describe('AcpAgentRunner: applying the routed model (ADR-028)', () => {
  const routedInput = (t: Task, root: string, model: string): AgentTaskInput => ({
    ...input(t, root, UNATTENDED_APPROVALS),
    assignment: {
      model,
      reason: 'routed by test',
      escalationLevel: 0,
      estimatedCostUsd: null,
      tier: 'low',
    },
  });

  async function routed(script: MockAcpScript, model = 'anthropic/claude-haiku-5-5') {
    const root = workspace();
    const h = mock(script);
    const routes: AcpRouteRecord[] = [];
    const runner = new AcpAgentRunner({
      connect: h.connect,
      approvals: 'unattended',
      onRoute: (r) => routes.push(r),
    });
    const raw = await runner.run(
      routedInput(task('t', ['a.txt']), root, model),
      new AbortController().signal,
    );
    const parsed = validateAgentResult(raw);
    if (!parsed.ok) throw new Error('invalid result');
    return { result: parsed.value, routes, h };
  }

  it('the agent advertises a model option: soot sets it, and the attempt records the routed model', async () => {
    const { result, routes, h } = await routed({
      version: 1,
      models: {
        current: 'claude-opus-5-5',
        values: ['claude-haiku-5-5', 'gpt-6.1-terra', 'claude-opus-5-5'],
        behaviour: 'apply',
      },
      tasks: { t: { writes: { 'a.txt': 'x' } } },
    });
    expect(h.log.methods).toEqual([
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/prompt',
    ]);
    expect(routes).toEqual([
      {
        taskId: 't',
        attempt: 1,
        routed: 'anthropic/claude-haiku-5-5',
        applied: true,
        agentValue: 'claude-haiku-5-5',
        reason: 'routed model anthropic/claude-haiku-5-5 applied as "model" = claude-haiku-5-5',
      },
    ]);
    expect(result.usage.model).toBe('anthropic/claude-haiku-5-5');
    expect(result.findings).toContainEqual({
      kind: 'decision',
      message:
        'ACP model routing: routed model anthropic/claude-haiku-5-5 applied as "model" = claude-haiku-5-5',
    });
    // Tokens are never invented: ACP v1 reports none.
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
  });

  it('the agent does not advertise a model option: the route is recorded as not applied', async () => {
    const { result, routes, h } = await routed({
      version: 1,
      tasks: { t: { writes: { 'a.txt': 'x' } } },
    });
    expect(h.log.methods).toEqual(['initialize', 'session/new', 'session/prompt']);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      applied: false,
      routed: 'anthropic/claude-haiku-5-5',
      agentValue: null,
    });
    expect(routes[0]?.reason).toContain('does not advertise a "model" config option');
    expect(result.usage.model).toBeNull();
    expect(result.findings.some((f) => f.message.includes('route not applied'))).toBe(true);
    expect(result.status).toBe('succeeded');
  });

  it('records not applied when no value matches, the agent refuses, or it does not confirm', async () => {
    const tasks = { t: { writes: { 'a.txt': 'x' } } };
    const noMatch = await routed({
      version: 1,
      models: { current: 'm1', values: ['m1', 'm2'], behaviour: 'apply' },
      tasks,
    });
    expect(noMatch.routes[0]?.reason).toContain(
      'offers no value for anthropic/claude-haiku-5-5 (offered: m1, m2)',
    );
    expect(noMatch.h.log.methods).not.toContain('session/set_config_option');

    const refused = await routed({
      version: 1,
      models: {
        current: 'gpt-6.1-terra',
        values: ['claude-haiku-5-5', 'gpt-6.1-terra'],
        behaviour: 'refuse',
      },
      tasks,
    });
    expect(refused.routes[0]?.applied).toBe(false);
    expect(refused.routes[0]?.reason).toContain('the agent refused claude-haiku-5-5');

    const ignored = await routed({
      version: 1,
      models: {
        current: 'gpt-6.1-terra',
        values: ['claude-haiku-5-5', 'gpt-6.1-terra'],
        behaviour: 'ignore',
      },
      tasks,
    });
    expect(ignored.routes[0]?.applied).toBe(false);
    expect(ignored.routes[0]?.reason).toContain('did not confirm claude-haiku-5-5');
    for (const r of [noMatch, refused, ignored]) expect(r.result.usage.model).toBeNull();
  });

  it('matches the full ref first, then the id after the provider', () => {
    expect(
      matchModelValue('anthropic/claude-haiku-5-5', [
        'anthropic/claude-haiku-5-5',
        'claude-haiku-5-5',
      ]),
    ).toBe('anthropic/claude-haiku-5-5');
    expect(matchModelValue('anthropic/claude-haiku-5-5', ['claude-haiku-5-5'])).toBe(
      'claude-haiku-5-5',
    );
    expect(matchModelValue('anthropic/claude-haiku-5-5', ['small'])).toBeNull();
  });
});

describe('permissionOutcome', () => {
  const opts = (...kinds: ('allow_once' | 'allow_always' | 'reject_once' | 'reject_always')[]) =>
    kinds.map((kind) => ({ optionId: kind, name: kind, kind }));

  it('never selects "allow always"', () => {
    expect(permissionOutcome(opts('allow_always', 'reject_once'), 'approved')).toEqual({
      outcome: 'cancelled',
    });
    expect(permissionOutcome(opts('allow_always', 'allow_once'), 'approved')).toEqual({
      outcome: 'selected',
      optionId: 'allow_once',
    });
  });

  it('denied and unavailable reject (or cancel when no reject option exists)', () => {
    for (const d of ['denied', 'unavailable'] as const) {
      expect(permissionOutcome(opts('allow_once', 'reject_once'), d)).toEqual({
        outcome: 'selected',
        optionId: 'reject_once',
      });
      expect(permissionOutcome(opts('allow_once'), d)).toEqual({ outcome: 'cancelled' });
    }
  });
});
