/**
 * Gemini and OpenRouter through `--agent api` and `soot config` (ADR-049). Fake servers on
 * 127.0.0.1 stand in for the vendors; requests to the real hosts are redirected to them so
 * Gemini catalog prices apply. Fake keys only; no live call is made.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelClient } from '@soot/provider-adapters';
import { unattendedApprovals, withApply } from '../apps/cli/src/approvals.js';
import { SootEngine } from '../apps/cli/src/engine.js';
import { cli, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';
import {
  startFakeOpenAi,
  type FakeOpenAi,
  type FakeReply,
  type FakeRequest,
} from './helpers/fake-openai.js';

const KEYS = {
  GEMINI_API_KEY: 'fake-gemini-key-not-a-secret-0009',
  OPENROUTER_API_KEY: 'fake-openrouter-key-not-a-secret-0009',
};

let repo: DemoRepo | null = null;
const servers: FakeOpenAi[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  repo?.dispose();
  repo = null;
});

const PROMPT = 'Please retitle the demo page HELLO WORLD.';
const PLAN = JSON.stringify({
  tasks: [
    {
      id: 'update-page-title',
      title: 'update-page-title',
      instructions: 'Do update-page-title.',
      acceptanceCriteria: ['update-page-title is done'],
      requiredCapabilities: ['code-edit'],
      complexity: 'low',
      estimate: { inputTokens: 900, outputTokens: 200, costUsd: null },
      files: { read: ['src/pages/index.html'], write: ['src/pages/index.html'] },
      dependsOn: [],
    },
  ],
});

const userText = (r: FakeRequest) => r.body.messages.find((m) => m.role === 'user')?.content ?? '';
const isPlanner = (r: FakeRequest) => !/^Task [a-z0-9-]+:/m.test(userText(r));
function edit(r: FakeRequest): FakeReply {
  if (isPlanner(r)) return { content: PLAN, promptTokens: 700, completionTokens: 300 };
  const user = userText(r);
  const old =
    /=== src\/pages\/index.html ===\n([\s\S]*?)=== end src\/pages\/index.html ===/.exec(
      user,
    )?.[1] ?? '';
  return {
    content: JSON.stringify({
      summary: 'did update-page-title',
      edits: [{ path: 'src/pages/index.html', content: old.replaceAll('>Demo<', '>HELLO WORLD<') }],
    }),
    promptTokens: 1000,
    completionTokens: 200,
  };
}

function engine(
  r: DemoRepo,
  redirect: typeof globalThis.fetch,
  env: Record<string, string | undefined> = KEYS,
) {
  return new SootEngine({
    cwd: r.root,
    dataDir: r.dataDir,
    agent: { kind: 'api' },
    approvals: withApply(unattendedApprovals()),
    gitEnv: r.env,
    modelEnv: env,
    modelClientFactory: (p, m, o) => createModelClient(p, m, { ...o, fetch: redirect }),
  });
}

describe('E-1: soot run against a fake Gemini server (catalog prices)', () => {
  it('completes a task and records tokens and the catalog price basis', async () => {
    const r = (repo = createDemoRepo());
    r.write(
      'models.json',
      JSON.stringify({
        version: 1,
        providers: [{ id: 'gemini', kind: 'google', apiKeyEnv: 'GEMINI_API_KEY' }],
        models: [
          {
            provider: 'gemini',
            modelId: 'gemini-3.5-flash-lite',
            capabilities: { tools: true, structuredOutput: true, reasoning: true, streaming: true },
            contextWindow: 1048576,
            reliability: { low: 0.9, medium: 0.8, high: 0.5, source: 'test prior' },
          },
        ],
      }),
    );
    const cfg = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
    r.write(
      'soot.config.json',
      JSON.stringify({ ...cfg, decomposer: { model: 'gemini/gemini-3.5-flash-lite' } }),
    );
    r.commitAll('use gemini');
    const fake = await startFakeOpenAi(edit, { format: 'gemini' });
    servers.push(fake);
    const redirect: typeof globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      return globalThis.fetch(
        url.replace('https://generativelanguage.googleapis.com/v1beta', fake.baseURL),
        init,
      );
    };
    const out = await engine(r, redirect).run({ prompt: PROMPT, runId: 'gem-1' });
    expect(out.ok).toBe(true);
    expect(r.read('src/pages/index.html')).toContain('<title>HELLO WORLD</title>');
    expect(fake.requests).toHaveLength(2);
    for (const req of fake.requests) {
      expect(req.path).toContain(':generateContent');
      expect(req.headers['x-goog-api-key']).toBe(KEYS.GEMINI_API_KEY);
      expect(req.authorization).toBeUndefined();
    }
    const report = JSON.parse(readFileSync(join(r.dataDir, 'reports', 'gem-1.json'), 'utf8')) as {
      report: {
        status: string;
        cost: {
          tasks: {
            taskId: string;
            attempts: { actualUsd: number | null; inputTokens: number; outputTokens: number }[];
          }[];
        };
      };
    };
    expect(report.report.status).toBe('complete');
    const attempt = report.report.cost.tasks.find((t) => t.taskId === 'update-page-title')
      ?.attempts[0];
    expect(attempt).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      actualUsd: expect.closeTo((1000 * 0.3 + 200 * 2.5) / 1e6, 12) as unknown,
    });
    const raw = readFileSync(join(r.dataDir, 'reports', 'gem-1.json'), 'utf8');
    expect(raw).not.toContain(KEYS.GEMINI_API_KEY);
  });
});

describe('E-2: OpenRouter 200+error then success', () => {
  it('retries a mid-body rate limit and completes the run', async () => {
    const r = (repo = createDemoRepo());
    r.write(
      'models.json',
      JSON.stringify({
        version: 1,
        providers: [{ id: 'openrouter', kind: 'openrouter', apiKeyEnv: 'OPENROUTER_API_KEY' }],
        models: [
          {
            provider: 'openrouter',
            modelId: 'anthropic/claude-x',
            capabilities: { tools: true, structuredOutput: true, reasoning: true, streaming: true },
            contextWindow: 200000,
            reliability: { low: 0.9, medium: 0.8, high: 0.5, source: 'test prior' },
            pricing: {
              inputPerMTokUsd: 3,
              outputPerMTokUsd: 15,
              source: 'https://openrouter.ai/anthropic/claude-x',
              asOf: '2026-11-14',
            },
          },
        ],
      }),
    );
    const cfg = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
    r.write(
      'soot.config.json',
      JSON.stringify({ ...cfg, decomposer: { model: 'openrouter/anthropic/claude-x' } }),
    );
    r.commitAll('use openrouter');
    let calls = 0;
    const fake = await startFakeOpenAi(
      (req) => {
        calls += 1;
        if (!isPlanner(req) && calls === 2) {
          return {
            status: 429,
            error: 'Rate limit exceeded',
            inBody: true,
            headers: { 'retry-after': '0' },
          };
        }
        return edit(req);
      },
      { format: 'openrouter' },
    );
    servers.push(fake);
    const redirect: typeof globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      return globalThis.fetch(url.replace('https://openrouter.ai/api/v1', fake.baseURL), init);
    };
    const out = await engine(r, redirect).run({ prompt: PROMPT, runId: 'or-1' });
    expect(out.ok).toBe(true);
    expect(r.read('src/pages/index.html')).toContain('<title>HELLO WORLD</title>');
    // Planner + one rate-limited task call + the successful retry. The 429 is
    // retried inside the model client, so the run report still shows one
    // succeeded attempt rather than a scheduler-level rate-limited row.
    expect(fake.requests.length).toBeGreaterThanOrEqual(3);
    expect(
      fake.requests.filter((req) => req.path.includes('/chat/completions')).length,
    ).toBeGreaterThanOrEqual(3);
    const raw = readFileSync(join(r.dataDir, 'reports', 'or-1.json'), 'utf8');
    expect(raw).not.toContain(KEYS.OPENROUTER_API_KEY);
    expect(out.text).not.toContain(KEYS.OPENROUTER_API_KEY);
  });
});

describe('T-OPT-2: reserved keys do nothing without a models-file provider', () => {
  it('soot config hints that the keys are set but unused, prints no value, and never fetches', async () => {
    const r = (repo = createDemoRepo());
    const fetchSpy = vi.fn(() =>
      Promise.reject(new Error('network access is forbidden in this test')),
    );
    vi.stubGlobal('fetch', fetchSpy);
    try {
      r.env.GEMINI_API_KEY = KEYS.GEMINI_API_KEY;
      r.env.OPENROUTER_API_KEY = KEYS.OPENROUTER_API_KEY;
      const text = await cli(r, ['config']);
      expect(text.code).toBe(0);
      expect(text.stdout).toMatch(/\$GEMINI_API_KEY is set but unused; add a `google` provider/);
      expect(text.stdout).toMatch(
        /\$OPENROUTER_API_KEY is set but unused; add a `openrouter` provider/,
      );
      expect(text.stdout).not.toContain(KEYS.GEMINI_API_KEY);
      expect(text.stdout).not.toContain(KEYS.OPENROUTER_API_KEY);
      expect(text.stderr).not.toContain(KEYS.GEMINI_API_KEY);
      expect(text.stderr).not.toContain(KEYS.OPENROUTER_API_KEY);
      const asJson = JSON.parse((await cli(r, ['config', '--json'])).stdout) as {
        unusedOptInKeys: string[];
        providers: { id: string; kind: string }[];
      };
      expect(asJson.providers.some((p) => p.kind === 'google' || p.kind === 'openrouter')).toBe(
        false,
      );
      expect(asJson.unusedOptInKeys.join('\n')).toMatch(/GEMINI_API_KEY/);
      expect(asJson.unusedOptInKeys.join('\n')).toMatch(/OPENROUTER_API_KEY/);
      expect(JSON.stringify(asJson)).not.toContain(KEYS.GEMINI_API_KEY);
      expect(JSON.stringify(asJson)).not.toContain(KEYS.OPENROUTER_API_KEY);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
