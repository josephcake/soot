/**
 * @soot/provider-adapters
 *
 * Milestone 2: soot's provider abstraction (`ModelClient`) over the Vercel AI SDK, in-process
 * (ADR-019). Adapters: Anthropic (native Messages API), OpenAI (Chat Completions), Gemini (`google`,
 * via `@ai-sdk/google`), OpenRouter (`openrouter`, OpenAI-compatible plus a fetch wrapper),
 * and generic OpenAI-compatible endpoints (Ollama, LM Studio, ...). Gemini and OpenRouter
 * are opt-in only (ADR-049). Retries, rate-limit handling, error sanitizing, discovery, and
 * fallback. Verified with mocked HTTP only: no real Gemini or OpenRouter call has been made
 * (M2-07 is blocked on user-supplied keys).
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
export {
  ProviderError,
  kindForStatus,
  redact,
  toProviderError,
  type ProviderErrorKind,
} from './errors.js';
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
export {
  createModelClient,
  hasApiKey,
  readApiKey,
  unusedOptInKeyHints,
  type CreateClientOptions,
} from './adapters.js';
export { discoverModelIds } from './discovery.js';
export { probeLocalRuntimes, type LocalProbeOptions } from './local-probe.js';
export { OPENROUTER_BASE_URL, normalizeOpenRouterResponse, openRouterFetch } from './openrouter.js';
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
