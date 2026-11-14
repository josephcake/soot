# Providers

> **Status:** adapters exist and are tested against **mocked HTTP only**. No real provider has
> been called, and the CLI does not use providers yet: `soot run` works only with the scripted
> mock agent. Real calls need your own keys (M2-07, blocked on BYOK).

## Supported provider kinds

| Kind                | Adapter                                                                      | Verified                                                                                         |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `anthropic`         | Anthropic Messages API (native, not OpenAI-compatible) via the Vercel AI SDK | fake HTTP server end to end (planner and `--agent api`); not yet called live                     |
| `openai`            | OpenAI Chat Completions via the Vercel AI SDK                                | fake HTTP server end to end (`--agent api`); not yet called live                                 |
| `openai-compatible` | Any OpenAI-compatible endpoint (DeepSeek, xAI, Ollama, LM Studio, gateways)  | live with DeepSeek and xAI (ADR-039); a live local test is skipped unless a runtime is listening |
| `google`            | Gemini API via `@ai-sdk/google` (native `generateContent`)                   | mocked HTTP only; not called live (ADR-049)                                                      |
| `openrouter`        | OpenRouter (`https://openrouter.ai/api/v1`) via the OpenAI-compatible client | mocked HTTP only; not called live (ADR-049)                                                      |

`anthropic` sends `POST /v1/messages` with `x-api-key` and `anthropic-version` headers, a
separate `system` field and `max_tokens`, and reads text content blocks and
`usage.input_tokens` / `usage.output_tokens`. `openai` and `openai-compatible` send Chat
Completions with a Bearer key. A provider whose `apiKeyEnv` is not set is never called.

**Reasoning tokens.** OpenAI counts reasoning inside `completion_tokens`. Some compatible
providers report it separately (xAI, checked live on 2026-11-13: `total_tokens` = prompt +
completion + reasoning). soot adds such reasoning tokens to the output count, because they are
billed as output; it decides from the numbers only, never from the provider id.

