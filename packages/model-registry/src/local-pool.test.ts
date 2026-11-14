/** ADR-045: keyless local models (pure: the caller hands in probe results). */
import { describe, expect, it } from 'vitest';
import { parseRegistryConfig } from './config.js';
import {
  DEFAULT_LOCAL_RUNTIMES,
  LOCAL_DEFAULT_CONTEXT_WINDOW,
  LOCAL_PRICE_SOURCE,
  MAX_LOCAL_MODELS_PER_RUNTIME,
  addLocalModels,
  describeLocalPool,
  localProbeSettings,
  localRuntimeFromUrl,
  normalizeBaseURL,
  type LocalProbeSettings,
  type LocalRuntimeProbe,
} from './local-pool.js';
import { EMPTY_REGISTRY_CONFIG } from './auto-pool.js';
import { ModelRegistry } from './registry.js';

const DAY = '2026-11-14';
const [OLLAMA, LMSTUDIO] = DEFAULT_LOCAL_RUNTIMES as [
  (typeof DEFAULT_LOCAL_RUNTIMES)[number],
  (typeof DEFAULT_LOCAL_RUNTIMES)[number],
];
const ON: LocalProbeSettings = {
  enabled: true,
  offReason: '',
  runtimes: DEFAULT_LOCAL_RUNTIMES,
  contextWindow: LOCAL_DEFAULT_CONTEXT_WINDOW,
};
const found = (runtime: typeof OLLAMA, ...modelIds: string[]): LocalRuntimeProbe => ({
  runtime,
  status: 'found',
  modelIds,
  reason: '',
});
const down = (runtime: typeof OLLAMA): LocalRuntimeProbe => ({
  runtime,
  status: 'unreachable',
  modelIds: [],
  reason: 'nothing answered within 500 ms',
});

describe('localProbeSettings', () => {
  const settings = (
    localModels: boolean | { urls?: string[]; contextWindow?: number },
    env: Record<string, string> = {},
    autoModels = true,
  ) => localProbeSettings({ autoModels, localModels, env });

  it('probes Ollama and LM Studio on their default ports by default', () => {
    const s = settings(true);
    expect(s.enabled).toBe(true);
    expect(s.contextWindow).toBe(4096);
    expect(settings({ contextWindow: 32_768 })).toMatchObject({
      contextWindow: 32_768,
      runtimes: DEFAULT_LOCAL_RUNTIMES,
    });
    expect(s.runtimes.map((r) => [r.id, r.baseURL])).toEqual([
      ['ollama', 'http://127.0.0.1:11434/v1'],
      ['lmstudio', 'http://127.0.0.1:1234/v1'],
    ]);
  });

  it('is off with autoModels false, localModels false, or SOOT_LOCAL_MODELS=off', () => {
    expect(settings(true, {}, false)).toMatchObject({
      enabled: false,
      offReason: 'autoModels is false in soot.config.json',
    });
    expect(settings(false)).toMatchObject({
      enabled: false,
      offReason: 'localModels is false in soot.config.json',
    });
    for (const v of ['off', '0', 'false', 'OFF']) {
      expect(settings(true, { SOOT_LOCAL_MODELS: v }).enabled).toBe(false);
    }
    expect(settings(true, { SOOT_LOCAL_MODELS: 'on' }).enabled).toBe(true);
  });

  it('takes custom URLs from SOOT_LOCAL_MODEL_URLS, else from localModels.urls', () => {
    expect(
      settings({ urls: ['http://10.0.0.5:8080/v1'] }).runtimes.map((r) => [r.id, r.baseURL]),
    ).toEqual([['local-10-0-0-5-8080', 'http://10.0.0.5:8080/v1']]);
    const fromEnv = settings(
      { urls: ['http://10.0.0.5:8080/v1'] },
      { SOOT_LOCAL_MODEL_URLS: ' http://localhost:11434 , http://127.0.0.1:9000/v1 ' },
    );
    expect(fromEnv.runtimes.map((r) => [r.id, r.baseURL])).toEqual([
      ['ollama', 'http://127.0.0.1:11434/v1'],
      ['local-127-0-0-1-9000', 'http://127.0.0.1:9000/v1'],
    ]);
    expect(() => settings(true, { SOOT_LOCAL_MODEL_URLS: 'ftp://x' })).toThrow(
      /SOOT_LOCAL_MODEL_URLS: not an http\(s\) URL/,
    );
  });
});

describe('localRuntimeFromUrl / normalizeBaseURL', () => {
  it('appends /v1 to a bare host and keeps a given path', () => {
    expect(localRuntimeFromUrl('http://127.0.0.1:8000').baseURL).toBe('http://127.0.0.1:8000/v1');
    expect(localRuntimeFromUrl('http://127.0.0.1:8000/api/v1/').baseURL).toBe(
      'http://127.0.0.1:8000/api/v1',
    );
  });

  it('compares localhost and 127.0.0.1 alike, ignoring trailing slashes', () => {
    expect(normalizeBaseURL('http://localhost:11434/v1/')).toBe(
      normalizeBaseURL('http://127.0.0.1:11434/v1'),
    );
  });
});

