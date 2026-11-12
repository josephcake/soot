/**
 * Credential isolation (M2-08). A fake key is planted in the environment the adapter reads.
 * It must reach the provider ONLY as the auth header of the outbound request, and must be
 * absent from request bodies, responses, errors, warnings, logs, and serialized clients.
 * The values are fictional; nothing here talks to a real provider.
 */
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRegistryConfig } from '@soot/model-registry';
import { createModelClient } from './adapters.js';
import { discoverModelIds } from './discovery.js';
import { ProviderError } from './errors.js';
import { entry, scriptedFetch, testRegistry, type WireFormat } from './test-fixtures.js';
import type { StreamEvent } from './types.js';

const ANTHROPIC_SECRET = 'sk-ant-FAKE-test-secret-4f1c9a';
const OPENAI_SECRET = 'sk-proj-FAKE-test-secret-77d2be';
const env = { ANTHROPIC_API_KEY: ANTHROPIC_SECRET, OPENAI_API_KEY: OPENAI_SECRET };

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => inspect(a, { depth: 10 })).join(' '));
    });
  }
  const write = (chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(write);
  vi.spyOn(process.stderr, 'write').mockImplementation(write);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const deepDump = (value: unknown) =>
  `${inspect(value, { depth: Infinity, showHidden: true, getters: true })}\n${JSON.stringify(value)}`;

const cases: {
  name: string;
  ref: string;
  format: WireFormat;
  secret: string;
  header: string;
  expected: string;
}[] = [
  {
    name: 'anthropic',
    ref: 'anthropic/test-claude',
    format: 'anthropic',
    secret: ANTHROPIC_SECRET,
    header: 'x-api-key',
    expected: ANTHROPIC_SECRET,
  },
  {
    name: 'openai',
    ref: 'openai/test-gpt',
    format: 'openai',
    secret: OPENAI_SECRET,
    header: 'authorization',
    expected: `Bearer ${OPENAI_SECRET}`,
  },
];

describe.each(cases)('credential isolation: $name', (c) => {
  it('sends the key only in the auth header, never in bodies, responses, warnings, or logs', async () => {
    const http = scriptedFetch(c.format, [
      { text: 'fine', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const { provider, model } = entry(testRegistry(), c.ref);
    const client = createModelClient(provider, model, { env, fetch: http.fetch });
    const response = await client.generate({ messages: [{ role: 'user', content: 'hi' }] });
    const events: StreamEvent[] = [];
    for await (const e of client.stream({ messages: [{ role: 'user', content: 'hi' }] }))
      events.push(e);

    expect(http.requests).toHaveLength(2);
    for (const req of http.requests) {
      expect(req.headers[c.header]).toBe(c.expected);
      expect(req.rawBody).not.toContain(c.secret);
      expect(req.url).not.toContain(c.secret);
      const otherHeaders = Object.entries(req.headers).filter(([k]) => k !== c.header);
      expect(JSON.stringify(otherHeaders)).not.toContain(c.secret);
    }
    expect(deepDump(response)).not.toContain(c.secret);
    expect(deepDump(events)).not.toContain(c.secret);
    expect(deepDump(client)).not.toContain(c.secret);
    expect(logged.join('\n')).not.toContain(c.secret);
  });

  it('scrubs the key from errors even when the provider echoes it back', async () => {
    for (const status of [401, 429, 500, 400]) {
      const http = scriptedFetch(c.format, [
        {
          error: {
            status,
            message: `Incorrect API key provided: ${c.secret}`,
            headers: { 'x-echo': c.secret },
          },
        },
      ]);
      const { provider, model } = entry(testRegistry(), c.ref);
      const client = createModelClient(provider, model, {
        env,
        fetch: http.fetch,
        retry: { maxAttempts: 2, sleep: () => Promise.resolve() },
      });
      const error = await client
        .generate({ messages: [{ role: 'user', content: 'hi' }] })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(deepDump(error)).not.toContain(c.secret);
      expect(String((error as Error).stack)).not.toContain(c.secret);
      expect((error as Error).message).toContain('[redacted]');

      let streamError: unknown;
      try {
        for await (const e of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
          expect(e).toBeUndefined(); // unreachable: the stream fails before any event
        }
      } catch (e) {
        streamError = e;
      }
      expect(streamError).toBeInstanceOf(ProviderError);
      expect(deepDump(streamError)).not.toContain(c.secret);
    }
    expect(logged.join('\n')).not.toContain(c.secret);
  });

  it('keeps the key out of discovery results and errors', async () => {
    const { provider } = entry(testRegistry(), c.ref);
    const ok = await discoverModelIds(provider, {
      env,
      fetch: () => Promise.resolve(Response.json({ data: [{ id: 'm1' }] })),
    });
    expect(deepDump(ok)).not.toContain(c.secret);
    const failed = await discoverModelIds(provider, {
      env,
      fetch: () => Promise.reject(new TypeError(`fetch failed for ${c.secret}`)),
    }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ProviderError);
    expect(deepDump(failed)).not.toContain(c.secret);
  });
});

describe('credential sourcing', () => {
  it('reports a missing key by variable name and never reads keys from elsewhere', () => {
    const { provider, model } = entry(testRegistry(), 'anthropic/test-claude');
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = ANTHROPIC_SECRET; // ignored: an explicit env was injected
    try {
      const error = (() => {
        try {
          createModelClient(provider, model, { env: {} });
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(error).toMatchObject({ kind: 'auth' });
      expect((error as Error).message).toContain('ANTHROPIC_API_KEY');
      expect(deepDump(error)).not.toContain(ANTHROPIC_SECRET);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('rejects registry config that inlines a key instead of naming a variable', () => {
    expect(() =>
      parseRegistryConfig({
        version: 1,
        providers: [{ id: 'openai', kind: 'openai', apiKeyEnv: OPENAI_SECRET }],
        models: [],
      }),
    ).toThrow(/environment variable name/);
    expect(() =>
      parseRegistryConfig({
        version: 1,
        providers: [{ id: 'openai', kind: 'openai', apiKey: OPENAI_SECRET }],
        models: [],
      }),
    ).toThrow();
  });

  it('keeps keys out of registry entries and the request types handed to agents', () => {
    const registry = testRegistry();
    expect(deepDump(registry.providers())).not.toMatch(/sk-/);
    expect(deepDump(registry.models())).not.toMatch(/sk-/);
  });
});
