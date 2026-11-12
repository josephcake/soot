import {
  APICallError,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { AiSdkModelClient } from './ai-sdk-client.js';
import type { RetryPolicy } from './retry.js';
import type { ModelClient } from './types.js';

/*
 * TEST DOUBLE. A scripted model behind the real `AiSdkModelClient`, so contract tests exercise
 * soot's mapping, retries, and validation without any network access. It calls no provider.
 */

export interface MockModelTurn {
  readonly text?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[];
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
  };
  readonly finishReason?: 'stop' | 'length' | 'tool-calls';
  readonly servedModelId?: string;
  /** Fail this call with an HTTP-like provider error instead of answering. */
  readonly error?: {
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly message?: string;
  };
  readonly delayMs?: number;
}

export interface MockModelClientOptions {
  readonly provider?: string;
  readonly modelId?: string;
  /** One turn per call; the last turn repeats. */
  readonly turns: readonly MockModelTurn[];
  readonly retry?: Partial<RetryPolicy>;
}

const usageOf = (turn: MockModelTurn) => ({
  inputTokens: {
    total: turn.usage?.inputTokens,
    noCache: undefined,
    cacheRead: turn.usage?.cacheReadTokens,
    cacheWrite: undefined,
  },
  outputTokens: { total: turn.usage?.outputTokens, text: undefined, reasoning: undefined },
});

const finishOf = (turn: MockModelTurn) => {
  const unified = turn.finishReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? 'tool-calls' : 'stop');
  return { unified, raw: unified };
};

const wait = (ms: number | undefined, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (ms === undefined || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException('aborted', 'AbortError'),
        );
      },
      { once: true },
    );
  });

function failIfScripted(turn: MockModelTurn): void {
  if (turn.error === undefined) return;
  throw new APICallError({
    message: turn.error.message ?? `mock HTTP ${turn.error.status}`,
    url: 'mock://model',
    requestBodyValues: {},
    statusCode: turn.error.status,
    responseHeaders: { ...turn.error.headers },
    isRetryable: turn.error.status === 429 || turn.error.status >= 500,
  });
}

/** Scripted `ModelClient` test double. `calls` counts model invocations (including retries). */
export function createMockModelClient(
  options: MockModelClientOptions,
): ModelClient & { readonly calls: () => number } {
  let n = 0;
  const next = (): MockModelTurn => {
    const turn = options.turns[Math.min(n, options.turns.length - 1)];
    n++;
    if (turn === undefined) throw new Error('mock model has no turns');
    return turn;
  };
  const model = new MockLanguageModelV4({
    provider: options.provider ?? 'mock',
    modelId: options.modelId ?? 'mock-model',
    doGenerate: async (call): Promise<LanguageModelV4GenerateResult> => {
      const turn = next();
      await wait(turn.delayMs, call.abortSignal);
      failIfScripted(turn);
      return {
        content: [
          ...(turn.text === undefined ? [] : [{ type: 'text' as const, text: turn.text }]),
          ...(turn.toolCalls ?? []).map((c) => ({
            type: 'tool-call' as const,
            toolCallId: c.id,
            toolName: c.name,
            input: JSON.stringify(c.input),
          })),
        ],
        finishReason: finishOf(turn),
        usage: usageOf(turn),
        warnings: [],
        response: { modelId: turn.servedModelId ?? options.modelId ?? 'mock-model' },
      };
    },
    doStream: async (call) => {
      const turn = next();
      await wait(turn.delayMs, call.abortSignal);
      failIfScripted(turn);
      const parts: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        {
          type: 'response-metadata',
          modelId: turn.servedModelId ?? options.modelId ?? 'mock-model',
        },
      ];
      if (turn.text !== undefined) {
        parts.push({ type: 'text-start', id: 't0' });
        for (const piece of turn.text.match(/.{1,4}/gs) ?? [])
          parts.push({ type: 'text-delta', id: 't0', delta: piece });
        parts.push({ type: 'text-end', id: 't0' });
      }
      for (const c of turn.toolCalls ?? []) {
        parts.push({
          type: 'tool-call',
          toolCallId: c.id,
          toolName: c.name,
          input: JSON.stringify(c.input),
        });
      }
      parts.push({
        type: 'finish',
        usage: usageOf(turn),
        finishReason: finishOf(turn),
      });
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
  const client = new AiSdkModelClient({
    provider: options.provider ?? 'mock',
    modelId: options.modelId ?? 'mock-model',
    adapter: 'mock-test-double',
    model,
    retry: { sleep: () => Promise.resolve(), ...options.retry },
  });
  return Object.assign(client, { calls: () => n });
}
