import type { LanguageModelV4 } from '@ai-sdk/provider';
import {
  NoObjectGeneratedError,
  Output,
  generateText,
  jsonSchema,
  streamText,
  tool,
  type ToolSet,
} from 'ai';
import { ProviderError, redact, toProviderError } from './errors.js';
import { DEFAULT_RETRY_POLICY, retryDelayMs, withRetries, type RetryPolicy } from './retry.js';
import type {
  FinishReason,
  GenerateRequest,
  GenerateResponse,
  ModelClient,
  StreamEvent,
  ToolCall,
  ToolSpec,
  Usage,
} from './types.js';

// The AI SDK logs warnings to the console by default. soot returns them on the response
// instead, so nothing provider-related is printed implicitly.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS ??= false;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export interface AiSdkModelClientOptions {
  readonly provider: string;
  readonly modelId: string;
  readonly adapter: string;
  /**
   * An AI SDK language model OBJECT. String ids are not accepted: in the AI SDK a bare string
   * routes through the hosted Vercel gateway, which soot never uses implicitly.
   */
  readonly model: LanguageModelV4;
  /** Used when a request does not set `maxOutputTokens` (from the registry, if known). */
  readonly defaultMaxOutputTokens?: number | null;
  readonly retry?: Partial<RetryPolicy>;
  /** Values to scrub from every error message (the provider key). Never exposed. */
  readonly secrets?: readonly string[];
  /**
   * Wire format for structured output (ADR-036). `json_object` needs the word "json" in the
   * prompt; if the caller omitted it, a short system line is added. Never includes user prompt
   * text in errors.
   */
  readonly structuredOutputMode?: 'json_schema' | 'json_object';
}

function toAiTools(provider: string, tools: readonly ToolSpec[] | undefined): ToolSet | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const spec of tools) {
    if (!TOOL_NAME.test(spec.name)) {
      throw new ProviderError({
        kind: 'invalid-request',
        provider,
        message: `tool name "${spec.name}" must be snake_case, ≤64 chars (portable across providers)`,
      });
    }
    set[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.inputSchema),
    });
  }
  return set;
}

const FINISH: readonly FinishReason[] = [
  'stop',
  'length',
  'tool-calls',
  'content-filter',
  'error',
  'other',
];
const toFinish = (reason: string | undefined): FinishReason =>
  (FINISH as readonly string[]).includes(reason ?? '') ? (reason as FinishReason) : 'other';

interface SdkUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: {
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  };
  /** The provider's own usage object, as received. */
  raw?: unknown;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Reasoning tokens a Chat Completions provider reported OUTSIDE `completion_tokens`. OpenAI
 * counts reasoning inside `completion_tokens`, and the AI SDK assumes that; some compatible
 * providers (xAI, checked live 2026-11-13) report it separately, and their `total_tokens`
 * shows it: total = prompt + completion + reasoning. Those tokens are billed as output, so
 * soot adds them. Vendor-neutral: decided from the numbers only, never from a provider id.
 */
export function hiddenReasoningTokens(raw: unknown): number {
  if (raw === null || typeof raw !== 'object') return 0;
  const r = raw as Record<string, unknown>;
  const prompt = num(r.prompt_tokens);
  const completion = num(r.completion_tokens);
  const total = num(r.total_tokens);
  const details = r.completion_tokens_details;
  const reasoning =
    details !== null && typeof details === 'object'
      ? num((details as Record<string, unknown>).reasoning_tokens)
      : null;
  if (prompt === null || completion === null || total === null || reasoning === null) return 0;
  return reasoning > 0 && total === prompt + completion + reasoning ? reasoning : 0;
}

const toUsage = (u: SdkUsage | undefined): Usage => ({
  inputTokens: u?.inputTokens ?? null,
  outputTokens:
    u?.outputTokens === undefined ? null : u.outputTokens + hiddenReasoningTokens(u.raw),
  cacheReadTokens: u?.inputTokenDetails?.cacheReadTokens ?? null,
  cacheWriteTokens: u?.inputTokenDetails?.cacheWriteTokens ?? null,
});

const toToolCall = (c: { toolCallId: string; toolName: string; input: unknown }): ToolCall => ({
  id: c.toolCallId,
  name: c.toolName,
  input: c.input,
});

/** `ModelClient` backed by an AI SDK language model, with soot's retries and error mapping. */
export class AiSdkModelClient implements ModelClient {
  readonly ref: string;
  readonly provider: string;
  readonly modelId: string;
  readonly adapter: string;
  readonly #model: LanguageModelV4;
  readonly #defaultMax: number | null;
  readonly #retry: RetryPolicy;
  readonly #secrets: readonly string[];
  readonly #structuredOutputMode: 'json_schema' | 'json_object';

  constructor(options: AiSdkModelClientOptions) {
    if (typeof options.model !== 'object')
      throw new TypeError('model must be an AI SDK model object');
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.ref = `${options.provider}/${options.modelId}`;
    this.adapter = options.adapter;
    this.#model = options.model;
    this.#defaultMax = options.defaultMaxOutputTokens ?? null;
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.#secrets = options.secrets ?? [];
    this.#structuredOutputMode = options.structuredOutputMode ?? 'json_schema';
  }

