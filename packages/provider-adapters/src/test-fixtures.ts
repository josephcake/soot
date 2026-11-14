/*
 * Test-only HTTP fakes for provider wire formats (OpenAI Chat Completions, Anthropic Messages,
 * Gemini generateContent, OpenRouter Chat Completions). A scripted `fetch` returns one scripted
 * turn per request and records every request so tests can assert what was (and was not) sent.
 * No network access. Gemini and OpenRouter formats throw if a request hits an unexpected host.
 */
import { parseRegistryConfig, type ModelEntry, type ProviderConfig } from '@soot/model-registry';
import { ModelRegistry } from '@soot/model-registry';

export interface Turn {
  readonly text?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[];
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly thoughtsTokens?: number;
    readonly cost?: number;
  };
  readonly servedModelId?: string;
  /** Gemini `candidates[].finishReason` (`STOP`, `MAX_TOKENS`, `SAFETY`, ...). */
  readonly geminiFinishReason?: string;
  readonly error?: {
    readonly status: number;
    readonly headers?: Record<string, string>;
    readonly message?: string;
    /** OpenRouter: `in-body` = HTTP 200 + `{error}` and no `choices`. Default `http`. */
    readonly mode?: 'http' | 'in-body';
    /** OpenRouter in-body `error.code` when it should differ from `status`. */
    readonly code?: number | string;
    /** Gemini RPC `status`, e.g. `RESOURCE_EXHAUSTED`. */
    readonly googleStatus?: string;
  };
}

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly rawBody: string;
}

export type WireFormat = 'openai' | 'anthropic' | 'gemini' | 'openrouter';

const sse = (events: readonly { event?: string; data: unknown }[]) =>
  events
    .map(
      (e) =>
        `${e.event === undefined ? '' : `event: ${e.event}\n`}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`,
    )
    .join('');

function openaiJson(t: Turn) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: t.servedModelId ?? 'served-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: t.text ?? null,
          ...(t.toolCalls
            ? {
                tool_calls: t.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.input) },
                })),
              }
            : {}),
        },
        finish_reason: t.toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: openaiUsage(t),
  };
}

function openaiStream(t: Turn) {
  const base = {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 1,
    model: t.servedModelId ?? 'served-model',
  };
  const pieces = (t.text ?? '').match(/.{1,3}/gs) ?? [];
  return sse([
    ...pieces.map((p, i) => ({
      data: {
        ...base,
        choices: [
          {
            index: 0,
            delta: i === 0 ? { role: 'assistant', content: p } : { content: p },
            finish_reason: null,
          },
        ],
      },
    })),
    { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
    {
      data: {
        ...base,
        choices: [],
        usage: {
          prompt_tokens: t.usage?.inputTokens ?? 0,
          completion_tokens: t.usage?.outputTokens ?? 0,
          total_tokens: (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0),
        },
      },
    },
    { data: '[DONE]' },
  ]);
}

function anthropicJson(t: Turn) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: t.servedModelId ?? 'served-model',
    content: [
      ...(t.text === undefined ? [] : [{ type: 'text', text: t.text }]),
      ...(t.toolCalls ?? []).map((c) => ({
        type: 'tool_use',
        id: c.id,
        name: c.name,
        input: c.input,
      })),
    ],
    stop_reason: t.toolCalls ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: t.usage?.inputTokens ?? 0, output_tokens: t.usage?.outputTokens ?? 0 },
  };
}

function anthropicStream(t: Turn) {
  const pieces = (t.text ?? '').match(/.{1,3}/gs) ?? [];
  return sse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: t.servedModelId ?? 'served-model',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: t.usage?.inputTokens ?? 0, output_tokens: 0 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    ...pieces.map((p) => ({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } },
    })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: t.usage?.outputTokens ?? 0 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

const GOOGLE_RPC_STATUS: Readonly<Record<number, string>> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
  402: 'FAILED_PRECONDITION',
};

function errorBody(format: WireFormat, turn: Turn) {
  const status = turn.error?.status ?? 500;
  const message = turn.error?.message ?? `HTTP ${status}`;
  if (format === 'anthropic')
    return {
      type: 'error',
      error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message },
    };
  if (format === 'gemini')
    return {
      error: {
        code: status,
        message,
        status: turn.error?.googleStatus ?? GOOGLE_RPC_STATUS[status] ?? 'UNKNOWN',
      },
    };
  if (format === 'openrouter') {
    const code = turn.error?.code ?? status;
    return {
      error: {
        code,
        message,
        metadata: { error_type: status === 429 ? 'rate_limit_exceeded' : 'error' },
      },
    };
  }
  return { error: { message, type: 'error', code: null } };
}

function geminiFinish(t: Turn): string {
  return t.geminiFinishReason ?? 'STOP';
}

function geminiJson(t: Turn) {
  const thoughts = t.usage?.thoughtsTokens ?? 0;
  const cacheRead = t.usage?.cacheReadTokens ?? 0;
  const input = t.usage?.inputTokens ?? 0;
  const output = t.usage?.outputTokens ?? 0;
  const parts: Record<string, unknown>[] = [];
  if (t.text !== undefined) parts.push({ text: t.text });
  for (const c of t.toolCalls ?? [])
    parts.push({ functionCall: { name: c.name, args: c.input, id: c.id } });
  return {
    candidates: [
      {
        content: { role: 'model', parts: parts.length === 0 ? [{ text: '' }] : parts },
        finishReason: geminiFinish(t),
      },
    ],
    usageMetadata: {
      promptTokenCount: input,
      cachedContentTokenCount: cacheRead,
      candidatesTokenCount: output,
      thoughtsTokenCount: thoughts,
      totalTokenCount: input + output + thoughts,
    },
    modelVersion: t.servedModelId ?? 'served-model',
  };
}

