/**
 * `soot run --agent api` end to end (ADR-039) on a copy of the demo app, with a fake
 * OpenAI-compatible server standing in for the provider: each task goes to its routed model,
 * the returned files are committed, verified by soot's own checks, merged, and with `--apply`
 * landed on the user's branch. Usage and cost come from the server's reported tokens.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unattendedApprovals, withApply } from '../apps/cli/src/approvals.js';
import { SootEngine, routingOutcomes } from '../apps/cli/src/engine.js';
import { TEST_1, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';
import { startFakeOpenAi, taskIdOf, type FakeOpenAi } from './helpers/fake-openai.js';

const FAKE_KEY = 'fake-e2e-key-not-a-secret-0002';
let repo: DemoRepo | null = null;
let server: FakeOpenAi | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
  repo?.dispose();
  repo = null;
});

const FILES: Record<string, { path: string; content: (old: string) => string }> = {
  'update-page-title': {
    path: 'src/pages/index.html',
    content: (old) => old.replaceAll('>Demo<', '>HELLO WORLD<'),
  },
  'update-button-color': {
    path: 'src/styles/button.css',
    content: (old) => old.replace('background: blue;', 'background: purple;'),
  },
};

async function setup(): Promise<DemoRepo> {
  const r = (repo = createDemoRepo());
  server = await startFakeOpenAi((req) => {
    const id = taskIdOf(req);
    const spec = FILES[id];
    if (spec === undefined) return { status: 400, error: `unexpected task ${id}` };
    const user = req.body.messages.find((m) => m.role === 'user')?.content ?? '';
    const old =
      new RegExp(`=== ${spec.path} ===\\n([\\s\\S]*?)=== end ${spec.path} ===`).exec(user)?.[1] ??
      '';
    return {
      content: JSON.stringify({
        summary: `did ${id}`,
        edits: [{ path: spec.path, content: spec.content(old) }],
      }),
      promptTokens: id === 'update-page-title' ? 900 : 700,
      completionTokens: 120,
    };
  });
  r.write(
    'models.json',
    JSON.stringify({
      version: 1,
      providers: [
        { id: 'fake', kind: 'openai-compatible', baseURL: server.baseURL, apiKeyEnv: 'FAKE_KEY' },
      ],
      models: [
        {
          provider: 'fake',
          modelId: 'coder',
          capabilities: {
            tools: true,
            structuredOutput: true,
            reasoning: true,
            vision: true,
            streaming: true,
          },
          pricing: {
            inputPerMTokUsd: 1,
            outputPerMTokUsd: 4,
            source: 'test price',
            asOf: '2026-11-13',
          },
          reliability: { low: 0.9, medium: 0.9, high: 0.9, source: 'test prior' },
        },
      ],
    }),
  );
  r.commitAll('use the fake provider');
  return r;
}

const engineFor = (r: DemoRepo, apply: boolean) =>
  new SootEngine({
    cwd: r.root,
    dataDir: r.dataDir,
    agent: { kind: 'api' },
    approvals: apply ? withApply(unattendedApprovals()) : unattendedApprovals(),
    gitEnv: r.env,
    modelEnv: { FAKE_KEY, SOOT_LOCAL_MODELS: 'off' },
  });

interface Saved {
  agent: string;
  report: {
    status: string;
    workingTree: { updated: boolean; reason: string };
    problems: string[];
    cost: {
      tasks: {
        taskId: string;
        attempts: {
          model: string;
          status: string;
          inputTokens: number;
          outputTokens: number;
          actualUsd: number | null;
        }[];
      }[];
    };
  };
}

describe('soot run --agent api', () => {
  it('runs each task on its routed model, verifies, merges and (with --apply) lands the result', async () => {
    const r = await setup();
    const out = await engineFor(r, true).run({ prompt: TEST_1, runId: 'api-1' });
    expect(out.ok).toBe(true);
    const saved = JSON.parse(
      readFileSync(join(r.dataDir, 'reports', 'api-1.json'), 'utf8'),
    ) as Saved;
    expect(saved.agent).toBe('api');
    expect(saved.report.problems).toEqual([]);
    expect(saved.report.status).toBe('complete');
    expect(saved.report.workingTree.updated).toBe(true);
    expect(r.read('src/pages/index.html')).toContain('<title>HELLO WORLD</title>');
    expect(r.read('src/styles/button.css')).toMatch(/\.btn-primary \{\n {2}background: purple;/);
    expect(server?.requests.map(taskIdOf).sort()).toEqual([
      'update-button-color',
      'update-page-title',
    ]);
    const title = saved.report.cost.tasks.find((t) => t.taskId === 'update-page-title');
    expect(title?.attempts).toEqual([
      expect.objectContaining({
        model: 'fake/coder',
        status: 'succeeded',
        inputTokens: 900,
        outputTokens: 120,
        actualUsd: (900 * 1 + 120 * 4) / 1e6,
      }),
    ]);
    expect(readFileSync(join(r.dataDir, 'reports', 'api-1.json'), 'utf8')).not.toContain(FAKE_KEY);
  });

  it('without --apply the verified result stays on soot/<run>/integration and the run says why', async () => {
    const r = await setup();
    const out = await engineFor(r, false).run({ prompt: TEST_1, runId: 'api-2' });
    const saved = JSON.parse(
      readFileSync(join(r.dataDir, 'reports', 'api-2.json'), 'utf8'),
    ) as Saved;
    expect(out.ok).toBe(true);
    expect(saved.report.status).toBe('incomplete');
    expect(saved.report.workingTree.reason).toMatch(
      /approval unavailable; result left on soot\/api-2\/integration/,
    );
    expect(r.read('src/pages/index.html')).toContain('<title>Demo</title>');
    expect(r.git('show', 'soot/api-2/integration:src/pages/index.html')).toContain('HELLO WORLD');
  });
});

describe('routing history and flags (ADR-039)', () => {
  it('test-double outcomes never shape real-model routing; mock runs still see them', () => {
    const o = (runner: string | undefined, run: string) => ({
      runId: run,
      taskId: 't',
      attempt: 1,
      model: 'p/m',
      tier: 'low' as const,
      outcome: 'failed' as const,
      reason: 'x',
      ...(runner === undefined ? {} : { runner }),
    });
    const all = [
      o('mock', 'a'),
      o('unknown', 'b'),
      o('api', 'c'),
      o('acp', 'd'),
      o(undefined, 'e'),
    ];
    expect(routingOutcomes(all, 'api').map((x) => x.runId)).toEqual(['c', 'd']);
    expect(routingOutcomes(all, 'acp').map((x) => x.runId)).toEqual(['c', 'd']);
    expect(routingOutcomes(all, 'mock')).toHaveLength(5);
  });

  it('--apply needs --agent and only applies to run and dashboard; --agent api takes no mock script', async () => {
    const r = (repo = createDemoRepo());
    const { main } = await import('../apps/cli/src/cli.js');
    const call = async (args: string[]) => {
      let err = '';
      const code = await main(args, {
        stdout: () => undefined,
        stderr: (t) => (err += t),
        stdin: process.stdin,
        stdinIsTTY: false,
        env: r.env,
        cwd: r.root,
      });
      return { code, err };
    };
    const refused = async (args: string[], why: RegExp) => {
      const res = await call(args);
      expect(res.code).toBe(1);
      expect(res.err).toMatch(why);
    };
    await refused(['run', 'x', '--apply'], /--apply needs --agent/);
    await refused(
      ['status', '--agent', 'api', '--apply'],
      /--apply is only for soot run and soot dashboard/,
    );
    await refused(
      ['run', 'x', '--agent', 'api', '--mock-script', 'm.json'],
      /--mock-script is only for --agent mock/,
    );
    await refused(['dashboard', 'list', '--apply'], /--apply/);
    await refused(
      ['dashboard', 'list', '--agent', 'api', '--apply'],
      /takes no --port, --open, --agent or --apply/,
    );
  });
});
