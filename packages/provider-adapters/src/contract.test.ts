/**
 * Provider contract (M2-01, M2-02, M2-03): the same behavioural suite runs against the mock
 * test double and against each real adapter wired to a scripted fake `fetch`. No network.
 */
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createModelClient } from './adapters.js';
import { AiSdkModelClient } from './ai-sdk-client.js';
import { ProviderError } from './errors.js';
import { createMockModelClient } from './mock-provider.js';
import { entry, scriptedFetch, testRegistry, type Turn, type WireFormat } from './test-fixtures.js';
import type { ModelClient, StreamEvent } from './types.js';

interface Built {
  readonly client: ModelClient;
  readonly calls: () => number;
  readonly sleeps: number[];
}

interface Harness {
  readonly name: string;
  build(turns: readonly Turn[]): Built;
}

const FAKE_ENV = { ANTHROPIC_API_KEY: 'test-anthropic-key', OPENAI_API_KEY: 'test-openai-key' };

function httpHarness(name: string, ref: string, format: WireFormat): Harness {
  return {
    name,
    build(turns) {
      const sleeps: number[] = [];
      const http = scriptedFetch(format, turns);
      const { provider, model } = entry(testRegistry(), ref);
      const client = createModelClient(provider, model, {
        env: FAKE_ENV,
        fetch: http.fetch,
        retry: {
          sleep: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
          },
          random: () => 1,
        },
      });
      return { client, calls: () => http.requests.length, sleeps };
    },
  };
}

const harnesses: Harness[] = [
  {
    name: 'mock test double',
    build(turns) {
      const sleeps: number[] = [];
      const client = createMockModelClient({
        turns: turns.map((t) => ({ ...t })),
        retry: {
          sleep: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
          },
          random: () => 1,
        },
      });
      return { client, calls: client.calls, sleeps };
    },
  },
  httpHarness('anthropic adapter (mocked HTTP)', 'anthropic/test-claude', 'anthropic'),
  httpHarness('openai adapter (mocked HTTP)', 'openai/test-gpt', 'openai'),
  httpHarness('openai-compatible adapter (mocked HTTP)', 'local/test-local', 'openai'),
];

const ask = { messages: [{ role: 'user' as const, content: 'hello' }] };

