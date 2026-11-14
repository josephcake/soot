/**
 * @soot/provider-adapters
 *
 * Milestone 2: soot's provider abstraction (`ModelClient`) over the Vercel AI SDK, in-process
 * (ADR-019). Adapters: Anthropic (native Messages API), OpenAI (Chat Completions), and generic
 * OpenAI-compatible endpoints (Ollama, LM Studio, ...). Retries, rate-limit handling, error
 * sanitizing, discovery, and fallback. Verified with mocked HTTP only: no real provider call
 * has been made (M2-07 is blocked on user-supplied keys).
 */

export const PACKAGE_NAME = '@soot/provider-adapters';

/** `partial`: the Milestone 2 mockable scope is implemented; real-key verification is pending. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 2;

export type {
  ChatMessage,
  FinishReason,
  GenerateRequest,
  GenerateResponse,
  ModelClient,
  StreamEvent,
  ToolCall,
  ToolSpec,
  Usage,
} from './types.js';
export { ProviderError, redact, toProviderError, type ProviderErrorKind } from './errors.js';
export {
  DEFAULT_RETRY_POLICY,
  retryDelayMs,
  sleep,
  withRetries,
  type RetryPolicy,
} from './retry.js';
export {
  AiSdkModelClient,
  hiddenReasoningTokens,
  type AiSdkModelClientOptions,
} from './ai-sdk-client.js';
export { createModelClient, readApiKey, type CreateClientOptions } from './adapters.js';
export { discoverModelIds } from './discovery.js';
export {
  AllCandidatesFailedError,
  generateWithFallback,
  type FallbackAttempt,
  type FallbackResult,
} from './fallback.js';
export {
  createMockModelClient,
  type MockModelClientOptions,
  type MockModelTurn,
} from './mock-provider.js';
