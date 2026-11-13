/**
 * P-02 (ADR-034): the optional "decomposer" model in soot.config.json, through the CLI and the
 * engine behind it and the MCP server. Mock model clients only: `fetch` is replaced with a spy
 * that rejects, so any attempt to reach a network fails the test. No real provider is called
 * and no real key is used (the "key" below is a fake string that only proves a client can be
 * built and that its value is never printed).
 */
import { createMockModelClient, type ModelClient } from '@soot/provider-adapters';
import type { Task } from '@soot/task-graph';
import { SootEngine, unattendedApprovals, type ModelClientFactory } from '@soot/cli';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK, TEST_1, cli, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';

const SLOW = 60_000;
const UNKNOWN = 'Add a short release note for the demo app.';
const FAKE_KEY = 'fake-test-value-not-a-real-key-7f3a';

let repo: DemoRepo | null = null;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error('network access is forbidden in this test')));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  repo?.dispose();
  repo = null;
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/** Demo repo with `decomposer` set in soot.config.json (committed, like a user would). */
function demoWithDecomposer(model: string | null): DemoRepo {
  const r = createDemoRepo();
  if (model !== null) {
    const cfg = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
    cfg.decomposer = { model };
    r.write('soot.config.json', `${JSON.stringify(cfg, null, 2)}\n`);
    r.commitAll('configure a decomposer model');
  }
  return r;
}

const noteTask: Task = {
  id: 'add-release-note',
  title: 'Add a release note',
  instructions: 'Write docs/release-note.md with one line.',
  acceptanceCriteria: ['docs/release-note.md exists.'],
  requiredCapabilities: ['docs'],
  complexity: 'low',
  estimate: { inputTokens: 800, outputTokens: 100, costUsd: null },
  files: { read: [], write: ['docs/release-note.md'] },
  dependsOn: [],
};

const answering = (answer: unknown) =>
  createMockModelClient({
    provider: 'anthropic',
    modelId: 'claude-haiku-5-5',
    turns: [{ text: JSON.stringify(answer), usage: { inputTokens: 700, outputTokens: 150 } }],
  });

function engineFor(
  r: DemoRepo,
  options: { factory?: ModelClientFactory; env?: Record<string, string>; script?: string } = {},
) {
  return new SootEngine({
    cwd: r.root,
    dataDir: r.dataDir,
    agent: { kind: 'mock', script: options.script ?? 'mock-agent.json' },
    approvals: unattendedApprovals(),
    gitEnv: r.env,
    modelEnv: options.env ?? r.env,
    ...(options.factory === undefined ? {} : { modelClientFactory: options.factory }),
  });
}

