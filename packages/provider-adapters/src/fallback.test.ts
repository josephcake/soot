/** Unavailable-provider handling and fallback (M2-05), with simulated outages. */
import { describe, expect, it } from 'vitest';
import { ModelRegistry, ProviderHealth, parseRegistryConfig } from '@soot/model-registry';
import { createModelClient } from './adapters.js';
import { discoverModelIds } from './discovery.js';
import { AllCandidatesFailedError, generateWithFallback } from './fallback.js';
import { createMockModelClient } from './mock-provider.js';
import { scriptedFetch, entry, testRegistry } from './test-fixtures.js';

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const ask = { messages: [{ role: 'user' as const, content: 'plan this' }] };

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('generateWithFallback', () => {
  it('marks a provider in outage unavailable and falls back to the next candidate', async () => {
    const time = clock();
    const health = new ProviderHealth(time.now);
    const down = createMockModelClient({
      provider: 'anthropic',
      modelId: 'a',
      turns: [{ error: { status: 503 } }],
    });
    const up = createMockModelClient({
      provider: 'openai',
      modelId: 'b',
      turns: [{ text: 'from b' }],
    });

    const first = await generateWithFallback([down, up], ask, health);
    expect(first.response.text).toBe('from b');
    expect(first.response.ref).toBe('openai/b');
    expect(first.trail.map((t) => [t.ref, t.outcome, t.error?.kind ?? null])).toEqual([
      ['anthropic/a', 'failed', 'unavailable'],
      ['openai/b', 'succeeded', null],
    ]);
    expect(down.calls()).toBe(3); // bounded retries first, then fallback
    expect(health.status('anthropic')).toMatchObject({ available: false, reason: 'outage' });

    // While cooling down, the failed provider is skipped without being called.
    const second = await generateWithFallback([down, up], ask, health);
    expect(second.trail[0]).toMatchObject({ ref: 'anthropic/a', outcome: 'skipped-unavailable' });
    expect(down.calls()).toBe(3);

    // After the cooldown the provider is tried again.
    time.advance(60_001);
    expect(health.isAvailable('anthropic')).toBe(true);
  });

  it('uses retry-after as the rate-limit cooldown', async () => {
    const time = clock();
    const health = new ProviderHealth(time.now);
    const limited = createMockModelClient({
      provider: 'anthropic',
      turns: [{ error: { status: 429, headers: { 'retry-after': '90' } } }],
      retry: { maxAttempts: 1 },
    });
    const up = createMockModelClient({ provider: 'openai', turns: [{ text: 'ok' }] });
    await generateWithFallback([limited, up], ask, health);
    expect(health.status('anthropic')).toMatchObject({ available: false, reason: 'rate-limited' });
    time.advance(89_000);
    expect(health.isAvailable('anthropic')).toBe(false);
    time.advance(2_000);
    expect(health.isAvailable('anthropic')).toBe(true);
  });

  it('marks auth failures unavailable until fixed and moves on', async () => {
    const health = new ProviderHealth();
    const bad = createMockModelClient({
      provider: 'anthropic',
      turns: [{ error: { status: 401 } }],
    });
    const up = createMockModelClient({ provider: 'openai', turns: [{ text: 'ok' }] });
    await generateWithFallback([bad, up], ask, health);
    expect(health.status('anthropic')).toMatchObject({ available: false, reason: 'auth' });
    expect(bad.calls()).toBe(1);
  });

  it('does not fall back on request-level failures', async () => {
    const health = new ProviderHealth();
    const rejecting = createMockModelClient({
      provider: 'anthropic',
      turns: [{ error: { status: 400 } }],
    });
    const up = createMockModelClient({ provider: 'openai', turns: [{ text: 'ok' }] });
    await expect(generateWithFallback([rejecting, up], ask, health)).rejects.toMatchObject({
      kind: 'invalid-request',
    });
    expect(up.calls()).toBe(0);
    expect(health.isAvailable('anthropic')).toBe(true);
  });

  it('reports every attempt when all candidates fail', async () => {
    const health = new ProviderHealth();
    const a = createMockModelClient({ provider: 'anthropic', turns: [{ error: { status: 503 } }] });
    const b = createMockModelClient({ provider: 'openai', turns: [{ error: { status: 529 } }] });
    const error = await generateWithFallback([a, b], ask, health).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AllCandidatesFailedError);
    expect((error as AllCandidatesFailedError).trail).toHaveLength(2);
  });

  it('selection excludes a provider marked unavailable by an outage (registry + adapters)', async () => {
    const registry = testRegistry();
    const health = new ProviderHealth();
    const failing = entry(registry, 'anthropic/test-claude');
    const http = scriptedFetch('anthropic', [{ error: { status: 503 } }]);
    const client = createModelClient(failing.provider, failing.model, {
      env: { ANTHROPIC_API_KEY: 'fake' },
      fetch: http.fetch,
      retry: { sleep: () => Promise.resolve() },
    });
    const ok = createMockModelClient({
      provider: 'openai',
      modelId: 'test-gpt',
      turns: [{ text: 'ok' }],
    });
    await generateWithFallback([client, ok], ask, health);
    const selection = registry.select({ capabilities: ['tools'] }, health);
    expect(selection.candidates.map((m) => m.ref)).toEqual(['openai/test-gpt']);
    expect(selection.excluded.find((x) => x.ref === 'anthropic/test-claude')?.reasons).toContain(
      'provider-unavailable',
    );
  });
});

