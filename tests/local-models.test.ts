/**
 * ADR-045: keyless local models through the CLI and engine. The "local runtime" is a fake
 * OpenAI-compatible server on 127.0.0.1 named with SOOT_LOCAL_MODEL_URLS; no real runtime and
 * no remote provider is contacted (mock agent, fake key strings only).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SootEngine, unattendedApprovals } from '@soot/cli';
import { MOCK, TEST_2, cli, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';

const SLOW = 60_000;
let repo: DemoRepo | null = null;
let server: Server | null = null;
let baseURL = '';
let listings = 0;
let authHeaders: string[] = [];

beforeEach(async () => {
  listings = 0;
  authHeaders = [];
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      listings += 1;
      authHeaders.push(req.headers.authorization ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'qwen2.5-coder:7b' }, { id: 'nomic-embed-text' }],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
  baseURL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
});

afterEach(async () => {
  repo?.dispose();
  repo = null;
  await new Promise<void>((done) => {
    server?.closeAllConnections();
    server?.close(() => {
      done();
    });
  });
  server = null;
});

/** Demo repo with no models file that probes only the fake runtime. */
function localDemo(extra: Record<string, unknown> = {}, keepModelsFile = false): DemoRepo {
  const r = createDemoRepo();
  const cfg = JSON.parse(r.read('soot.config.json')) as Record<string, unknown>;
  if (!keepModelsFile) delete cfg.models;
  Object.assign(cfg, extra);
  r.write('soot.config.json', `${JSON.stringify(cfg, null, 2)}\n`);
  r.commitAll('local models');
  delete r.env.SOOT_LOCAL_MODELS;
  r.env.SOOT_LOCAL_MODEL_URLS = baseURL;
  return r;
}

const localId = () => `local-127-0-0-1-${new URL(baseURL).port}`;