describe('soot.config.json "decomposer" absent (default)', () => {
  it('soot config says fixtures only; unknown prompts are refused as before, with a hint', async () => {
    const r = (repo = demoWithDecomposer(null));
    const text = await cli(r, ['config']);
    expect(text.stdout).toMatch(
      /Decomposition: recorded fixtures only \(no "decomposer" model configured\)/,
    );
    const asJson = JSON.parse((await cli(r, ['config', '--json'])).stdout) as {
      decomposer: unknown;
    };
    expect(asJson.decomposer).toEqual({ model: null, status: 'not-configured', reason: null });
    const unknown = await cli(r, ['run', UNKNOWN, ...MOCK]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/No decomposition fixture matches this prompt/);
    expect(unknown.stderr).toMatch(/set "decomposer": \{"model": "<provider\/modelId>"\}/);
  });

  it('never builds a client, even when one could be built', async () => {
    const r = (repo = demoWithDecomposer(null));
    const factory = vi.fn<ModelClientFactory>();
    const out = await engineFor(r, { factory }).run({ prompt: UNKNOWN });
    expect(out.ok).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('"decomposer" configured but not usable: no client, no network, clear failure', () => {
  it('missing key: soot config says not usable; unknown prompts fail naming the setting and the variable', async () => {
    const r = (repo = demoWithDecomposer('anthropic/claude-haiku-5-5'));
    const text = await cli(r, ['config']);
    expect(text.stdout).toMatch(
      /Decomposition: fixtures only: anthropic\/claude-haiku-5-5 is configured but not usable \(.*ANTHROPIC_API_KEY is not set/,
    );
    const asJson = JSON.parse((await cli(r, ['config', '--json'])).stdout) as {
      decomposer: { model: string; status: string; reason: string };
    };
    expect(asJson.decomposer).toMatchObject({
      model: 'anthropic/claude-haiku-5-5',
      status: 'unusable',
    });
    expect(asJson.decomposer.reason).toMatch(/ANTHROPIC_API_KEY is not set/);

    const unknown = await cli(r, ['run', UNKNOWN, ...MOCK]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(
      /the decomposer model anthropic\/claude-haiku-5-5 configured in soot\.config\.json is not usable: .*ANTHROPIC_API_KEY is not set.*No model was called/,
    );
    expect(r.git('branch', '--list', 'soot/*')).toBe('');
  });

  it(
    'missing key: recorded prompts still run from fixtures',
    async () => {
      const r = (repo = demoWithDecomposer('anthropic/claude-haiku-5-5'));
      const run = await cli(r, ['run', TEST_1, ...MOCK, '--run-id', 'nokey', '--json']);
      const out = JSON.parse(run.stdout) as { fixtureId: string; decomposition: unknown };
      expect(out.fixtureId).toBe('build-spec-17-test-1');
      expect(out.decomposition).toEqual({ kind: 'fixture', fixtureId: 'build-spec-17-test-1' });
    },
    SLOW,
  );

  it('unknown model reference: never asks the factory, fails clearly', async () => {
    const r = (repo = demoWithDecomposer('nowhere/no-such-model'));
    const factory = vi.fn<ModelClientFactory>();
    const engine = engineFor(r, { factory });
    const cfg = engine.config();
    expect(cfg.data.decomposer).toMatchObject({ status: 'unusable' });
    expect(cfg.text).toMatch(
      /nowhere\/no-such-model is configured but not usable \(model "nowhere\/no-such-model" is not in .*models\.json\)/,
    );
    const out = await engine.run({ prompt: UNKNOWN });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/decomposer model nowhere\/no-such-model .* is not usable/);
    expect(out.data).toMatchObject({ decomposerModelStatus: 'unusable' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('a malformed model reference is rejected by the strict config schema', async () => {
    const r = (repo = demoWithDecomposer('just-a-name'));
    const out = await cli(r, ['config']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/decomposer\.model: must be a model reference "provider\/modelId"/);
  });
});

describe('"decomposer" configured and usable (mock clients only)', () => {
  it('soot config says usable and never prints the key value', async () => {
    const r = (repo = demoWithDecomposer('anthropic/claude-haiku-5-5'));
    r.env.ANTHROPIC_API_KEY = FAKE_KEY;
    const text = await cli(r, ['config']);
    expect(text.stdout).toMatch(
      /Decomposition: fixtures first, then anthropic\/claude-haiku-5-5 for prompts with no fixture \(client can be built; not called by this command\)/,
    );
    const asJson = await cli(r, ['config', '--json']);
    expect(JSON.parse(asJson.stdout)).toMatchObject({
      decomposer: { model: 'anthropic/claude-haiku-5-5', status: 'usable', reason: null },
    });
    expect(text.stdout + text.stderr + asJson.stdout + asJson.stderr).not.toContain(FAKE_KEY);
  });

  it(
    'recorded prompts: zero model calls (real client built from the fake key, never called)',
    async () => {
      const r = (repo = demoWithDecomposer('anthropic/claude-haiku-5-5'));
      r.env.ANTHROPIC_API_KEY = FAKE_KEY;
      const run = await cli(r, ['run', TEST_1, ...MOCK, '--run-id', 'rec', '--json']);
      expect(JSON.parse(run.stdout)).toMatchObject({ fixtureId: 'build-spec-17-test-1' });
      expect(run.stdout + run.stderr).not.toContain(FAKE_KEY);

      const mock = answering({ tasks: [noteTask] });
      const out = await engineFor(r, { factory: () => mock }).run({
        prompt: TEST_1,
        runId: 'rec-mock',
      });
      expect(out.data).toMatchObject({ fixtureId: 'build-spec-17-test-1' });
      expect(mock.calls()).toBe(0);
    },
    SLOW,
  );

  it(
    'a prompt with no fixture is decomposed by the configured model, validated, and run',
    async () => {
      const r = (repo = demoWithDecomposer('anthropic/claude-haiku-5-5'));
      writeFileSync(
        join(r.top, 'note-agent.json'),
        JSON.stringify({
          version: 1,
          tasks: { 'add-release-note': { writes: { 'docs/release-note.md': 'Release note.\n' } } },
        }),
      );
      const mock = answering({ tasks: [noteTask] });
      const factory = vi.fn<ModelClientFactory>((): ModelClient => mock);
      const out = await engineFor(r, { factory, script: '../note-agent.json' }).run({
        prompt: UNKNOWN,
        runId: 'model',
      });
      expect(out.ok).toBe(true);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory.mock.calls[0]?.[1].ref).toBe('anthropic/claude-haiku-5-5');
      expect(mock.calls()).toBe(1);
      expect(out.data).toMatchObject({
        fixtureId: null,
        decomposition: {
          kind: 'model',
          modelRef: 'anthropic/claude-haiku-5-5',
          attempts: 1,
          usage: { inputTokens: 700, outputTokens: 150 },
        },
      });
      expect(out.text).toMatch(
        /Plan: model anthropic\/claude-haiku-5-5 \(validated by soot; 1 model call\(s\)\)/,
      );
      const report = out.data.report as { tasks: { taskId: string; verdict: string }[] };
      expect(report.tasks).toMatchObject([{ taskId: 'add-release-note', verdict: 'verified' }]);

      // The planning call is priced from its reported usage × the model's list price (ADR-037):
      // 700 in × $0.10/M + 150 out × $0.50/M.
      const planned = (out.data.decomposition as { costUsd: number }).costUsd;
      expect(planned).toBeCloseTo(0.000145, 12);
      expect(out.data.decomposition).toMatchObject({
        priceBasis: { ref: 'anthropic/claude-haiku-5-5', asOf: '2026-11-13' },
      });
      expect(out.text).toMatch(
        /Planning call: anthropic\/claude-haiku-5-5, 700 in \/ 150 out, \$0\.000145/,
      );
      // `soot status <run>` carries the saved decomposition, so views can show the planning row.
      const status = await engineFor(r).status('model');
      expect(status.data.decomposition).toMatchObject({
        kind: 'model',
        modelRef: 'anthropic/claude-haiku-5-5',
        usage: { inputTokens: 700, outputTokens: 150 },
      });
      expect((status.data.decomposition as { costUsd: number }).costUsd).toBeCloseTo(0.000145, 12);
    },
    SLOW,
  );

  it(
    'an unpriced decomposer model: planning cost is null, and run and config point to the pricing prompt',
    async () => {
      const r = (repo = demoWithDecomposer('anthropic/claude-haiku-5-5'));
      const models = JSON.parse(r.read('models.json')) as {
        models: { modelId: string; pricing?: unknown }[];
      };
      for (const m of models.models) if (m.modelId === 'claude-haiku-5-5') delete m.pricing;
      r.write('models.json', `${JSON.stringify(models, null, 2)}\n`);
      r.commitAll('leave haiku unpriced');
      // Unpriced in config, but the catalog has the vendor's own price for it.
      const config = await cli(r, ['config', '--json']);
      expect(JSON.parse(config.stdout)).toMatchObject({
        pricing: { catalogPriced: ['anthropic/claude-haiku-5-5'], unpriced: [] },
      });
      // Behind a proxy the vendor price may not apply, so the catalog does not price it.
      const proxied = JSON.parse(r.read('models.json')) as {
        providers: { id: string; baseURL?: string }[];
      };
      for (const p of proxied.providers)
        if (p.id === 'anthropic') p.baseURL = 'https://llm-proxy.example.com/v1';
      r.write('models.json', `${JSON.stringify(proxied, null, 2)}\n`);
      r.commitAll('route anthropic through a proxy');
      expect((await cli(r, ['config'])).stdout).toMatch(
        /Prices: 2 of 3 priced\. 1 model\(s\) have no price \(anthropic\/claude-haiku-5-5\)/,
      );
      writeFileSync(
        join(r.top, 'note-agent.json'),
        JSON.stringify({
          version: 1,
          tasks: { 'add-release-note': { writes: { 'docs/release-note.md': 'Release note.\n' } } },
        }),
      );
      const warnings: string[] = [];
      const engine = new SootEngine({
        cwd: r.root,
        dataDir: r.dataDir,
        agent: { kind: 'mock', script: '../note-agent.json' },
        approvals: unattendedApprovals(),
        gitEnv: r.env,
        modelEnv: r.env,
        modelClientFactory: () => answering({ tasks: [noteTask] }),
        log: {
          level: 'info',
          enabled: () => true,
          debug: () => undefined,
          info: () => undefined,
          warn: (line: string) => warnings.push(line),
          error: () => undefined,
        },
      });
      const out = await engine.run({ prompt: UNKNOWN, runId: 'unpriced' });
      expect(out.ok).toBe(true);
      expect(out.data.decomposition).toMatchObject({ costUsd: null, priceBasis: null });
      expect(out.text).toMatch(
        /Planning call: anthropic\/claude-haiku-5-5, 700 in \/ 150 out, price not set/,
      );
      expect(warnings.join('\n')).toMatch(
        /1 model\(s\) have no price \(anthropic\/claude-haiku-5-5\).*update-model-pricing prompt \(skills\/update-model-pricing\/SKILL\.md\)/,
      );
      expect((await engine.status('unpriced')).data.decomposition).toMatchObject({
        costUsd: null,
      });
    },
    SLOW,
  );

  it('an invalid model answer is reported, with no fallback and nothing run', async () => {
    const r = (repo = demoWithDecomposer('anthropic/claude-haiku-5-5'));
    const mock = answering({ tasks: [{ ...noteTask, files: { read: [], write: ['../escape'] } }] });
    const out = await engineFor(r, { factory: () => mock }).run({ prompt: UNKNOWN });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(
      /Model decomposition by anthropic\/claude-haiku-5-5 failed \(invalid-output\)/,
    );
    expect(out.data).toMatchObject({
      decomposerModel: 'anthropic/claude-haiku-5-5',
      decompositionFailure: 'invalid-output',
    });
    expect(mock.calls()).toBe(1);
    expect(r.git('branch', '--list', 'soot/*')).toBe('');
  });

  it('a failing model call is reported as such', async () => {
    const r = (repo = demoWithDecomposer('anthropic/claude-haiku-5-5'));
    const mock = createMockModelClient({
      provider: 'anthropic',
      modelId: 'claude-haiku-5-5',
      turns: [{ error: { status: 401, message: 'mock: unauthorized' } }],
    });
    const out = await engineFor(r, { factory: () => mock }).run({ prompt: UNKNOWN });
    expect(out.ok).toBe(false);
    expect(out.data).toMatchObject({ decompositionFailure: 'model-call-failed' });
    expect(out.text).not.toMatch(/fixture "/);
  });
});
