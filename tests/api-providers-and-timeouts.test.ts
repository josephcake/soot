/**
 * `--agent api` across provider kinds and under time limits (ADR-040), end to end on a copy of
 * the demo app. Fake servers on 127.0.0.1 stand in for the providers: the Anthropic Messages
 * API (`x-api-key`, `anthropic-version`, content blocks, `input_tokens`/`output_tokens`) and
 * OpenAI Chat Completions (Bearer). Requests to api.anthropic.com and api.openai.com are
 * redirected to them, so catalog prices (ADR-037) apply exactly as for the real hosts.
 * No real provider and no real key is involved.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createModelClient } from '@soot/provider-adapters';
import { attemptWhy } from '../apps/dashboard/src/view.js';
import { unattendedApprovals, withApply } from '../apps/cli/src/approvals.js';
import { SootEngine } from '../apps/cli/src/engine.js';
import { createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';
import {
  startFakeOpenAi,
  taskIdOf,
  type FakeOpenAi,
  type FakeReply,
  type FakeRequest,
} from './helpers/fake-openai.js';

const KEYS = {
  FAKE_ANTHROPIC_KEY: 'fake-anthropic-key-not-a-secret-0003',
  FAKE_OPENAI_KEY: 'fake-openai-key-not-a-secret-0004',
};
let repo: DemoRepo | null = null;
const servers: FakeOpenAi[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  repo?.dispose();
  repo = null;
});

const PROMPT = 'Please retitle the demo page HELLO WORLD and make the primary button purple.';
const task = (id: string, complexity: 'low' | 'medium', write: string) => ({
  id,
  title: id,
  instructions: `Do ${id}.`,
  acceptanceCriteria: [`${id} is done`],
  requiredCapabilities: ['code-edit'],
  complexity,
  estimate: { inputTokens: 900, outputTokens: 200, costUsd: null },
  files: { read: [write], write: [write] },
  dependsOn: [],
});
const PLAN = JSON.stringify({
  tasks: [
    task('update-page-title', 'low', 'src/pages/index.html'),
    task('update-button-color', 'medium', 'src/styles/button.css'),
  ],
});
const EDITS: Record<string, { path: string; content: (old: string) => string }> = {
  'update-page-title': {
    path: 'src/pages/index.html',
    content: (old) => old.replaceAll('>Demo<', '>HELLO WORLD<'),
  },
  'update-button-color': {
    path: 'src/styles/button.css',
    content: (old) => old.replace('background: blue;', 'background: purple;'),
  },
};
const userText = (r: FakeRequest) => r.body.messages.find((m) => m.role === 'user')?.content ?? '';
const isPlanner = (r: FakeRequest) => !/^Task [a-z0-9-]+:/m.test(userText(r));
function edit(r: FakeRequest): FakeReply {
  const id = taskIdOf(r);
  const spec = EDITS[id];
  if (spec === undefined) return { status: 400, error: `unexpected task ${id}` };
  const user = userText(r);
  const old =
    new RegExp(`=== ${spec.path} ===\\n([\\s\\S]*?)=== end ${spec.path} ===`).exec(user)?.[1] ?? '';
  return {
    content: JSON.stringify({
      summary: `did ${id}`,
      edits: [{ path: spec.path, content: spec.content(old) }],
    }),
    promptTokens: 1000,
    completionTokens: 200,
  };
}

const model = (provider: string, modelId: string, medium: number) => ({
  provider,
  modelId,
  capabilities: { tools: true, structuredOutput: true, reasoning: true, streaming: true },
  contextWindow: 200000,
  reliability: { low: 0.9, medium, high: 0.5, source: 'test prior' },
});

/** Anthropic + OpenAI (no prices: the catalog prices them), planner on Claude Haiku. */
function configure(r: DemoRepo, extra: Record<string, unknown> = {}) {
  r.write(
    'models.json',
    JSON.stringify({
      version: 1,
      providers: [
        { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'FAKE_ANTHROPIC_KEY' },
        { id: 'openai', kind: 'openai', apiKeyEnv: 'FAKE_OPENAI_KEY' },
      ],
      // Haiku is cheaper; it is trusted for low-complexity work only, so medium goes to GPT.
      models: [model('anthropic', 'claude-haiku-5-5', 0.5), model('openai', 'gpt-6.1-terra', 0.9)],
    }),
  );
  const cfg = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
  r.write(
    'soot.config.json',
    JSON.stringify({ ...cfg, decomposer: { model: 'anthropic/claude-haiku-5-5' }, ...extra }),
  );
  r.commitAll('use anthropic and openai');
}

