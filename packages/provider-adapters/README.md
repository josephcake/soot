# @soot/provider-adapters

> **Status: partial (Milestone 2).** Verified with mocked HTTP and a scripted test double. The
> `openai-compatible` adapter has been called live with the user's keys against DeepSeek
> (`deepseek-flash`) and xAI (`grok-4.7`) on 2026-11-13 (`soot run --agent api`, ADR-039).
> The `anthropic` and `openai` adapters have not been called live.

soot's provider abstraction. Callers use one interface, `ModelClient`, whatever the provider.
Adapters wrap the [Vercel AI SDK](https://ai-sdk.dev) in-process (ADR-019, ADR-022).

| Adapter (`kind`)    | Wire API                                                    | Key variable (BYOK)                               |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| `anthropic`         | Anthropic Messages (`@ai-sdk/anthropic`)                    | named by `apiKeyEnv`, e.g. `ANTHROPIC_API_KEY`    |
| `openai`            | OpenAI Chat Completions (`@ai-sdk/openai`)                  | named by `apiKeyEnv`, e.g. `OPENAI_API_KEY`       |
| `openai-compatible` | Chat Completions at your `baseURL` (Ollama, LM Studio, ...) | optional; if `apiKeyEnv` is named, it must be set |
| `google`            | Gemini `generateContent` (`@ai-sdk/google`)                 | named by `apiKeyEnv`, e.g. `GEMINI_API_KEY`       |
| `openrouter`        | OpenRouter (OpenAI-compatible + 200-error wrapper)          | named by `apiKeyEnv`, e.g. `OPENROUTER_API_KEY`   |
| `listed-only`       | never called                                                | none                                              |

Only `listed-only` providers are refused. DeepSeek has no special treatment since ADR-035
(which lifted the ADR-016 hold): configure it as `openai-compatible` with
`baseURL: "https://api.deepseek.com/v1"` and `apiKeyEnv: "DEEPSEEK_API_KEY"`. It is optional
and not a default. Live DeepSeek calls (planning and task work) were made on 2026-11-13.

Gemini and OpenRouter are opt-in (ADR-049): they are never added to the auto pool. Declare a
`google` or `openrouter` provider in your models file; setting the key alone does nothing.
The `google` factory is always given an explicit `apiKey` from `apiKeyEnv`, so the SDK cannot
silently read `GOOGLE_GENERATIVE_AI_API_KEY`. OpenRouter routing preferences and attribution
headers are optional; HTTP-200 `{error}` bodies are rewritten to the real status. HTTP 402
(credits exhausted) is classified as `auth` and falls back. Verified with mocked HTTP only.

## Interface

```ts
const client = createModelClient(provider, model); // from a @soot/model-registry entry
const r = await client.generate({
  system: 'You are terse.',
  messages: [{ role: 'user', content: 'Plan this change.' }],
  tools: [{ name: 'read_file', description: '...', inputSchema: { type: 'object' } }],
  output: { schema: z.object({ steps: z.array(z.string()) }) }, // validated on receipt
  timeoutMs: 60_000,
});
r.text;
r.toolCalls;
r.output;
r.usage;
r.finishReason;
r.servedModelId;
r.attempts;

for await (const event of client.stream({ messages })) {
  /* text-delta | tool-call | finish */
}
```

- **Errors** are `ProviderError` with a `kind` (`rate-limited`, `unavailable`, `timeout`, `auth`,
  `invalid-request`, `invalid-output`, `aborted`, `refused`, `unknown`), the HTTP status, and
  `retryAfterMs`. They carry no raw cause, headers, or body, and the key is scrubbed.
- **Retries** belong to soot, not the SDK (`maxRetries: 0`). They are bounded (3 attempts by
  default), honour `retry-after`/`retry-after-ms`, and otherwise back off exponentially with
  jitter. Anthropic 429s often have no `retry-after`. Streams are retried only before the
  first event.
- **Structured output** is validated against your zod schema. A provider that silently
  ignores the schema produces `invalid-output`, not bad data.
- **Fallback**: `generateWithFallback(clients, request, health)` marks providers that are in
  outage, rate-limited, timing out, or failing auth as unavailable in `ProviderHealth`
  (`@soot/model-registry`) and tries the next candidate. Request-level errors do not fall back.
- **Discovery**: `discoverModelIds(provider)` lists `GET /models`. Feed it to
  `registry.applyDiscovery`. New ids are unselectable and their metadata is unknown.
- **Usage, not dollars**: providers report tokens. Turn them into cost with `@soot/model-registry`
  pricing (sourced and dated).

## Credentials (M2-08)

Keys are read in one place: `createModelClient` / `discoverModelIds` look up
`env[provider.apiKeyEnv]`. The key goes to the AI SDK provider factory and is used only as an
auth header. It is never part of a request, response, task, log line, warning, or error.
`tests/credential-boundary.test.ts` and `src/credentials.test.ts` assert this.

## Tests

- `contract.test.ts` runs one behavioural contract against the mock test double and against
  each adapter over a scripted fake `fetch`.
- `credentials.test.ts` covers credential isolation.
- `fallback.test.ts` covers outage, fallback, discovery, the listed-only refusal, and a
  configured DeepSeek endpoint being callable (against a fake `fetch`).
- `local-endpoint.test.ts` talks to a real Ollama/LM Studio on localhost only if one is
  running; otherwise it is **skipped**.
