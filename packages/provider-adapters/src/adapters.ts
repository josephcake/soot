import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import {
  isCallable,
  structuredOutputMode,
  type ModelEntry,
  type ProviderConfig,
} from '@soot/model-registry';
import { AiSdkModelClient } from './ai-sdk-client.js';
import { ProviderError } from './errors.js';
import { OPENROUTER_BASE_URL, openRouterFetch } from './openrouter.js';
import type { RetryPolicy } from './retry.js';
import type { ModelClient } from './types.js';

/**
 * Credential boundary (M2-08). This module is the ONLY place soot reads provider keys: it
 * looks up `provider.apiKeyEnv` in `env` at client creation and hands the value straight to
 * the AI SDK provider factory. The key is not stored on the returned client (except, privately,
 * as a redaction pattern), is not part of any request or response type, and is scrubbed from
 * every error.
 */
export interface CreateClientOptions {
  /** Environment to read keys from. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Custom fetch (tests use it to mock HTTP). */
  readonly fetch?: typeof globalThis.fetch;
  readonly retry?: Partial<RetryPolicy>;
}

export function readApiKey(
  provider: ProviderConfig,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (provider.apiKeyEnv === undefined) return undefined;
  const value = env[provider.apiKeyEnv]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * True when the provider's key variable is set to a non-empty value (ADR-043). Presence only:
 * the value is read here, inside the credential boundary, and never returned.
 */
export function hasApiKey(
  provider: ProviderConfig,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return readApiKey(provider, env) !== undefined;
}

/**
 * Reserved opt-in keys (ADR-049). Setting one does nothing until a provider of
 * that kind is declared in the models file. `soot config` uses this to hint
 * that a key is set but unused. Presence only; the value is never returned.
 */
const OPT_IN_KEYS = [
  { apiKeyEnv: 'GEMINI_API_KEY', kind: 'google' },
  { apiKeyEnv: 'OPENROUTER_API_KEY', kind: 'openrouter' },
] as const;

export function unusedOptInKeyHints(
  providers: readonly Pick<ProviderConfig, 'apiKeyEnv'>[],
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const used = new Set(providers.flatMap((p) => (p.apiKeyEnv === undefined ? [] : [p.apiKeyEnv])));
  const hints: string[] = [];
  for (const { apiKeyEnv, kind } of OPT_IN_KEYS) {
    if (readApiKey({ apiKeyEnv } as ProviderConfig, env) === undefined) continue;
    if (used.has(apiKeyEnv)) continue;
    hints.push(
      `$${apiKeyEnv} is set but unused; add a \`${kind}\` provider to your models file (opt-in)`,
    );
  }
  return hints;
}

function refuse(provider: ProviderConfig, message: string): ProviderError {
  return new ProviderError({ kind: 'refused', provider: provider.id, message });
}

/**
 * When the registry asks for JSON-object mode, rewrite Chat Completions `response_format`
 * to `{ type: "json_object" }`. The schema is still applied by soot after the JSON is parsed.
 * Vendor-neutral: no provider-id checks.
 */
export function forceJsonObjectResponseFormat(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    let next = init;
    const raw = init?.body;
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          'response_format' in parsed &&
          (parsed as { response_format?: unknown }).response_format !== undefined
        ) {
          next = {
            ...init,
            body: JSON.stringify({ ...parsed, response_format: { type: 'json_object' } }),
          };
        }
      } catch {
        // Body is not JSON; send it unchanged.
      }
    }
    return fetchImpl(input, next);
  };
}

/** Build a `ModelClient` for a registry model. Throws `ProviderError` (`refused`/`auth`). */
export function createModelClient(
  provider: ProviderConfig,
  model: ModelEntry,
  options: CreateClientOptions = {},
): ModelClient {
  if (model.provider !== provider.id)
    throw new Error(`model ${model.ref} does not belong to provider ${provider.id}`);
  if (!isCallable(provider)) throw refuse(provider, 'provider is listed-only; soot never calls it');

  const env = options.env ?? process.env;
  const apiKey = readApiKey(provider, env);
  const missingKey = () =>
    new ProviderError({
      kind: 'auth',
      provider: provider.id,
      message:
        provider.apiKeyEnv === undefined
          ? 'no apiKeyEnv configured for this provider'
          : `${provider.apiKeyEnv} is not set (bring your own key)`,
    });
  const mode = structuredOutputMode(provider, model);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const fetch = mode === 'json_object' ? forceJsonObjectResponseFormat(fetchImpl) : fetchImpl;
  const fetchOption = { fetch };
  const baseURL = provider.baseURL === undefined ? {} : { baseURL: provider.baseURL };

  let languageModel: LanguageModelV4;
  switch (provider.kind) {
    case 'anthropic':
      if (apiKey === undefined) throw missingKey();
      languageModel = createAnthropic({ apiKey, ...baseURL, ...fetchOption })(model.modelId);
      break;
    case 'openai':
      if (apiKey === undefined) throw missingKey();
      // Chat Completions API: one wire format shared with OpenAI-compatible endpoints.
      languageModel = createOpenAI({ apiKey, ...baseURL, ...fetchOption }).chat(model.modelId);
      break;
    case 'openai-compatible':
      // Keyless endpoints (local runtimes) omit apiKeyEnv; a named but unset key is an error,
      // not an unauthenticated request.
      if (provider.apiKeyEnv !== undefined && apiKey === undefined) throw missingKey();
      languageModel = createOpenAICompatible({
        name: provider.id,
        baseURL: provider.baseURL ?? '',
        ...(apiKey === undefined ? {} : { apiKey }),
        includeUsage: true,
        // json_object mode: the AI SDK then sends response_format json_object; the fetch
        // wrapper also forces that type, so the wire body is explicit either way.
        supportsStructuredOutputs:
          mode === 'json_schema' && model.capabilities.structuredOutput === true,
        ...fetchOption,
      })(model.modelId);
      break;
    case 'google':
      // Always pass apiKey explicitly: @ai-sdk/google otherwise reads
      // GOOGLE_GENERATIVE_AI_API_KEY from the process environment (ADR-022, ADR-049).
      if (apiKey === undefined) throw missingKey();
      languageModel = createGoogle({ apiKey, ...baseURL, ...fetchOption })(model.modelId);
      break;
    case 'openrouter':
      if (apiKey === undefined) throw missingKey();
      languageModel = createOpenAICompatible({
        name: provider.id,
        baseURL: provider.baseURL ?? OPENROUTER_BASE_URL,
        apiKey,
        includeUsage: true,
        supportsStructuredOutputs: mode !== 'json_object',
        fetch: openRouterFetch(provider, fetch),
      })(model.modelId);
      break;
    case 'listed-only':
      throw refuse(provider, 'provider is listed-only; soot never calls it');
  }

  return new AiSdkModelClient({
    provider: provider.id,
    modelId: model.modelId,
    adapter: `ai-sdk:${provider.kind}`,
    model: languageModel,
    defaultMaxOutputTokens: model.maxOutputTokens,
    structuredOutputMode: mode,
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    secrets: apiKey === undefined ? [] : [apiKey],
  });
}
