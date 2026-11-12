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
}

const toUsage = (u: SdkUsage | undefined): Usage => ({
  inputTokens: u?.inputTokens ?? null,
  outputTokens: u?.outputTokens ?? null,
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
    const tools = toAiTools(this.provider, request.tools);
    const { value, attempts } = await withRetries(
      async () => {
        const abortSignal = this.#signal(signal, request.timeoutMs);
        try {
          signal?.throwIfAborted();
          return await generateText({
            ...this.#common(request),
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
