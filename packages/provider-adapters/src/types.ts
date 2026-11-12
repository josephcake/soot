import type { z } from 'zod';

/*
 * soot's provider abstraction (M2-01). Everything above this layer (routing, runtime) talks to
 * a `ModelClient`; provider specifics stay in adapters. Requests carry no credentials and
 * responses never contain them.
 */

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** A tool the model may call. soot does not execute tools here; calls are returned. */
export interface ToolSpec {
  /** snake_case, ≤64 chars: the portable subset across providers (research §3.2). */
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool input (object). */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface GenerateRequest<T = unknown> {
  readonly system?: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSpec[];
  /**
   * Ask for structured output. The response is validated against this schema on receipt;
   * provider "strict" modes are not trusted (research §3.2, §6).
   */
  readonly output?: { readonly schema: z.ZodType<T>; readonly name?: string };
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** Per-attempt timeout in ms. */
  readonly timeoutMs?: number;
}

/** Token usage the provider reported. `null` = not reported (never assumed 0). */
export interface Usage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other';

export interface GenerateResponse<T = unknown> {
  /** soot model reference `provider/modelId` that was asked. */
  readonly ref: string;
  /** Model id the provider says served the request (may differ: aliasing), or `null`. */
  readonly servedModelId: string | null;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  /** Validated structured output; `undefined` when no `output` was requested. */
  readonly output: T | undefined;
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  /** Provider/SDK warnings (e.g. ignored settings). */
  readonly warnings: readonly string[];
  /** Attempts made, including retries (≥1). */
  readonly attempts: number;
}

export type StreamEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'tool-call'; readonly call: ToolCall }
  | { readonly type: 'finish'; readonly response: GenerateResponse<undefined> };

export interface ModelClient {
  /** `provider/modelId`. */
  readonly ref: string;
  readonly provider: string;
  readonly modelId: string;
  /** Adapter implementation, e.g. `ai-sdk:anthropic` or `mock-test-double`. */
  readonly adapter: string;
  generate<T = unknown>(
    request: GenerateRequest<T>,
    signal?: AbortSignal,
  ): Promise<GenerateResponse<T>>;
  /** Stream text and tool calls; the final event carries the full response. No structured output. */
  stream(
    request: Omit<GenerateRequest, 'output'>,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}
