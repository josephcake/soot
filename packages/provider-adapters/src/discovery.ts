import { isCallable, type ProviderConfig } from '@soot/model-registry';
import { ProviderError, toProviderError } from './errors.js';
import { readApiKey, type CreateClientOptions } from './adapters.js';

const DEFAULT_BASE: Readonly<Record<'anthropic' | 'openai', string>> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
};

/**
 * List the model ids a provider currently offers (M2-05), via its `GET /models` endpoint.
 * Only ids are used: provider listings carry no prices, and other metadata is not trusted
 * without review (research §4). Feed the result to `ModelRegistry.applyDiscovery`.
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
  const defaultBase =
    provider.kind === 'anthropic' || provider.kind === 'openai' ? DEFAULT_BASE[provider.kind] : '';
  const base = (provider.baseURL ?? defaultBase).replace(/\/$/, '');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (provider.kind === 'anthropic') {
    if (key === undefined)
      throw new ProviderError({
        kind: 'auth',
        provider: provider.id,
        message: `${provider.apiKeyEnv ?? 'API key'} is not set`,
      });
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (key !== undefined) {
    headers.authorization = `Bearer ${key}`;
  } else if (provider.kind === 'openai') {
    throw new ProviderError({
      kind: 'auth',
      provider: provider.id,
      message: `${provider.apiKeyEnv ?? 'API key'} is not set`,
    });
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const ids: string[] = [];
  let url: string | null = `${base}/models${provider.kind === 'anthropic' ? '?limit=1000' : ''}`;
  try {
    while (url !== null) {
      const response: Response = await fetchImpl(url, {
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) {
        const status = response.status;
        const kind =
          status === 429
            ? 'rate-limited'
            : status === 401 || status === 403
              ? 'auth'
              : status >= 500
                ? 'unavailable'
                : 'invalid-request';
        throw new ProviderError({
          kind,
          provider: provider.id,
          status,
          message: `model listing failed with HTTP ${status}`,
        });
      }
      const body = (await response.json()) as {
        data?: { id?: unknown }[];
        has_more?: boolean;
        last_id?: string;
      };
      for (const entry of body.data ?? []) if (typeof entry.id === 'string') ids.push(entry.id);
      url =
        provider.kind === 'anthropic' && body.has_more === true && typeof body.last_id === 'string'
          ? `${base}/models?limit=1000&after_id=${encodeURIComponent(body.last_id)}`
          : null;
    }
  } catch (error) {
    throw toProviderError(error, provider.id, secrets);
  }
  return ids;
}
