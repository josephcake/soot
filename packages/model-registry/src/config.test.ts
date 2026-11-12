import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_CONFIG } from './test-fixtures.js';
import { RegistryConfigError, loadRegistryConfigFile, parseRegistryConfig } from './index.js';

const issuesOf = (input: unknown): string[] => {
  try {
    parseRegistryConfig(input);
  } catch (error) {
    if (error instanceof RegistryConfigError)
      return error.issues.map((i) => `${i.path}: ${i.message}`);
    throw error;
  }
  throw new Error('expected invalid config');
};

describe('registry config (M2-04, M2-06)', () => {
  it('loads a user config file, including a custom OpenAI-compatible endpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soot-registry-'));
    const file = join(dir, 'models.json');
    writeFileSync(file, JSON.stringify(TEST_CONFIG));
    const config = loadRegistryConfigFile(file);
    expect(config.providers.map((p) => p.id)).toEqual([
      'anthropic',
      'openai',
      'local-ollama',
      'deepseek',
    ]);
    expect(config.providers[2]).toEqual({
      id: 'local-ollama',
      kind: 'openai-compatible',
      baseURL: 'http://127.0.0.1:11434/v1',
      local: true,
    });
  });

  it('fills missing metadata with unknown (null), never a guess', () => {
    const local = parseRegistryConfig(TEST_CONFIG).models[2];
    expect(local).toEqual({
      provider: 'local-ollama',
      modelId: 'test-local-coder',
      family: null,
      capabilities: {
        tools: false,
        structuredOutput: null,
        vision: null,
        reasoning: null,
        streaming: null,
      },
      contextWindow: null,
      maxOutputTokens: null,
      pricing: null,
      reliability: { low: null, medium: null, high: null, source: null },
      selectable: true,
    });
  });

  it('requires a source and as-of date on every price', () => {
    const config = structuredClone(TEST_CONFIG) as { models: { pricing?: unknown }[] };
    config.models[0] = {
      ...config.models[0],
      pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
    };
    const issues = issuesOf(config);
    expect(issues.some((i) => i.startsWith('models.0.pricing.source'))).toBe(true);
    expect(issues.some((i) => i.startsWith('models.0.pricing.asOf'))).toBe(true);
  });

  it('never accepts a credential: only the NAME of an env var', () => {
    const inline = structuredClone(TEST_CONFIG) as { providers: Record<string, unknown>[] };
    inline.providers[0] = { ...inline.providers[0], apiKey: 'sk-ant-should-never-be-here' };
    expect(issuesOf(inline).join('\n')).toMatch(/apiKey/);
    const keyAsEnv = structuredClone(TEST_CONFIG) as { providers: Record<string, unknown>[] };
    keyAsEnv.providers[0] = { ...keyAsEnv.providers[0], apiKeyEnv: 'sk-ant-api03-abc' };
    expect(issuesOf(keyAsEnv).join('\n')).toMatch(/environment variable name, not a key/);
  });

  it('rejects unknown providers, duplicates, and compatible endpoints without a URL', () => {
    expect(
      issuesOf({ version: 1, providers: [], models: [{ provider: 'ghost', modelId: 'm' }] }),
    ).toEqual(['models.0.provider: unknown provider "ghost"']);
    expect(
      issuesOf({
        version: 1,
        providers: [
          { id: 'a', kind: 'openai' },
          { id: 'a', kind: 'openai' },
        ],
        models: [],
      }),
    ).toEqual(['providers.1.id: duplicate provider "a"']);
    expect(
      issuesOf({ version: 1, providers: [{ id: 'x', kind: 'openai-compatible' }], models: [] }),
    ).toEqual(['providers.0.baseURL: openai-compatible providers need a baseURL']);
  });

  it('reports unreadable files clearly', () => {
    expect(() => loadRegistryConfigFile('/nonexistent/models.json')).toThrow(/cannot read JSON/);
  });
});

describe('reliability priors', () => {
  const base = {
    version: 1 as const,
    providers: [{ id: 'p', kind: 'openai-compatible' as const, baseURL: 'http://127.0.0.1:1/v1' }],
  };
  it('defaults to unknown, never a guessed number', () => {
    const config = parseRegistryConfig({ ...base, models: [{ provider: 'p', modelId: 'm' }] });
    expect(config.models[0]?.reliability).toEqual({
      low: null,
      medium: null,
      high: null,
      source: null,
    });
  });
  it('requires a source when any prior is declared, and bounds values to 0..1', () => {
    expect(() =>
      parseRegistryConfig({
        ...base,
        models: [{ provider: 'p', modelId: 'm', reliability: { low: 0.9 } }],
      }),
    ).toThrow(/source/);
    expect(() =>
      parseRegistryConfig({
        ...base,
        models: [{ provider: 'p', modelId: 'm', reliability: { low: 1.2, source: 'x' } }],
      }),
    ).toThrow();
    const ok = parseRegistryConfig({
      ...base,
      models: [{ provider: 'p', modelId: 'm', reliability: { low: 0.9, source: 'team eval' } }],
    });
    expect(ok.models[0]?.reliability).toEqual({
      low: 0.9,
      medium: null,
      high: null,
      source: 'team eval',
    });
  });
});
