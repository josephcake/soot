/**
 * Gemini (`google`) and OpenRouter (`openrouter`) adapters (ADR-049). Fake HTTP and
 * fake keys only; a missed baseURL fails the network guard instead of going outbound.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyPriceCatalog, parseRegistryConfig, type ProviderConfig } from '@soot/model-registry';
import { createModelClient } from './adapters.js';
import { hiddenReasoningTokens } from './ai-sdk-client.js';
import { discoverModelIds } from './discovery.js';
import { kindForStatus, ProviderError, toProviderError } from './errors.js';
import { APICallError } from 'ai';
import { OPENROUTER_BASE_URL } from './openrouter.js';
import { entry, scriptedFetch, testRegistry, type Turn } from './test-fixtures.js';

const GEMINI_KEY = 'test-gemini-key';
const OR_KEY = 'test-openrouter-key';
const GEMINI_ENV = { GEMINI_API_KEY: GEMINI_KEY };
const OR_ENV = { OPENROUTER_API_KEY: OR_KEY };
const ask = { messages: [{ role: 'user' as const, content: 'hello' }] };
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

function geminiClient(
  turns: readonly Turn[],
  env: Record<string, string | undefined> = GEMINI_ENV,
) {
  const http = scriptedFetch('gemini', turns);
  const { provider, model } = entry(testRegistry(), 'gemini/test-gemini');
  const client = createModelClient(provider, model, {
    env,
    fetch: http.fetch,
    retry: { sleep: () => Promise.resolve(), random: () => 1 },
  });
  return { client, http, provider, model };
}

function orClient(
  turns: readonly Turn[],
  extra: Partial<ProviderConfig> = {},
  env: Record<string, string | undefined> = OR_ENV,
) {
  const http = scriptedFetch('openrouter', turns);
  const { provider, model } = entry(testRegistry(), 'openrouter/anthropic/claude-x');
  const client = createModelClient({ ...provider, ...extra }, model, {
    env,
    fetch: http.fetch,
    retry: { sleep: () => Promise.resolve(), random: () => 1 },
  });
  return { client, http, provider, model };
}

describe('kindForStatus 402 (ADR-049, U-ERR3)', () => {
  it('maps 402 to auth and leaves other statuses unchanged', () => {
    expect(kindForStatus(402)).toBe('auth');
    expect(kindForStatus(400)).toBe('invalid-request');
    expect(kindForStatus(401)).toBe('auth');
    expect(kindForStatus(403)).toBe('auth');
    expect(kindForStatus(408)).toBe('timeout');
    expect(kindForStatus(429)).toBe('rate-limited');
    expect(kindForStatus(500)).toBe('unavailable');
    expect(kindForStatus(503)).toBe('unavailable');
    expect(kindForStatus(529)).toBe('unavailable');
  });

  it('maps a 402 with Retry-After to rate-limited', () => {
    const error = toProviderError(
      new APICallError({
        message: 'budget',
        url: 'https://example.test',
        requestBodyValues: {},
        statusCode: 402,
        responseHeaders: { 'retry-after': '3' },
      }),
      'openrouter',
      [],
    );
    expect(error).toMatchObject({
      kind: 'rate-limited',
      status: 402,
      retryable: true,
      retryAfterMs: 3000,
    });
  });

  it('maps a 402 without Retry-After to auth (fallback, no retry)', () => {
    const error = toProviderError(
      new APICallError({
        message: 'no credits',
        url: 'https://example.test',
        requestBodyValues: {},
        statusCode: 402,
        responseHeaders: {},
      }),
      'gemini',
      [],
    );
    expect(error).toMatchObject({ kind: 'auth', status: 402, retryable: false });
    expect(error.message).toMatch(/payment required/i);
  });
});

describe('google adapter (mocked HTTP)', () => {
  it('U-G1: posts generateContent with x-goog-api-key and no Authorization', async () => {
    const { client, http } = geminiClient([{ text: 'hello from gemini' }]);
    const r = await client.generate(ask);
    expect(r.text).toBe('hello from gemini');
    const req = http.requests[0];
    expect(req?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/test-gemini:generateContent',
    );
    expect(req?.headers['x-goog-api-key']).toBe(GEMINI_KEY);
    expect(req?.headers.authorization).toBeUndefined();
  });

  it('U-G2: counts thoughts as output and cache as cache reads, without double-counting', async () => {
    const { client } = geminiClient([
      {
        text: 'ok',
        usage: { inputTokens: 100, outputTokens: 10, thoughtsTokens: 25, cacheReadTokens: 40 },
      },
    ]);
    const r = await client.generate(ask);
    expect(r.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 35,
      cacheReadTokens: 40,
    });
    expect(
      hiddenReasoningTokens({
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 25,
      }),
    ).toBe(0);
  });

  it('U-G3: maps functionCall parts to soot tool calls', async () => {
    const { client } = geminiClient([
      { toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }] },
    ]);
    const r = await client.generate({
      ...ask,
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    });
    expect(r.finishReason).toBe('tool-calls');
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }]);
  });

  it('U-G4: requests JSON schema output and rejects invalid JSON', async () => {
    const Plan = z.object({ steps: z.array(z.string()).min(1) });
    const ok = geminiClient([{ text: JSON.stringify({ steps: ['a'] }) }]);
    const r = await ok.client.generate({ ...ask, output: { schema: Plan, name: 'plan' } });
    expect(r.output).toEqual({ steps: ['a'] });
    const body = ok.http.requests[0]?.body as {
      generationConfig?: { responseMimeType?: string; responseJsonSchema?: unknown };
    };
    expect(body.generationConfig?.responseMimeType).toBe('application/json');
    expect(body.generationConfig?.responseJsonSchema).toEqual(expect.any(Object));

    const bad = geminiClient([{ text: 'not-json' }]);
    await expect(bad.client.generate({ ...ask, output: { schema: Plan } })).rejects.toMatchObject({
      kind: 'invalid-output',
    });
  });

  it('U-G5: rejects structuredOutputMode json_object for google', () => {
    expect(() =>
      parseRegistryConfig({
        version: 1,
        providers: [
          {
            id: 'gemini',
            kind: 'google',
            apiKeyEnv: 'GEMINI_API_KEY',
            structuredOutputMode: 'json_object',
          },
        ],
        models: [{ provider: 'gemini', modelId: 'm' }],
      }),
    ).toThrow(/json_object/);
    expect(() =>
      parseRegistryConfig({
        version: 1,
        providers: [{ id: 'gemini', kind: 'google', apiKeyEnv: 'GEMINI_API_KEY' }],
        models: [{ provider: 'gemini', modelId: 'm', structuredOutputMode: 'json_object' }],
      }),
    ).toThrow(/json_object/);
  });

  it('U-G6: maps MAX_TOKENS to length and SAFETY to content-filter', async () => {
    const length = geminiClient([{ text: 'cut', geminiFinishReason: 'MAX_TOKENS' }]);
    expect((await length.client.generate(ask)).finishReason).toBe('length');
    const blocked = geminiClient([{ geminiFinishReason: 'SAFETY' }]);
    expect((await blocked.client.generate(ask)).finishReason).toBe('content-filter');
  });

  it('U-G7: retries a 429 once and then succeeds, with SDK retries off', async () => {
    const { client, http } = geminiClient([
      { error: { status: 429, googleStatus: 'RESOURCE_EXHAUSTED' } },
      { text: 'ok' },
    ]);
    const r = await client.generate(ask);
    expect(r.text).toBe('ok');
    expect(r.attempts).toBe(2);
    expect(http.requests).toHaveLength(2);
  });

  it('U-G8: retries 503 up to the policy max', async () => {
    const { client, http } = geminiClient([
      { error: { status: 503, googleStatus: 'UNAVAILABLE' } },
    ]);
    await expect(client.generate(ask)).rejects.toMatchObject({
      kind: 'unavailable',
      status: 503,
      retryable: true,
    });
    expect(http.requests).toHaveLength(3);
  });

  it('U-G9: treats 402 as auth and does not retry', async () => {
    const { client, http } = geminiClient([
      { error: { status: 402, message: 'Prepay credit balance is depleted' } },
    ]);
    await expect(client.generate(ask)).rejects.toMatchObject({
      kind: 'auth',
      status: 402,
      retryable: false,
    });
    expect(http.requests).toHaveLength(1);
  });

  it('U-G10: missing key is auth and makes zero fetch calls', () => {
    const http = scriptedFetch('gemini', [{ text: 'nope' }]);
    const { provider, model } = entry(testRegistry(), 'gemini/test-gemini');
    expect(() => createModelClient(provider, model, { env: {}, fetch: http.fetch })).toThrow(
      expect.objectContaining({ kind: 'auth' }),
    );
    expect(http.requests).toHaveLength(0);
  });

  it('U-G11: does not fall back to GOOGLE_GENERATIVE_AI_API_KEY on the process environment', () => {
    const http = scriptedFetch('gemini', [{ text: 'nope' }]);
    const { provider, model } = entry(testRegistry(), 'gemini/test-gemini');
    const previous = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'fake-env-fallback-value-not-a-secret';
    try {
      expect(() => createModelClient(provider, model, { env: {}, fetch: http.fetch })).toThrow(
        expect.objectContaining({ kind: 'auth' }),
      );
      expect(http.requests).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = previous;
    }
  });

  it('U-G12: redacts a fake key echoed in an error body', async () => {
    const { client } = geminiClient([
      { error: { status: 400, message: `API key not valid: ${GEMINI_KEY}` } },
    ]);
    const error = await client.generate(ask).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain('[redacted]');
    expect((error as ProviderError).message).not.toContain(GEMINI_KEY);
  });

  it('U-G13: catalog prices apply for the default Gemini host, not a custom baseURL', () => {
    const priced = applyPriceCatalog(
      parseRegistryConfig({
        version: 1,
        providers: [{ id: 'gemini', kind: 'google', apiKeyEnv: 'GEMINI_API_KEY' }],
        models: [{ provider: 'gemini', modelId: 'gemini-3.5-flash-lite' }],
      }),
      { today: '2026-11-13' },
    );
    expect(priced.catalogPriced).toEqual(['gemini/gemini-3.5-flash-lite']);
    expect(priced.config.models[0]?.pricing?.source).toBe(
      'https://ai.google.dev/gemini-api/docs/pricing',
    );

    const elsewhere = applyPriceCatalog(
      parseRegistryConfig({
        version: 1,
        providers: [
          {
            id: 'gemini',
            kind: 'google',
            apiKeyEnv: 'GEMINI_API_KEY',
            baseURL: 'https://example.test/v1beta',
          },
        ],
        models: [{ provider: 'gemini', modelId: 'gemini-3.5-flash-lite' }],
      }),
      { today: '2026-11-13' },
    );
    expect(elsewhere.catalogPriced).toEqual([]);
    expect(elsewhere.config.models[0]?.pricing).toBeNull();
  });
});

describe('openrouter adapter (mocked HTTP)', () => {
  it('U-O1: posts to the default OpenRouter base with a bearer token and a slashed model id', async () => {
    const { client, http } = orClient([{ text: 'yo' }]);
    const r = await client.generate(ask);
    expect(r.text).toBe('yo');
    expect(client.ref).toBe('openrouter/anthropic/claude-x');
    expect(http.requests[0]?.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect(http.requests[0]?.headers.authorization).toBe(`Bearer ${OR_KEY}`);
    expect(http.requests[0]?.body).toMatchObject({ model: 'anthropic/claude-x' });
  });

  it('U-O2: maps tokens and cached reads; does not invent a USD cost field', async () => {
    const { client } = orClient([
      {
        text: 'ok',
        usage: { inputTokens: 50, outputTokens: 8, cacheReadTokens: 10, cost: 0.00042 },
      },
    ]);
    const r = await client.generate(ask);
    expect(r.usage).toMatchObject({ inputTokens: 50, outputTokens: 8, cacheReadTokens: 10 });
    expect(r.usage).not.toHaveProperty('reportedCostUsd');
  });

  it('U-O3: injects routing prefs as a snake_case provider object, or omits it', async () => {
    const withRouting = orClient([{ text: 'ok' }], {
      routing: { dataCollection: 'deny', requireParameters: true, allowFallbacks: true },
    });
    await withRouting.client.generate(ask);
    expect(withRouting.http.requests[0]?.body).toMatchObject({
      provider: { data_collection: 'deny', require_parameters: true, allow_fallbacks: true },
    });

    const none = orClient([{ text: 'ok' }]);
    await none.client.generate(ask);
    expect(none.http.requests[0]?.body).not.toHaveProperty('provider');
  });

  it('U-O4: sends attribution headers only when configured', async () => {
    const none = orClient([{ text: 'ok' }]);
    await none.client.generate(ask);
    expect(none.http.requests[0]?.headers['http-referer']).toBeUndefined();
    expect(none.http.requests[0]?.headers['x-openrouter-title']).toBeUndefined();

    const withAttr = orClient([{ text: 'ok' }], {
      attribution: { referer: 'https://github.com/josephcake/soot', title: 'soot' },
    });
    await withAttr.client.generate(ask);
    expect(withAttr.http.requests[0]?.headers['http-referer']).toBe(
      'https://github.com/josephcake/soot',
    );
    expect(withAttr.http.requests[0]?.headers['x-openrouter-title']).toBe('soot');
  });

  it('U-O5: rewrites a 200+error 429 and honours Retry-After', async () => {
    const { client, http } = orClient([
      {
        error: {
          status: 429,
          mode: 'in-body',
          message: 'Rate limit exceeded',
          headers: { 'retry-after': '7' },
        },
      },
      { text: 'ok' },
    ]);
    const r = await client.generate(ask);
    expect(r.text).toBe('ok');
    expect(r.attempts).toBe(2);
    expect(http.requests).toHaveLength(2);
  });

  it('U-O6: a 200+error with a missing or odd code becomes 502 unavailable', async () => {
    const { client } = orClient([{ error: { status: 429, mode: 'in-body', code: 'slow' } }]);
    await expect(client.generate(ask)).rejects.toMatchObject({ kind: 'unavailable', status: 502 });
  });

  it('U-O7: does not rewrite a normal body that has error: null', async () => {
    const { fetch, requests } = scriptedFetch('openrouter', [{ text: 'yo' }]);
    const wrapped: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, error: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { provider, model } = entry(testRegistry(), 'openrouter/anthropic/claude-x');
    const client = createModelClient(provider, model, { env: OR_ENV, fetch: wrapped });
    const r = await client.generate(ask);
    expect(r.text).toBe('yo');
    expect(requests).toHaveLength(1);
  });

  it('U-O8: 402 without Retry-After is auth; with Retry-After is rate-limited', async () => {
    const noWait = orClient([{ error: { status: 402, message: 'Insufficient credits' } }]);
    await expect(noWait.client.generate(ask)).rejects.toMatchObject({
      kind: 'auth',
      status: 402,
      retryable: false,
    });
    expect(noWait.http.requests).toHaveLength(1);

    const wait = orClient([
      { error: { status: 402, message: 'budget', headers: { 'retry-after': '2' } } },
      { text: 'ok' },
    ]);
    const r = await wait.client.generate(ask);
    expect(r.text).toBe('ok');
    expect(r.attempts).toBe(2);
  });

  it('U-O9: missing key is auth and makes zero fetch calls', () => {
    const http = scriptedFetch('openrouter', [{ text: 'nope' }]);
    const { provider, model } = entry(testRegistry(), 'openrouter/anthropic/claude-x');
    expect(() => createModelClient(provider, model, { env: {}, fetch: http.fetch })).toThrow(
      expect.objectContaining({ kind: 'auth' }),
    );
    expect(http.requests).toHaveLength(0);
  });

  it('U-O10: a plain openai-compatible OpenRouter config works (docs path)', async () => {
    const http = scriptedFetch('openai', [{ text: 'via compat' }]);
    const provider = parseRegistryConfig({
      version: 1,
      providers: [
        {
          id: 'openrouter',
          kind: 'openai-compatible',
          baseURL: OPENROUTER_BASE_URL,
          apiKeyEnv: 'OPENROUTER_API_KEY',
        },
      ],
      models: [{ provider: 'openrouter', modelId: 'anthropic/claude-x' }],
    }).providers[0];
    const model = {
      ...entry(testRegistry(), 'openrouter/anthropic/claude-x').model,
    };
    if (provider === undefined) throw new Error('fixture');
    const client = createModelClient(
      provider,
      { ...model, provider: provider.id },
      { env: OR_ENV, fetch: http.fetch },
    );
    const r = await client.generate(ask);
    expect(r.text).toBe('via compat');
    expect(http.requests[0]?.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
  });
});

describe('config refine (U-CFG1)', () => {
  it('rejects routing on a non-openrouter kind, missing apiKeyEnv, and local: true', () => {
    expect(() =>
      parseRegistryConfig({
        version: 1,
        providers: [
          {
            id: 'openai',
            kind: 'openai',
            apiKeyEnv: 'OPENAI_API_KEY',
            routing: { dataCollection: 'deny' },
          },
        ],
        models: [],
      }),
    ).toThrow(/routing is only valid on openrouter providers/);
    expect(() =>
      parseRegistryConfig({
        version: 1,
        providers: [{ id: 'gemini', kind: 'google' }],
        models: [],
      }),
    ).toThrow(/need an apiKeyEnv/);
    expect(() =>
      parseRegistryConfig({
        version: 1,
        providers: [{ id: 'openrouter', kind: 'openrouter' }],
        models: [],
      }),
    ).toThrow(/need an apiKeyEnv/);
    expect(() =>
      parseRegistryConfig({
        version: 1,
        providers: [{ id: 'gemini', kind: 'google', apiKeyEnv: 'GEMINI_API_KEY', local: true }],
        models: [],
      }),
    ).toThrow(/cannot be local/);
  });
});

describe('discovery (library only, D-1/D-2)', () => {
  it('D-1: Gemini strips models/ prefix, filters generateContent, and follows page tokens up to the cap', async () => {
    const { provider } = entry(testRegistry(), 'gemini/test-gemini');
    const urls: string[] = [];
    const ids = await discoverModelIds(provider, {
      env: GEMINI_ENV,
      fetch: (input, init) => {
        const url = urlOf(input);
        urls.push(url);
        expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(GEMINI_KEY);
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        if (urls.length === 1) {
          return Promise.resolve(
            Response.json({
              models: [
                {
                  name: 'models/gemini-3.5-flash-lite',
                  supportedGenerationMethods: ['generateContent'],
                },
                { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
                { name: 'gemini-plain', supportedGenerationMethods: ['generateContent'] },
              ],
              nextPageToken: 'page-2',
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            models: [
              { name: 'models/gemini-next', supportedGenerationMethods: ['generateContent'] },
            ],
          }),
        );
      },
    });
    expect(ids).toEqual(['gemini-3.5-flash-lite', 'gemini-plain', 'gemini-next']);
    expect(urls[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(urls[1]).toContain('pageToken=page-2');
  });

  it('D-2: OpenRouter lists data[].id at the default base with a bearer token', async () => {
    const { provider } = entry(testRegistry(), 'openrouter/anthropic/claude-x');
    const urls: string[] = [];
    const ids = await discoverModelIds(provider, {
      env: OR_ENV,
      fetch: (input, init) => {
        urls.push(urlOf(input));
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${OR_KEY}`);
        return Promise.resolve(
          Response.json({ data: [{ id: 'anthropic/claude-x' }, { id: 'openai/gpt-x' }] }),
        );
      },
    });
    expect(ids).toEqual(['anthropic/claude-x', 'openai/gpt-x']);
    expect(urls).toEqual([`${OPENROUTER_BASE_URL}/models`]);
  });
});

describe('network guard', () => {
  it('throws instead of fetching an unexpected host', () => {
    const http = scriptedFetch('gemini', [{ text: 'x' }]);
    expect(
      () =>
        void http.fetch('https://example.test/v1beta/models/x:generateContent', {
          method: 'POST',
          body: '{}',
        }),
    ).toThrow(/network guard/);
  });
});