soot ships **no model list**. You describe providers and models in a registry file (see
[configuration](configuration.md#model-registry-config)); anything you leave out is unknown,
and unknown is never guessed. For prices, soot ships a sourced catalog of official list prices
for popular models on each vendor's own API (OpenAI, Anthropic, Google Gemini API, xAI,
DeepSeek, Mistral; ADR-037). It fills in `pricing` only for models you configured without one
(see [prices](configuration.md#prices)).

## Adding a provider, key, or model

When you add a provider or an API key, or start using a model id soot has not seen, have your
AI agent run the [update-model-pricing prompt](../../skills/update-model-pricing/SKILL.md). It
looks up the model's current price on the vendor's official pricing page and records it with
the source URL and date, or leaves it unpriced if there is no official price. soot reminds
you: `soot run`, `soot config` and `soot models` warn when a callable model has no price.

## Keys

- Bring your own keys. A provider entry names the environment variable that holds its key
  (`apiKeyEnv`); the key itself never appears in config.
- Only `@soot/provider-adapters` reads key variables, when it creates a client. The CLI, the
  MCP server, reports, audit logs, task context and check commands never see them
  (`tests/credential-boundary.test.ts`, ADR-022, ADR-025).
- soot never offers a login and never stores credentials.

## Gemini and OpenRouter (opt-in, ADR-049)

Neither vendor is auto-detected. Setting `GEMINI_API_KEY` or `OPENROUTER_API_KEY` alone does
nothing; you must declare a provider of that kind in your models file. `soot config` will note
that a reserved key is set but unused (it never prints the value).

```json
{
  "version": 1,
  "providers": [
    { "id": "gemini", "kind": "google", "apiKeyEnv": "GEMINI_API_KEY" },
    {
      "id": "openrouter",
      "kind": "openrouter",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "routing": { "dataCollection": "deny", "requireParameters": true, "allowFallbacks": true }
    }
  ],
  "models": [
    {
      "provider": "gemini",
      "modelId": "gemini-3.5-flash-lite",
      "contextWindow": 1048576,
      "maxOutputTokens": 65536,
      "tier": "low"
    },
    {
      "provider": "openrouter",
      "modelId": "anthropic/claude-sonnet-4.5",
      "contextWindow": 200000,
      "maxOutputTokens": 8192,
      "pricing": {
        "inputPerMTokUsd": 3,
        "outputPerMTokUsd": 15,
        "source": "https://openrouter.ai/anthropic/claude-sonnet-4.5",
        "asOf": "2026-11-14"
      }
    }
  ]
}
```

Context windows and the OpenRouter price above are examples: copy current figures from the
model card. Gemini list prices come from soot's catalog once the default host
`generativelanguage.googleapis.com` applies (a user-set `pricing` still wins). OpenRouter has
no catalog rows, because its price varies by the upstream that is routed to; set `pricing` or
costs will show as "price not set".

Recommended OpenRouter `routing`: `"dataCollection": "deny"`. soot does not force this, because
OpenRouter's own default is `"allow"`. Other routing fields (`order`, `only`, `ignore`,
`allowFallbacks`, `requireParameters`, `zdr`, `sort`) and optional `attribution` (`referer`,
`title`) are documented by OpenRouter; attribution headers are sent only when configured.

The same endpoints can also be configured as plain `openai-compatible` providers (the issue #9
minimum, and the only option if you do not want the dedicated kinds):

```json
{
  "version": 1,
  "providers": [
    {
      "id": "gemini-compat",
      "kind": "openai-compatible",
      "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/",
      "apiKeyEnv": "GEMINI_API_KEY"
    },
    {
      "id": "openrouter",
      "kind": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  ],
  "models": []
}
```

Gemini's OpenAI-compatible endpoint is marked **beta** by Google; the `google` kind is
preferred. The plain `openai-compatible` OpenRouter config does not rewrite HTTP-200 error
bodies or inject `routing` preferences; use kind `openrouter` for those.

HTTP 402 (credits exhausted) on any provider now falls back to another provider instead of
being retried as a crash.

These adapters have been verified with fake HTTP and fake keys only. No live Gemini or
OpenRouter call has been made.

## DeepSeek (optional)

The data-residency hold on DeepSeek (ADR-016) was lifted on 2026-11-12 (ADR-035). DeepSeek is
not a shipped default: soot names no vendor in its default config. If you want it, add it to
your registry as an OpenAI-compatible provider and put your own key in `DEEPSEEK_API_KEY`:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "deepseek",
      "kind": "openai-compatible",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  ],
  "models": [
    {
      "provider": "deepseek",
      "modelId": "deepseek-flash",
      "capabilities": { "tools": true, "structuredOutput": true },
      "structuredOutputMode": "json_object"
    }
  ]
}
```

Set `structuredOutputMode` to `"json_object"` when the endpoint accepts JSON mode
(`response_format: { "type": "json_object" }`) but not strict `json_schema` structured
outputs (ADR-036). soot still mentions JSON and the expected `{ "tasks": [...] }` shape in
the decomposer prompt, parses the JSON, and validates it against the task schema; there is
no partial graph. The mode is vendor-neutral and can also be set on a provider as a default.
The default, if you omit it, is `"json_schema"`.

It is then selected, routed and callable like any other provider, and can be named as the
decomposer model (`deepseek/deepseek-flash`). Its price comes from soot's catalog
(DeepSeek's peak rate; off-peak is half and is not modeled). Fill in context window and
reliability yourself; unknown stays unknown. soot's tests and demos never call DeepSeek or any other live
provider. Live calls (planning, and task work with `--agent api`) were made with the user's key
on 2026-11-13 (ADR-039).

## Listed-only providers

A provider with `kind: "listed-only"` is kept for metadata only: `soot models` lists its models
as `excluded: listed-only`, routing never selects them, and soot never sends it a request.

## Local models

An `openai-compatible` provider with `"local": true` (for example Ollama on
`http://localhost:11434/v1`) is treated as local. Pricing for local models is whatever you
configure (usually zero, with a source such as "local runtime").

## Harnesses

soot can run tasks through any agent that speaks ACP (Agent Client Protocol), using one generic
driver (ADR-027, `--agent acp`, see [installation](installation.md#run-tasks-through-an-acp-agent)).
It has been tested only against soot's own mock ACP agent; no vendor harness has been run
through it, so no harness is listed as supported. `--agent claude-code` and `--agent codex`
are runner profiles over the same driver for those harnesses' ACP adapters (ADR-047, see
[installation](installation.md#run-tasks-through-claude-code-or-codex-simulated-only-not-yet-run-for-real));
they are tested against simulated adapters only and still need a real recorded run. soot will never bundle proprietary agent
SDKs, offer a login, bypass the harness's approvals, or present itself as the vendor's product.