function geminiStream(t: Turn) {
  const pieces = (t.text ?? '').match(/.{1,3}/gs) ?? [];
  const usage = (geminiJson(t) as { usageMetadata: unknown }).usageMetadata;
  const events: string[] = [];
  if (pieces.length === 0) {
    events.push(
      `data: ${JSON.stringify({
        candidates: [
          { content: { role: 'model', parts: [{ text: '' }] }, finishReason: geminiFinish(t) },
        ],
        usageMetadata: usage,
        modelVersion: t.servedModelId ?? 'served-model',
      })}\n\n`,
    );
  } else {
    pieces.forEach((piece, i) => {
      const last = i === pieces.length - 1;
      events.push(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: piece }] },
              ...(last ? { finishReason: geminiFinish(t) } : {}),
            },
          ],
          ...(last
            ? { usageMetadata: usage, modelVersion: t.servedModelId ?? 'served-model' }
            : {}),
        })}\n\n`,
      );
    });
  }
  return events.join('');
}

function openaiUsage(t: Turn) {
  const input = t.usage?.inputTokens ?? 0;
  const output = t.usage?.outputTokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(t.usage?.cost !== undefined ? { cost: t.usage.cost } : {}),
    ...(t.usage?.cacheReadTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: t.usage.cacheReadTokens } }
      : {}),
  };
}

function assertAllowedHost(url: string, format: WireFormat): void {
  if (format !== 'gemini' && format !== 'openrouter') return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`network guard: unparseable URL ${url}`);
  }
  const allowed =
    format === 'gemini'
      ? new Set(['127.0.0.1', 'localhost', 'generativelanguage.googleapis.com'])
      : new Set(['127.0.0.1', 'localhost', 'openrouter.ai']);
  if (!allowed.has(host)) throw new Error(`network guard: unexpected host ${host}`);
}

/** A fake `fetch` answering in `format`, one scripted turn per request (last turn repeats). */
export function scriptedFetch(format: WireFormat, turns: readonly Turn[]) {
  const requests: RecordedRequest[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted === true) return Promise.reject(init.signal.reason as Error);
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const body: unknown = rawBody === '' ? null : JSON.parse(rawBody);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const url = input instanceof Request ? input.url : String(input);
    assertAllowedHost(url, format);
    requests.push({
      url,
      headers,
      body,
      rawBody,
    });
    const turn = turns[Math.min(requests.length - 1, turns.length - 1)];
    if (turn === undefined) throw new Error('no scripted turns');
    if (turn.error !== undefined) {
      const inBody = format === 'openrouter' && turn.error.mode === 'in-body';
      return Promise.resolve(
        new Response(JSON.stringify(errorBody(format, turn)), {
          status: inBody ? 200 : turn.error.status,
          headers: { 'content-type': 'application/json', ...turn.error.headers },
        }),
      );
    }
    const streaming =
      format === 'gemini'
        ? url.includes('streamGenerateContent')
        : (body as { stream?: boolean } | null)?.stream === true;
    const payload = streaming
      ? format === 'anthropic'
        ? anthropicStream(turn)
        : format === 'gemini'
          ? geminiStream(turn)
          : openaiStream(turn)
      : JSON.stringify(
          format === 'anthropic'
            ? anthropicJson(turn)
            : format === 'gemini'
              ? geminiJson(turn)
              : openaiJson(turn),
        );
    return Promise.resolve(
      new Response(payload, {
        status: 200,
        headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' },
      }),
    );
  };
  return { fetch, requests };
}

/** Fictional registry used by adapter tests. */
export function testRegistry(): ModelRegistry {
  return new ModelRegistry(
    parseRegistryConfig({
      version: 1,
      providers: [
        { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
        { id: 'openai', kind: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
        {
          id: 'local',
          kind: 'openai-compatible',
          baseURL: 'http://127.0.0.1:65530/v1',
          local: true,
        },
        { id: 'listed-vendor', kind: 'listed-only' },
        {
          id: 'deepseek',
          kind: 'openai-compatible',
          baseURL: 'https://api.deepseek.com/v1',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
        },
        { id: 'gemini', kind: 'google', apiKeyEnv: 'GEMINI_API_KEY' },
        { id: 'openrouter', kind: 'openrouter', apiKeyEnv: 'OPENROUTER_API_KEY' },
      ],
      models: [
        {
          provider: 'anthropic',
          modelId: 'test-claude',
          maxOutputTokens: 1024,
          capabilities: { tools: true, structuredOutput: true },
        },
        {
          provider: 'openai',
          modelId: 'test-gpt',
          capabilities: { tools: true, structuredOutput: true },
        },
        { provider: 'local', modelId: 'test-local', capabilities: { structuredOutput: true } },
        { provider: 'listed-vendor', modelId: 'test-listed' },
        { provider: 'deepseek', modelId: 'test-ds' },
        {
          provider: 'gemini',
          modelId: 'test-gemini',
          maxOutputTokens: 1024,
          capabilities: { tools: true, structuredOutput: true },
        },
        {
          provider: 'openrouter',
          modelId: 'anthropic/claude-x',
          maxOutputTokens: 1024,
          capabilities: { tools: true, structuredOutput: true },
        },
      ],
    }),
  );
}

export function entry(
  registry: ModelRegistry,
  ref: string,
): { provider: ProviderConfig; model: ModelEntry } {
  const model = registry.get(ref);
  const provider = model === undefined ? undefined : registry.provider(model.provider);
  if (model === undefined || provider === undefined) throw new Error(`no ${ref}`);
  return { provider, model };
}