describe('addLocalModels', () => {
  it('adds each runtime that answered as a keyless local provider with $0, tier-low models', () => {
    const r = addLocalModels(EMPTY_REGISTRY_CONFIG, {
      settings: ON,
      probes: [
        found(OLLAMA, 'qwen2.5-coder:7b', 'nomic-embed-text', 'llama3.2:3b'),
        down(LMSTUDIO),
      ],
      fileProviders: [],
      today: DAY,
    });
    const config = parseRegistryConfig(r.config);
    expect(config.providers).toEqual([
      {
        id: 'ollama',
        kind: 'openai-compatible',
        baseURL: 'http://127.0.0.1:11434/v1',
        local: true,
      },
    ]);
    expect(config.providers[0]?.apiKeyEnv).toBeUndefined();
    // Embedding models are not chat models and are skipped.
    expect(r.localRefs).toEqual(['ollama/qwen2.5-coder:7b', 'ollama/llama3.2:3b']);
    for (const m of config.models) {
      expect(m.tier).toBe('low');
      expect(m.pricing).toMatchObject({
        inputPerMTokUsd: 0,
        outputPerMTokUsd: 0,
        source: LOCAL_PRICE_SOURCE,
        asOf: DAY,
      });
      expect(m.capabilities).toMatchObject({ tools: true, structuredOutput: true });
      expect(m.contextWindow).toBe(LOCAL_DEFAULT_CONTEXT_WINDOW);
    }
    expect(r.runtimes.map((x) => [x.id, x.status])).toEqual([
      ['ollama', 'added'],
      ['lmstudio', 'not-running'],
    ]);
    const registry = new ModelRegistry(config, { autoRefs: r.localRefs });
    expect(registry.get('ollama/llama3.2:3b')?.origin).toBe('auto');
    expect(registry.provider('ollama')?.local).toBe(true);
    expect(describeLocalPool(r.runtimes)).toEqual([
      '- ollama: Ollama (http://127.0.0.1:11434/v1): 2 model(s), $0, tier low, context 4096: ollama/qwen2.5-coder:7b [low], ollama/llama3.2:3b [low]',
      '- lmstudio (http://127.0.0.1:1234/v1): not-running; nothing answered at http://127.0.0.1:1234/v1',
    ]);
  });

  it('keeps model ids with slashes (LM Studio) and caps the count per runtime', () => {
    const many = Array.from(
      { length: MAX_LOCAL_MODELS_PER_RUNTIME + 5 },
      (_, i) => `org/m-${String(i)}`,
    );
    const r = addLocalModels(EMPTY_REGISTRY_CONFIG, {
      settings: ON,
      probes: [found(LMSTUDIO, ...many)],
      fileProviders: [],
      today: DAY,
    });
    expect(r.localRefs).toHaveLength(MAX_LOCAL_MODELS_PER_RUNTIME);
    expect(r.localRefs[0]).toBe('lmstudio/org/m-0');
  });

  it('never overrides the models file: same provider id or same base URL wins', () => {
    const file = parseRegistryConfig({
      version: 1,
      providers: [
        {
          id: 'my-ollama',
          kind: 'openai-compatible',
          baseURL: 'http://localhost:11434/v1/',
          local: true,
        },
        { id: 'lmstudio', kind: 'listed-only' },
      ],
      models: [],
    });
    const r = addLocalModels(file, {
      settings: ON,
      probes: [found(OLLAMA, 'a'), found(LMSTUDIO, 'b')],
      fileProviders: file.providers,
      today: DAY,
    });
    expect(r.localRefs).toEqual([]);
    expect(r.config).toEqual(file);
    expect(r.runtimes.map((x) => x.status)).toEqual(['configured', 'configured']);
    expect(r.runtimes[0]?.reason).toMatch(/provider "my-ollama"/);
  });

  it('reports off, not probed, errors and empty listings without adding anything', () => {
    const off = addLocalModels(EMPTY_REGISTRY_CONFIG, {
      settings: { ...ON, enabled: false, offReason: 'localModels is false in soot.config.json' },
      probes: [found(OLLAMA, 'a')],
      fileProviders: [],
    });
    expect(off.runtimes.map((x) => x.status)).toEqual(['off', 'off']);
    expect(off.localRefs).toEqual([]);
    const notProbed = addLocalModels(EMPTY_REGISTRY_CONFIG, {
      settings: ON,
      probes: null,
      fileProviders: [],
    });
    expect(notProbed.runtimes.map((x) => x.status)).toEqual(['not-probed', 'not-probed']);
    const odd = addLocalModels(EMPTY_REGISTRY_CONFIG, {
      settings: ON,
      probes: [
        {
          runtime: OLLAMA,
          status: 'error',
          modelIds: [],
          reason: 'model listing failed with HTTP 500',
        },
        found(LMSTUDIO, 'text-embedding-nomic'),
      ],
      fileProviders: [],
    });
    expect(odd.runtimes.map((x) => [x.status, x.reason])).toEqual([
      ['error', 'model listing failed with HTTP 500'],
      ['no-models', 'http://127.0.0.1:1234/v1 answered but lists no chat models'],
    ]);
    expect(odd.config.providers).toEqual([]);
  });
});