describe.each(harnesses)('provider contract: $name', (h) => {
  it('generates text with usage and the served model id', async () => {
    const { client } = h.build([
      { text: 'hi there', usage: { inputTokens: 12, outputTokens: 3 }, servedModelId: 'served-1' },
    ]);
    const r = await client.generate(ask);
    expect(r.text).toBe('hi there');
    expect(r.finishReason).toBe('stop');
    expect(r.usage.inputTokens).toBe(12);
    expect(r.usage.outputTokens).toBe(3);
    expect(r.servedModelId).toBe('served-1');
    expect(r.attempts).toBe(1);
    expect(r.ref).toBe(client.ref);
  });

  it('returns tool calls with parsed input', async () => {
    const { client } = h.build([
      {
        toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }],
        usage: { inputTokens: 5, outputTokens: 2 },
      },
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

  it('rejects tool names that are not portable snake_case', async () => {
    const { client, calls } = h.build([{ text: 'x' }]);
    await expect(
      client.generate({
        ...ask,
        tools: [{ name: 'Read-File', description: 'x', inputSchema: { type: 'object' } }],
      }),
    ).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(calls()).toBe(0);
  });

  const Plan = z.object({ steps: z.array(z.string()).min(1) });

  it('validates structured output against the schema', async () => {
    const { client } = h.build([{ text: JSON.stringify({ steps: ['a', 'b'] }) }]);
    const r = await client.generate({ ...ask, output: { schema: Plan, name: 'plan' } });
    expect(r.output).toEqual({ steps: ['a', 'b'] });
  });

  it('fails structured output that does not match (never trusts a silently ignored schema)', async () => {
    const { client } = h.build([{ text: JSON.stringify({ steps: [] }) }]);
    const error = await client
      .generate({ ...ask, output: { schema: Plan } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'invalid-output', retryable: false });
  });

  it('streams text deltas then a finish event with usage', async () => {
    const { client } = h.build([
      { text: 'streamed answer', usage: { inputTokens: 7, outputTokens: 4 } },
    ]);
    const events: StreamEvent[] = [];
    for await (const e of client.stream(ask)) events.push(e);
    const deltas = events.flatMap((e) => (e.type === 'text-delta' ? [e.text] : []));
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('streamed answer');
    const last = events.at(-1);
    expect(last?.type).toBe('finish');
    if (last?.type !== 'finish') return;
    expect(last.response.text).toBe('streamed answer');
    expect(last.response.usage.inputTokens).toBe(7);
    expect(last.response.usage.outputTokens).toBe(4);
  });

  it('honours retry-after on 429 and then succeeds', async () => {
    const { client, calls, sleeps } = h.build([
      { error: { status: 429, headers: { 'retry-after': '2' } } },
      { text: 'ok' },
    ]);
    const r = await client.generate(ask);
    expect(r.text).toBe('ok');
    expect(r.attempts).toBe(2);
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('backs off exponentially on 429 without retry-after (Anthropic often omits it)', async () => {
    const { client, sleeps } = h.build([
      { error: { status: 429 } },
      { error: { status: 429 } },
      { text: 'ok' },
    ]);
    const r = await client.generate(ask);
    expect(r.attempts).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('gives up after a bounded number of attempts on a persistent outage', async () => {
    const { client, calls } = h.build([{ error: { status: 503 } }]);
    const error = await client.generate(ask).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'unavailable', status: 503, retryable: true });
    expect(calls()).toBe(3);
  });

  it('treats 529 overloaded as unavailable', async () => {
    const { client } = h.build([{ error: { status: 529 } }]);
    await expect(client.generate(ask)).rejects.toMatchObject({ kind: 'unavailable', status: 529 });
  });

  it('does not retry auth or invalid-request errors', async () => {
    for (const [status, kind] of [
      [401, 'auth'],
      [400, 'invalid-request'],
    ] as const) {
      const { client, calls } = h.build([{ error: { status } }]);
      await expect(client.generate(ask)).rejects.toMatchObject({ kind, status, retryable: false });
      expect(calls()).toBe(1);
    }
  });

  it('retries a stream that fails before producing output', async () => {
    const { client, calls } = h.build([{ error: { status: 503 } }, { text: 'recovered' }]);
    let text = '';
    for await (const e of client.stream(ask)) if (e.type === 'text-delta') text += e.text;
    expect(text).toBe('recovered');
    expect(calls()).toBe(2);
  });

  it('aborts when the caller cancels', async () => {
    const { client } = h.build([{ text: 'never' }]);
    const controller = new AbortController();
    controller.abort();
    await expect(client.generate(ask, controller.signal)).rejects.toMatchObject({
      kind: 'aborted',
    });
  });
});

describe('request wiring (mocked HTTP)', () => {
  it('sends Anthropic Messages requests with x-api-key and a bounded max_tokens', async () => {
    const http = scriptedFetch('anthropic', [{ text: 'ok' }]);
    const { provider, model } = entry(testRegistry(), 'anthropic/test-claude');
    await createModelClient(provider, model, { env: FAKE_ENV, fetch: http.fetch }).generate({
      system: 'be brief',
      ...ask,
    });
    const req = http.requests[0];
    expect(req?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req?.headers['x-api-key']).toBe('test-anthropic-key');
    expect(req?.headers['anthropic-version']).toBeDefined();
    expect(req?.body).toMatchObject({
      model: 'test-claude',
      max_tokens: 1024,
      system: [{ type: 'text', text: 'be brief' }],
    });
  });

  it('sends OpenAI Chat Completions requests with a bearer token and strict json_schema', async () => {
    const http = scriptedFetch('openai', [{ text: '{"steps":["a"]}' }]);
    const { provider, model } = entry(testRegistry(), 'openai/test-gpt');
    await createModelClient(provider, model, { env: FAKE_ENV, fetch: http.fetch }).generate({
      ...ask,
      output: { schema: z.object({ steps: z.array(z.string()) }), name: 'plan' },
    });
    const req = http.requests[0];
    expect(req?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req?.headers.authorization).toBe('Bearer test-openai-key');
    expect(req?.body).toMatchObject({
      model: 'test-gpt',
      response_format: { type: 'json_schema' },
    });
  });

  it('sends OpenAI-compatible requests to the configured custom endpoint without a key', async () => {
    const http = scriptedFetch('openai', [{ text: 'ok' }]);
    const { provider, model } = entry(testRegistry(), 'local/test-local');
    await createModelClient(provider, model, { env: {}, fetch: http.fetch }).generate(ask);
    const req = http.requests[0];
    expect(req?.url).toBe('http://127.0.0.1:65530/v1/chat/completions');
    expect(req?.headers.authorization).toBeUndefined();
  });

  it('times out a slow call as a retryable timeout', async () => {
    const client = createMockModelClient({
      turns: [{ text: 'slow', delayMs: 500 }],
      retry: { maxAttempts: 1 },
    });
    const error = await client.generate({ ...ask, timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'timeout', retryable: true });
  });

  it('never routes a bare model id string through the AI SDK gateway', () => {
    expect(
      () =>
        new AiSdkModelClient({
          provider: 'openai',
          modelId: 'gpt-x',
          adapter: 'test',
          model: 'openai/gpt-x' as unknown as LanguageModelV4,
        }),
    ).toThrow(TypeError);
  });
});