describe('discovery (mocked HTTP)', () => {
  it('lists OpenAI models and feeds the registry: new ids are unselectable with unknown metadata', async () => {
    const registry = testRegistry();
    const { provider } = entry(registry, 'openai/test-gpt');
    const requests: { url: string; auth: string | null }[] = [];
    const ids = await discoverModelIds(provider, {
      env: { OPENAI_API_KEY: 'fake' },
      fetch: (input, init) => {
        requests.push({
          url: urlOf(input),
          auth: new Headers(init?.headers).get('authorization'),
        });
        return Promise.resolve(Response.json({ data: [{ id: 'test-gpt' }, { id: 'brand-new' }] }));
      },
    });
    expect(requests).toEqual([{ url: 'https://api.openai.com/v1/models', auth: 'Bearer fake' }]);
    const change = registry.applyDiscovery('openai', ids);
    expect(change.added).toEqual(['openai/brand-new']);
    const added = registry.get('openai/brand-new');
    expect(added).toMatchObject({
      origin: 'discovered',
      selectable: false,
      pricing: null,
      contextWindow: null,
    });
  });

  it('follows Anthropic pagination with x-api-key', async () => {
    const { provider } = entry(testRegistry(), 'anthropic/test-claude');
    const urls: string[] = [];
    const pages = [
      { data: [{ id: 'a' }], has_more: true, last_id: 'a' },
      { data: [{ id: 'b' }], has_more: false, last_id: 'b' },
    ];
    const ids = await discoverModelIds(provider, {
      env: { ANTHROPIC_API_KEY: 'fake' },
      fetch: (input, init) => {
        urls.push(urlOf(input));
        expect(new Headers(init?.headers).get('x-api-key')).toBe('fake');
        return Promise.resolve(Response.json(pages[urls.length - 1]));
      },
    });
    expect(ids).toEqual(['a', 'b']);
    expect(urls[1]).toContain('after_id=a');
  });

  it('maps a listing outage to an unavailable provider error', async () => {
    const { provider } = entry(testRegistry(), 'openai/test-gpt');
    await expect(
      discoverModelIds(provider, {
        env: { OPENAI_API_KEY: 'fake' },
        fetch: () => Promise.resolve(new Response('down', { status: 503 })),
      }),
    ).rejects.toMatchObject({ kind: 'unavailable', status: 503 });
  });

  it('marks models the provider no longer lists', () => {
    const registry = testRegistry();
    const change = registry.applyDiscovery('openai', ['something-else']);
    expect(change.missing).toEqual(['openai/test-gpt']);
    expect(registry.select({ providers: ['openai'] }).candidates).toEqual([]);
  });
});

describe('DeepSeek and listed-only providers are never called (ADR-016)', () => {
  it('refuses to build clients or discover models for them, without touching the network', async () => {
    const registry = testRegistry();
    let fetched = 0;
    const fetch = () => {
      fetched++;
      return Promise.resolve(Response.json({}));
    };
    for (const ref of ['deepseek/test-ds', 'compat-deepseek/test-ds2']) {
      const { provider, model } = entry(registry, ref);
      expect(() =>
        createModelClient(provider, model, { env: { DEEPSEEK_API_KEY: 'fake' }, fetch }),
      ).toThrow(expect.objectContaining({ kind: 'refused' }));
      await expect(
        discoverModelIds(provider, { env: { DEEPSEEK_API_KEY: 'fake' }, fetch }),
      ).rejects.toMatchObject({
        kind: 'refused',
      });
    }
    expect(fetched).toBe(0);
  });

  it('keeps DeepSeek off the default selection path even when it claims every capability', () => {
    const registry = new ModelRegistry(
      parseRegistryConfig({
        version: 1,
        providers: [
          {
            id: 'ds',
            kind: 'openai-compatible',
            baseURL: 'https://api.deepseek.com',
            apiKeyEnv: 'DEEPSEEK_API_KEY',
          },
        ],
        models: [
          {
            provider: 'ds',
            modelId: 'any',
            contextWindow: 1_000_000,
            capabilities: {
              tools: true,
              structuredOutput: true,
              vision: true,
              reasoning: true,
              streaming: true,
            },
          },
        ],
      }),
    );
    expect(registry.select().candidates).toEqual([]);
  });
});
