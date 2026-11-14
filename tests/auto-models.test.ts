/**
 * ADR-043: the auto pool through the CLI and engine. Fake key strings only prove a variable is
 * set; `fetch` is replaced with a spy that rejects, so any network attempt fails the test.
 * No real provider is called and no key value may appear in any output.
 */
import { createMockModelClient, type ModelClient } from '@soot/provider-adapters';
import { SootEngine, unattendedApprovals, type ModelClientFactory } from '@soot/cli';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK, TEST_2, cli, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';

const SLOW = 60_000;
const FAKE_XAI = 'fake-test-value-not-a-real-key-x41';
const FAKE_DS = 'fake-test-value-not-a-real-key-d57';

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

/** Demo repo whose soot.config.json names no models file: models come from the keys only. */
function keysOnlyDemo(extra: Record<string, unknown> = {}): DemoRepo {
  const r = createDemoRepo();
  const cfg = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
  delete cfg.models;
  Object.assign(cfg, extra);
  r.write('soot.config.json', `${JSON.stringify(cfg, null, 2)}\n`);
  r.commitAll('models from keys only');
  r.env.XAI_API_KEY = FAKE_XAI;
  r.env.DEEPSEEK_API_KEY = FAKE_DS;
  return r;
}

const noLeak = (...texts: string[]) => {
  for (const t of texts) {
    expect(t).not.toContain(FAKE_XAI);
    expect(t).not.toContain(FAKE_DS);
  }
};

describe('soot config / soot models with keys and no models file', () => {
  it('lists the vendors whose keys are set, by variable name only', async () => {
    const r = (repo = keysOnlyDemo());
    const text = await cli(r, ['config']);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/5 auto-added from your keys/);
    expect(text.stdout).toMatch(/- xai: \$XAI_API_KEY is set: 3 model\(s\)/);
    expect(text.stdout).toMatch(/deepseek\/deepseek-flash \[low\]/);
    expect(text.stdout).toMatch(/- anthropic: not used; \$ANTHROPIC_API_KEY is not set/);
    const asJson = JSON.parse((await cli(r, ['config', '--json'])).stdout) as {
      modelsFile: unknown;
      autoModels: { enabled: boolean; providers: { id: string; status: string }[] };
    };
    expect(asJson.modelsFile).toBeNull();
    expect(asJson.autoModels.enabled).toBe(true);
    expect(asJson.autoModels.providers.map((p) => [p.id, p.status])).toEqual([
      ['anthropic', 'no-key'],
      ['openai', 'no-key'],
      ['xai', 'added'],
      ['deepseek', 'added'],
    ]);
    const models = await cli(r, ['models']);
    expect(models.stdout).toMatch(/xai\/grok-4\.7 .*tier medium \(auto from \$XAI_API_KEY\)/);
    expect(models.stdout).toMatch(/tiers come from list output price/);
    const modelsJson = JSON.parse((await cli(r, ['models', '--json'])).stdout) as {
      models: { ref: string; origin: string; tier: string; priceFrom: string }[];
    };
    expect(modelsJson.models.map((m) => [m.ref, m.origin, m.tier])).toContainEqual([
      'deepseek/deepseek-flash',
      'auto',
      'low',
    ]);
    noLeak(text.stdout, text.stderr, models.stdout, models.stderr, JSON.stringify(asJson));
  });

  it('"autoModels": false turns the pool off', async () => {
    const r = (repo = keysOnlyDemo({ autoModels: false }));
    const text = await cli(r, ['config']);
    expect(text.stdout).toMatch(/Models: .* \(0 models\)/);
    expect(text.stdout).toMatch(/Auto models \(off: "autoModels": false\)/);
  });

  it('a models file that configures a vendor wins over the pool for that vendor', async () => {
    const r = (repo = createDemoRepo());
    r.env.ANTHROPIC_API_KEY = 'fake-test-value-not-a-real-key-a11';
    r.env.XAI_API_KEY = FAKE_XAI;
    const out = JSON.parse((await cli(r, ['models', '--json'])).stdout) as {
      models: { ref: string; origin: string }[];
    };
    const anthropic = out.models.filter((m) => m.ref.startsWith('anthropic/'));
    // Only the demo file's two Anthropic models; nothing auto-added for that vendor.
    expect(anthropic.map((m) => m.origin)).toEqual(['config', 'config']);
    expect(out.models.filter((m) => m.origin === 'auto').map((m) => m.ref)).toEqual([
      'xai/grok-build-0.1',
      'xai/grok-4.3',
      'xai/grok-4.7',
    ]);
  });
});

describe('routing a run on the auto pool (mock agent, no model called)', () => {
  it(
    'sends light work to cheap models and hard work to the strongest tier available',
    async () => {
      const r = (repo = keysOnlyDemo());
      r.env.SOOT_LOG_LEVEL = 'info';
      const run = await cli(r, ['run', TEST_2, ...MOCK, '--run-id', 'auto', '--json']);
      const data = JSON.parse(run.stdout) as {
        report: { tasks: { taskId: string; modelPath: string[] }[] };
      };
      const picked = Object.fromEntries(data.report.tasks.map((t) => [t.taskId, t.modelPath[0]]));
      expect(picked).toEqual({
        'update-button-color': 'deepseek/deepseek-flash',
        'add-dropdown-component': 'xai/grok-4.3',
        'verify-auth-bug': 'xai/grok-4.7',
      });
      // Without --json the log line says where the models came from (key names only).
      const plain = await cli(r, ['run', TEST_2, ...MOCK, '--run-id', 'auto-text']);
      expect(plain.stderr).toMatch(/auto models from \$XAI_API_KEY, \$DEEPSEEK_API_KEY: 5 model/);
      noLeak(run.stdout, run.stderr, plain.stdout, plain.stderr);
    },
    SLOW,
  );
});

describe('"decomposer": { "model": "auto" }', () => {
  it('picks the cheapest priced model that is not low-tier and whose key is set', () => {
    const r = (repo = keysOnlyDemo({ decomposer: { model: 'auto' } }));
    const mock = createMockModelClient({
      provider: 'xai',
      modelId: 'grok-4.3',
      turns: [],
    });
    const factory = vi.fn<ModelClientFactory>((): ModelClient => mock);
    const engine = new SootEngine({
      cwd: r.root,
      dataDir: r.dataDir,
      agent: { kind: 'none' },
      approvals: unattendedApprovals(),
      gitEnv: r.env,
      modelEnv: r.env,
      modelClientFactory: factory,
    });
    const out = engine.config();
    expect(out.data).toMatchObject({
      decomposer: { model: 'xai/grok-4.3', status: 'usable', reason: null },
    });
    expect(out.text).toMatch(/then xai\/grok-4\.3 \(picked by "auto"/);
    expect(mock.calls()).toBe(0);
    noLeak(out.text);
  });

  it('is unusable, with a reason, when no key is set', async () => {
    const r = (repo = keysOnlyDemo({ decomposer: { model: 'auto' } }));
    delete r.env.XAI_API_KEY;
    delete r.env.DEEPSEEK_API_KEY;
    const text = await cli(r, ['config']);
    expect(text.stdout).toMatch(
      /fixtures only: auto is configured but not usable \(no priced model with structured output has its key set\)/,
    );
  });
});
