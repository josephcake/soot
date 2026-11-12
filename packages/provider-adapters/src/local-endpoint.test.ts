/**
 * M2-03: generic OpenAI-compatible LOCAL endpoint (Ollama, LM Studio). The wire path is covered
 * by mocked HTTP in contract.test.ts. This file talks to a real local runtime only if one is
 * already listening on localhost; otherwise the test is SKIPPED, never faked as a pass.
 * Local endpoints are free and keyless; no remote provider is contacted.
 */
import { describe, expect, it } from 'vitest';
import { ModelRegistry, parseRegistryConfig } from '@soot/model-registry';
import { createModelClient } from './adapters.js';
import { discoverModelIds } from './discovery.js';

const CANDIDATES = [
  { name: 'ollama', baseURL: 'http://127.0.0.1:11434/v1' },
  { name: 'lm-studio', baseURL: 'http://127.0.0.1:1234/v1' },
];

async function probe(): Promise<{ name: string; baseURL: string; model: string } | null> {
  for (const c of CANDIDATES) {
    try {
      const res = await fetch(`${c.baseURL}/models`, { signal: AbortSignal.timeout(500) });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: { id?: string }[] };
      const model = body.data?.find((m) => typeof m.id === 'string')?.id;
      if (model !== undefined) return { ...c, model };
    } catch {
      // not listening
    }
  }
  return null;
}

const local = await probe();

describe.skipIf(local === null)('live local OpenAI-compatible endpoint', () => {
  it('generates text through the generic adapter', async () => {
    if (local === null) return;
    const registry = new ModelRegistry(
      parseRegistryConfig({
        version: 1,
        providers: [
          { id: local.name, kind: 'openai-compatible', baseURL: local.baseURL, local: true },
        ],
        models: [{ provider: local.name, modelId: local.model }],
      }),
    );
    const provider = registry.provider(local.name);
    const model = registry.get(`${local.name}/${local.model}`);
    if (provider === undefined || model === undefined) throw new Error('registry setup failed');
    expect(await discoverModelIds(provider, { env: {} })).toContain(local.model);
    const response = await createModelClient(provider, model, { env: {} }).generate({
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      maxOutputTokens: 16,
      timeoutMs: 120_000,
    });
    expect(response.text.length).toBeGreaterThan(0);
  }, 180_000);
});