async function fakes(
  anthropicReply: (r: FakeRequest, i: number) => FakeReply,
  openaiReply: (r: FakeRequest, i: number) => FakeReply,
) {
  const anthropic = await startFakeOpenAi(anthropicReply, { format: 'anthropic' });
  const openai = await startFakeOpenAi(openaiReply);
  servers.push(anthropic, openai);
  const redirect: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return globalThis.fetch(
      url
        .replace('https://api.anthropic.com/v1', anthropic.baseURL)
        .replace('https://api.openai.com/v1', openai.baseURL),
      init,
    );
  };
  return { anthropic, openai, redirect };
}

const engine = (
  r: DemoRepo,
  redirect: typeof globalThis.fetch,
  env: Record<string, string> = KEYS,
) =>
  new SootEngine({
    cwd: r.root,
    dataDir: r.dataDir,
    agent: { kind: 'api' },
    approvals: withApply(unattendedApprovals()),
    gitEnv: r.env,
    modelEnv: env,
    modelClientFactory: (p, m, o) =>
      createModelClient(p, m, { ...o, fetch: redirect, retry: { maxAttempts: 1 } }),
  });

interface Attempt {
  model: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  actualUsd: number | null;
}
const saved = (r: DemoRepo, runId: string) =>
  JSON.parse(readFileSync(join(r.dataDir, 'reports', `${runId}.json`), 'utf8')) as {
    report: {
      status: string;
      workingTree: { updated: boolean };
      cost: { tasks: { taskId: string; attempts: Attempt[] }[] };
    };
  };

describe('--agent api on Anthropic (native Messages API) and OpenAI', () => {
  it('plans on Claude, runs one task on Claude and one on GPT, prices both from the catalog, lands the result', async () => {
    const r = (repo = createDemoRepo());
    configure(r);
    const { anthropic, openai, redirect } = await fakes(
      (req) =>
        isPlanner(req) ? { content: PLAN, promptTokens: 700, completionTokens: 300 } : edit(req),
      (req) => edit(req),
    );
    const out = await engine(r, redirect).run({ prompt: PROMPT, runId: 'ao-1' });
    expect(out.ok).toBe(true);
    const report = saved(r, 'ao-1').report;
    expect(report.status).toBe('complete');
    expect(report.workingTree.updated).toBe(true);
    expect(r.read('src/pages/index.html')).toContain('<title>HELLO WORLD</title>');
    expect(r.read('src/styles/button.css')).toMatch(/background: purple;/);

    // Anthropic wire format: /v1/messages, x-api-key + anthropic-version, never a Bearer token.
    expect(anthropic.requests).toHaveLength(2); // planner + the low-complexity task
    for (const req of anthropic.requests) {
      expect(req.path).toBe('/v1/messages');
      expect(req.headers['x-api-key']).toBe(KEYS.FAKE_ANTHROPIC_KEY);
      expect(req.headers['anthropic-version']).toEqual(expect.any(String));
      expect(req.authorization).toBeUndefined();
      expect(req.body.model).toBe('claude-haiku-5-5');
      expect(req.body.system).toEqual(expect.anything());
    }
    expect(anthropic.requests.map(taskIdOf)).toEqual(['', 'update-page-title']);
    expect(openai.requests.map(taskIdOf)).toEqual(['update-button-color']);
    expect(openai.requests[0]?.path).toBe('/v1/chat/completions');
    expect(openai.requests[0]?.authorization).toBe(`Bearer ${KEYS.FAKE_OPENAI_KEY}`);

    // Usage from each wire format, priced at the catalog list price (ADR-037).
    const attempts = Object.fromEntries(report.cost.tasks.map((t) => [t.taskId, t.attempts]));
    expect(attempts['update-page-title']).toEqual([
      expect.objectContaining({
        model: 'anthropic/claude-haiku-5-5',
        status: 'succeeded',
        inputTokens: 1000,
        outputTokens: 200,
        actualUsd: expect.closeTo((1000 * 0.1 + 200 * 0.5) / 1e6, 12) as unknown,
      }),
    ]);
    expect(attempts['update-button-color']).toEqual([
      expect.objectContaining({
        model: 'openai/gpt-6.1-terra',
        status: 'succeeded',
        inputTokens: 1000,
        outputTokens: 200,
        actualUsd: expect.closeTo((1000 * 1 + 200 * 5) / 1e6, 12) as unknown,
      }),
    ]);
    const files = readFileSync(join(r.dataDir, 'reports', 'ao-1.json'), 'utf8');
    for (const k of Object.values(KEYS)) expect(files).not.toContain(k);
  });

  it('never calls a provider whose key is missing', async () => {
    const r = (repo = createDemoRepo());
    configure(r);
    const { anthropic, openai, redirect } = await fakes(
      () => ({ content: PLAN }),
      (req) => edit(req),
    );
    const out = await engine(r, redirect, {}).run({ prompt: PROMPT, runId: 'ao-2' });
    expect(out.ok).toBe(false);
    expect(anthropic.requests).toHaveLength(0);
    expect(openai.requests).toHaveLength(0);
  });
});

