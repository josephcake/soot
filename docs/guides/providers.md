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

## DeepSeek (optional)

The data-residency hold on DeepSeek (ADR-016) was lifted on 2026-11-12 (ADR-035). DeepSeek is
not a shipped default: soot names no vendor in its default config. If you want it, add it to
your registry as an OpenAI-compatible provider and put your own key in `DEEPSEEK_API_KEY`:
