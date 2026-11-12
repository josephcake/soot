import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import {
  isCallable,
  providerRestriction,
  type ModelEntry,
  type ProviderConfig,
} from '@soot/model-registry';
import { AiSdkModelClient } from './ai-sdk-client.js';
import { ProviderError } from './errors.js';
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

function refuse(provider: ProviderConfig, message: string): ProviderError {
  return new ProviderError({ kind: 'refused', provider: provider.id, message });
}

/** Build a `ModelClient` for a registry model. Throws `ProviderError` (`refused`/`auth`). */
export function createModelClient(
  provider: ProviderConfig,
  model: ModelEntry,
  options: CreateClientOptions = {},
): ModelClient {
  if (model.provider !== provider.id)
    throw new Error(`model ${model.ref} does not belong to provider ${provider.id}`);
  const restriction = providerRestriction(provider);
  if (restriction !== null) {
    throw refuse(
      provider,
      `provider is restricted (${restriction}); soot will not send requests to it (ADR-016)`,
    );
  }
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
  const fetchOption = options.fetch === undefined ? {} : { fetch: options.fetch };
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
      languageModel = createOpenAICompatible({
        name: provider.id,
        baseURL: provider.baseURL ?? '',
        ...(apiKey === undefined ? {} : { apiKey }),
        includeUsage: true,
        supportsStructuredOutputs: model.capabilities.structuredOutput === true,
        ...fetchOption,
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
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    secrets: apiKey === undefined ? [] : [apiKey],
  });
}