describe('per-try time limit (ADR-040)', () => {
  it('a hung model call is aborted at modelCallTimeoutMs, recorded as a timeout, and retried', async () => {
    const r = (repo = createDemoRepo());
    configure(r, { modelCallTimeoutMs: 400 });
    let titleCalls = 0;
    const { anthropic, redirect } = await fakes(
      (req) => {
        if (isPlanner(req)) return { content: PLAN };
        if (taskIdOf(req) === 'update-page-title' && titleCalls++ === 0) return { hang: true };
        return edit(req);
      },
      (req) => edit(req),
    );
    const out = await engine(r, redirect).run({ prompt: PROMPT, runId: 'to-1' });
    expect(out.ok).toBe(true);
    expect(saved(r, 'to-1').report.status).toBe('complete');
    expect(anthropic.aborted()).toBe(1);

    const db = new DatabaseSync(join(r.dataDir, 'soot.sqlite'), { readOnly: true });
    const rows = db
      .prepare(
        "SELECT attempt, state, error FROM task_attempts WHERE task_id = 'update-page-title' ORDER BY attempt",
      )
      .all() as { attempt: number; state: string; error: string | null }[];
    const outcomes = db
      .prepare(
        "SELECT attempt, outcome, reason FROM model_outcomes WHERE task_id = 'update-page-title' ORDER BY attempt",
      )
      .all() as { attempt: number; outcome: string; reason: string }[];
    db.close();
    expect(rows.map((x) => x.state)).toEqual(['retried', 'succeeded']);
    expect(rows[0]?.error).toMatch(
      /timed out after 400 ms waiting for anthropic\/claude-haiku-5-5/,
    );
    expect(attemptWhy('timeout', rows[0]?.error ?? null)).toBe(
      'timed out after 400 ms waiting for anthropic/claude-haiku-5-5',
    );
    // Routing history measures quality (soot-verified or not); a timeout is a latency fact, so
    // it stays in the attempt history and audit but does not count as a failed result.
    expect(outcomes).toEqual([expect.objectContaining({ attempt: 2, outcome: 'verified' })]);
    // What `soot status` and the dashboard read for each attempt.
    const status = JSON.stringify(await engine(r, redirect).status('to-1'));
    expect(status).toContain('timed out after 400 ms waiting for anthropic/claude-haiku-5-5');
    const audit = readFileSync(join(r.dataDir, 'audit', 'to-1.jsonl'), 'utf8');
    expect(audit).toMatch(/retry same model after timeout/);
  });

  it('a hung planner call fails the run with a clear message and runs no task', async () => {
    const r = (repo = createDemoRepo());
    configure(r, { modelCallTimeoutMs: 300 });
    const { anthropic, openai, redirect } = await fakes(
      () => ({ hang: true }),
      (req) => edit(req),
    );
    const started = Date.now();
    const out = await engine(r, redirect).run({ prompt: PROMPT, runId: 'to-2' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toMatch(
      /the planner model anthropic\/claude-haiku-5-5 timed out after 300 ms \(limit \\"modelCallTimeoutMs\\" in soot.config.json\)/,
    );
    expect(anthropic.requests).toHaveLength(1);
    expect(openai.requests).toHaveLength(0);
  });
});
