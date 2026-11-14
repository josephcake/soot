/**
 * OpenRouter fetch wrapper (ADR-049). Built on the existing OpenAI-compatible client;
 * this module only (a) injects optional routing preferences, (b) adds attribution
 * headers when configured, and (c) rewrites HTTP-200 `{error}` bodies to the real
 * status so soot's `kindForStatus` can classify them.
 */
import type { ProviderConfig } from '@soot/model-registry';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const ROUTING_TO_SNAKE = {
  order: 'order',
  only: 'only',
  ignore: 'ignore',
  allowFallbacks: 'allow_fallbacks',
  requireParameters: 'require_parameters',
  dataCollection: 'data_collection',
  zdr: 'zdr',
  sort: 'sort',
} as const;

function routingObject(routing: NonNullable<ProviderConfig['routing']>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [camel, snake] of Object.entries(ROUTING_TO_SNAKE)) {
    const value = routing[camel as keyof typeof routing];
    if (value !== undefined) out[snake] = value;
  }
  return out;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input);
}

function isChatCompletions(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return path.endsWith('/chat/completions') || path.endsWith('/chat/completions/');
  } catch {
    return /\/chat\/completions\/?$/.test(url);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * When OpenRouter accepts a request and the upstream then fails, it may reply
 * with HTTP 200 and an `error` body (no `choices`). Rewrite that to the error's
 * status so existing error mapping applies. Odd or missing codes become 502.
 * A normal body that happens to have `error: null` is left alone.
 */
export async function normalizeOpenRouterResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return response;
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  if (isRecord(parsed) && isRecord(parsed.error) && !('choices' in parsed)) {
    const code = parsed.error.code;
    const status =
      typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502;
    return new Response(JSON.stringify({ error: parsed.error }), {
      status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Wrap `fetch` with OpenRouter routing, optional attribution, and 200-error normalisation. */
export function openRouterFetch(provider: ProviderConfig, inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = requestUrl(input);
    let next = init;
    if (provider.attribution !== undefined) {
      const headers = new Headers(init?.headers);
      if (provider.attribution.referer !== undefined)
        headers.set('HTTP-Referer', provider.attribution.referer);
      if (provider.attribution.title !== undefined)
        headers.set('X-OpenRouter-Title', provider.attribution.title);
      next = { ...init, headers };
    }
    const routing = provider.routing === undefined ? undefined : routingObject(provider.routing);
    if (routing !== undefined && Object.keys(routing).length > 0 && isChatCompletions(url)) {
      const raw = typeof next?.body === 'string' ? next.body : '';
      if (raw !== '') {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (isRecord(parsed)) {
            next = { ...next, body: JSON.stringify({ ...parsed, provider: routing }) };
          }
        } catch {
          // Body is not JSON; send it unchanged.
        }
      }
    }
    return Promise.resolve(inner(input, next)).then(normalizeOpenRouterResponse);
  };
}
