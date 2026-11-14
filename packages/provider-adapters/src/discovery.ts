import { isCallable, type ProviderConfig } from '@soot/model-registry';
import { ProviderError, kindForStatus, toProviderError } from './errors.js';
import { readApiKey, type CreateClientOptions } from './adapters.js';
import { OPENROUTER_BASE_URL } from './openrouter.js';

const DEFAULT_BASE: Readonly<Partial<Record<ProviderConfig['kind'], string>>> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: OPENROUTER_BASE_URL,
};

/** Cap on Gemini `pageToken` pagination; the list format is not live-verified (ADR-049). */
const MAX_GOOGLE_PAGES = 20;

function missingKey(provider: ProviderConfig): ProviderError {
  return new ProviderError({
    kind: 'auth',
    provider: provider.id,
    message: `${provider.apiKeyEnv ?? 'API key'} is not set`,
  });
}

function isGenerateContent(methods: unknown): boolean {
  return Array.isArray(methods) && methods.includes('generateContent');
}

function googleModelId(name: unknown): string | null {
  if (typeof name !== 'string' || name === '') return null;
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

/**
 * List the model ids a provider currently offers (M2-05), via its `GET /models` endpoint.
 * Only ids are used: provider listings carry no prices, and other metadata is not trusted
 * without review (research §4). Feed the result to `ModelRegistry.applyDiscovery`.
 * Discovery is library-only and never runs automatically (ADR-049).
 */
export async function discoverModelIds(
  provider: ProviderConfig,
  options: CreateClientOptions & { readonly signal?: AbortSignal } = {},
): Promise<string[]> {
  if (!isCallable(provider)) {
    throw new ProviderError({
      kind: 'refused',
      provider: provider.id,
      message: 'provider is not callable',
    });
  }
  const key = readApiKey(provider, options.env ?? process.env);
  const secrets = key === undefined ? [] : [key];
  const base = (provider.baseURL ?? DEFAULT_BASE[provider.kind] ?? '').replace(/\/$/, '');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (provider.kind === 'anthropic') {
    if (key === undefined) throw missingKey(provider);
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.kind === 'google') {
    if (key === undefined) throw missingKey(provider);
    headers['x-goog-api-key'] = key;
  } else if (key !== undefined) {
    headers.authorization = `Bearer ${key}`;
  } else if (provider.kind === 'openai' || provider.kind === 'openrouter') {
    throw missingKey(provider);
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const ids: string[] = [];
  let url: string | null = `${base}/models${provider.kind === 'anthropic' ? '?limit=1000' : ''}`;
  let pages = 0;
  try {
    while (url !== null) {
      pages += 1;
      const response: Response = await fetchImpl(url, {
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) {
        const status = response.status;
        throw new ProviderError({
          kind: kindForStatus(status),
          provider: provider.id,
          status,
          message: `model listing failed with HTTP ${status}`,
        });
      }
      const body = (await response.json()) as {
        data?: { id?: unknown }[];
        models?: { name?: unknown; supportedGenerationMethods?: unknown }[];
        has_more?: boolean;
        last_id?: string;
        nextPageToken?: unknown;
      };
      if (provider.kind === 'google') {
        for (const entry of body.models ?? []) {
          if (!isGenerateContent(entry.supportedGenerationMethods)) continue;
          const id = googleModelId(entry.name);
          if (id !== null) ids.push(id);
        }
        const token = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
        url =
          token !== '' && pages < MAX_GOOGLE_PAGES
            ? `${base}/models?pageToken=${encodeURIComponent(token)}`
            : null;
      } else {
        for (const entry of body.data ?? []) if (typeof entry.id === 'string') ids.push(entry.id);
        url =
          provider.kind === 'anthropic' &&
          body.has_more === true &&
          typeof body.last_id === 'string'
            ? `${base}/models?limit=1000&after_id=${encodeURIComponent(body.last_id)}`
            : null;
      }
    }
  } catch (error) {
    throw toProviderError(error, provider.id, secrets);
  }
  return ids;
}