describe('soot config / soot models with a local runtime and no key', () => {
  it("lists the runtime's chat models as keyless, local, $0 and tier low", async () => {
    const r = (repo = localDemo());
    const config = await cli(r, ['config']);
    expect(config.code).toBe(0);
    expect(config.stdout).toMatch(/\(1 models, 1 from local runtimes\)/);
    expect(config.stdout).toContain(
      `- ${localId()}: local runtime ${baseURL}: 1 model(s), $0, tier low, context 4096: ${localId()}/qwen2.5-coder:7b [low]`,
    );
    expect(config.stdout).toMatch(new RegExp(`- ${localId()} \\(openai-compatible\\) local`));
    const models = await cli(r, ['models']);
    expect(models.stdout).toMatch(
      /qwen2\.5-coder:7b \(openai-compatible\) eligible; price in\/out per MTok \$0\/\$0 .*tier low \(auto: local runtime at http:\/\/127\.0\.0\.1:\d+\/v1, no key\)/,
    );
    const asJson = JSON.parse((await cli(r, ['models', '--json'])).stdout) as {
      models: { ref: string; origin: string; tier: string; pricing: { source: string } }[];
      localModels: { enabled: boolean; runtimes: { id: string; status: string }[] };
    };
    expect(asJson.models).toEqual([
      expect.objectContaining({
        ref: `${localId()}/qwen2.5-coder:7b`,
        origin: 'auto',
        tier: 'low',
        pricing: expect.objectContaining({ source: 'local runtime' }) as unknown,
      }),
    ]);
    expect(asJson.localModels).toEqual({
      enabled: true,
      runtimes: [expect.objectContaining({ id: localId(), status: 'added' })],
    });
    expect(listings).toBeGreaterThanOrEqual(3);
    expect(authHeaders.every((h) => h === '')).toBe(true);
  });

  it('"localModels": false and SOOT_LOCAL_MODELS=off turn probing off without a request', async () => {
    const r = (repo = localDemo({ localModels: false }));
    const out = await cli(r, ['config']);
    expect(out.stdout).toMatch(
      /Local runtimes \(off: localModels is false in soot\.config\.json\)/,
    );
    expect(out.stdout).toMatch(/\(0 models\)/);
    const r2 = localDemo();
    try {
      r2.env.SOOT_LOCAL_MODELS = 'off';
      const off = await cli(r2, ['models']);
      expect(off.stdout).toMatch(/Local runtimes \(off: SOOT_LOCAL_MODELS is off\)/);
    } finally {
      r2.dispose();
    }
    const r3 = localDemo({ autoModels: false });
    try {
      const off = await cli(r3, ['models']);
      expect(off.stdout).toMatch(/Local runtimes \(off: autoModels is false/);
    } finally {
      r3.dispose();
    }
    expect(listings).toBe(0);
  });

  it('"localModels": {"urls": [...]} names the runtimes; the models file wins for one it configures', async () => {
    const r = (repo = localDemo({ localModels: { urls: [baseURL] } }, true));
    delete r.env.SOOT_LOCAL_MODEL_URLS;
    const models = JSON.parse(r.read('models.json')) as {
      providers: Record<string, unknown>[];
    };
    models.providers.push({
      id: 'mine',
      kind: 'openai-compatible',
      baseURL: baseURL.replace('127.0.0.1', 'localhost'),
      local: true,
    });
    r.write('models.json', `${JSON.stringify(models, null, 2)}\n`);
    const out = JSON.parse((await cli(r, ['config', '--json'])).stdout) as {
      localModels: { runtimes: { id: string; status: string; reason: string }[] };
    };
    expect(out.localModels.runtimes).toEqual([
      expect.objectContaining({ id: localId(), status: 'configured' }),
    ]);
    expect(out.localModels.runtimes[0]?.reason).toMatch(/provider "mine"/);
  });

  it('the dashboard\'s synchronous config read says "not probed" instead of calling out', () => {
    const r = (repo = localDemo());
    const engine = new SootEngine({
      cwd: r.root,
      dataDir: r.dataDir,
      agent: { kind: 'none' },
      approvals: unattendedApprovals(),
      gitEnv: r.env,
      modelEnv: r.env,
    });
    const out = engine.config();
    expect(out.data).toMatchObject({
      localModels: { enabled: true, runtimes: [{ id: localId(), status: 'not-probed' }] },
    });
    expect(listings).toBe(0);
  });
});

describe('routing with a local runtime next to vendor keys (mock agent, no model called)', () => {
  it(
    'light work goes to the free local model first; harder work still goes to stronger models',
    async () => {
      const r = (repo = localDemo());
      r.env.XAI_API_KEY = 'fake-test-value-not-a-real-key-x41';
      r.env.DEEPSEEK_API_KEY = 'fake-test-value-not-a-real-key-d57';
      r.env.SOOT_LOG_LEVEL = 'info';
      const run = await cli(r, ['run', TEST_2, ...MOCK, '--run-id', 'local', '--json']);
      const data = JSON.parse(run.stdout) as {
        report: { tasks: { taskId: string; modelPath: string[] }[] };
      };
      const picked = Object.fromEntries(data.report.tasks.map((t) => [t.taskId, t.modelPath[0]]));
      expect(picked).toEqual({
        'update-button-color': `${localId()}/qwen2.5-coder:7b`,
        'add-dropdown-component': 'xai/grok-4.3',
        'verify-auth-bug': 'xai/grok-4.7',
      });
      // Without --json the log line says where the local models came from.
      const plain = await cli(r, ['run', TEST_2, ...MOCK, '--run-id', 'local-text']);
      expect(plain.stderr).toMatch(
        /local models from local runtime http:\/\/127\.0\.0\.1:\d+\/v1: 1 model\(s\) at \$0, tier low; light work that fits their 4096-token context/,
      );
      for (const t of [run.stdout, run.stderr, plain.stdout, plain.stderr]) {
        expect(t).not.toContain('fake-test-value');
      }
    },
    SLOW,
  );
});