  /** Some JSON-object endpoints require the word "json" in the prompt. */
  #withJsonMention(request: GenerateRequest): GenerateRequest {
    if (this.#structuredOutputMode !== 'json_object') return request;
    const parts = [request.system, ...request.messages.map((m) => m.content)];
    if (parts.some((t) => t !== undefined && /\bjson\b/i.test(t))) return request;
    return {
      ...request,
      system: [request.system, 'Return a JSON object.']
        .filter((s): s is string => s !== undefined && s !== '')
        .join('\n'),
    };
  }

  #error(error: unknown): ProviderError {
    return toProviderError(error, this.provider, this.#secrets);
  }

  #signal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
    const signals = [
      signal,
      timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
    ].filter((s): s is AbortSignal => s !== undefined);
    return signals.length === 0 ? undefined : AbortSignal.any(signals);
  }

  #common(request: GenerateRequest) {
    const maxOutputTokens = request.maxOutputTokens ?? this.#defaultMax ?? undefined;
    return {
      model: this.#model,
      ...(request.system === undefined ? {} : { system: request.system }),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      maxRetries: 0, // soot owns retries (rate-limit aware, bounded, testable)
    };
  }

  #warnings(warnings: readonly unknown[] | undefined): string[] {
    return (warnings ?? []).map((w) => redact(JSON.stringify(w), this.#secrets));
  }

  async generate<T = unknown>(
    request: GenerateRequest<T>,
    signal?: AbortSignal,
  ): Promise<GenerateResponse<T>> {
    const req = this.#withJsonMention(request);
    const tools = toAiTools(this.provider, req.tools);
    const { value, attempts } = await withRetries(
      async () => {
        const abortSignal = this.#signal(signal, req.timeoutMs);
        try {
          signal?.throwIfAborted();
          return await generateText({
            ...this.#common(req),
            ...(tools === undefined ? {} : { tools }),
            ...(request.output === undefined
              ? {}
              : {
                  output: Output.object({
                    schema: request.output.schema,
                    name: request.output.name ?? 'output',
                  }),
                }),
            ...(abortSignal === undefined ? {} : { abortSignal }),
          });
        } catch (error) {
          if (NoObjectGeneratedError.isInstance(error)) {
            // The SDK's own parse/validation of the structured output failed.
            throw new ProviderError({
              kind: 'invalid-output',
              provider: this.provider,
              message: redact(
                `structured output failed validation: ${error.message}`,
                this.#secrets,
              ),
            });
          }
          throw this.#error(error);
        }
      },
      this.#retry,
      signal,
    ).catch((error: unknown) => {
      throw this.#error(error);
    });

    let output: T | undefined;
    if (request.output !== undefined) {
      // Validate on receipt; never trust a provider's "strict" mode.
      let parsed: unknown;
      try {
        parsed = JSON.parse(value.text);
      } catch {
        throw new ProviderError({
          kind: 'invalid-output',
          provider: this.provider,
          message: 'structured output is not valid JSON',
        });
      }
      const checked = request.output.schema.safeParse(parsed);
      if (!checked.success) {
        throw new ProviderError({
          kind: 'invalid-output',
          provider: this.provider,
          message: `structured output failed validation: ${checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
        });
      }
      output = checked.data;
    }

    return {
      ref: this.ref,
      servedModelId: value.finalStep.response.modelId,
      text: value.text,
      toolCalls: value.toolCalls.map(toToolCall),
      output,
      finishReason: toFinish(value.finishReason),
      usage: toUsage(value.usage),
      warnings: this.#warnings(value.warnings),
      attempts,
    };
  }

  async *stream(
    request: Omit<GenerateRequest, 'output'>,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const tools = toAiTools(this.provider, request.tools);
    for (let attempt = 1; ; attempt++) {
      let yielded = false;
      try {
        signal?.throwIfAborted();
        const abortSignal = this.#signal(signal, request.timeoutMs);
        const result = streamText({
          ...this.#common(request),
          ...(tools === undefined ? {} : { tools }),
          ...(abortSignal === undefined ? {} : { abortSignal }),
          onError: () => undefined, // surfaced through the stream's error part below
        });
        let text = '';
        const calls: ToolCall[] = [];
        for await (const part of result.stream) {
          if (part.type === 'text-delta') {
            yielded = true;
            text += part.text;
            yield { type: 'text-delta', text: part.text };
          } else if (part.type === 'tool-call') {
            yielded = true;
            const call = toToolCall(part);
            calls.push(call);
            yield { type: 'tool-call', call };
          } else if (part.type === 'error') {
            throw part.error;
          } else if (part.type === 'finish') {
            const { response } = await result.finalStep;
            yield {
              type: 'finish',
              response: {
                ref: this.ref,
                servedModelId: response.modelId,
                text,
                toolCalls: calls,
                output: undefined,
                finishReason: toFinish(part.finishReason),
                usage: toUsage(part.totalUsage),
                warnings: this.#warnings(await result.warnings),
                attempts: attempt,
              },
            };
          }
        }
        return;
      } catch (error) {
        const providerError = this.#error(error);
        // Retry only if nothing reached the caller yet; a half-delivered stream is not replayed.
        if (yielded || !providerError.retryable || attempt >= this.#retry.maxAttempts)
          throw providerError;
        await this.#retry
          .sleep(retryDelayMs(providerError, attempt, this.#retry), signal)
          .catch((e: unknown) => {
            throw this.#error(e);
          });
      }
    }
  }

  /** Safe description for logs: no credentials, no internals. */
  toJSON(): Record<string, string> {
    return { ref: this.ref, adapter: this.adapter };
  }
}
