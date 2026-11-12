# Providers

> **Status:** adapters exist and are tested against **mocked HTTP only**. No real provider has
> been called, and the CLI does not use providers yet: `soot run` works only with the scripted
> mock agent. Real calls need your own keys (M2-07, blocked on BYOK).

## Supported provider kinds

| Kind                | Adapter                                                      | Verified                                                                     |
| ------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `anthropic`         | Anthropic Messages API via the Vercel AI SDK                 | mocked HTTP only                                                             |
| `openai`            | OpenAI API via the Vercel AI SDK                             | mocked HTTP only                                                             |
| `openai-compatible` | Any OpenAI-compatible endpoint (Ollama, LM Studio, gateways) | mocked HTTP only; a live local test is skipped unless a runtime is listening |

soot ships **no model list and no prices**. You describe providers and models in a registry
file (see [configuration](configuration.md#model-registry-config)); anything you leave out is
unknown, and unknown is never guessed.

## Keys

- Bring your own keys. A provider entry names the environment variable that holds its key
  (`apiKeyEnv`); the key itself never appears in config.
- Only `@soot/provider-adapters` reads key variables, when it creates a client. The CLI, the
  MCP server, reports, audit logs, task context and check commands never see them
  (`tests/credential-boundary.test.ts`, ADR-022, ADR-025).
- soot never offers a login and never stores credentials.

## Restricted providers

DeepSeek endpoints are refused by policy pending a data-residency review (ADR-016):
`soot models` lists such models as `excluded: restricted`, and routing never selects them.

## Local models

An `openai-compatible` provider with `"local": true` (for example Ollama on
`http://localhost:11434/v1`) is treated as local. Pricing for local models is whatever you
configure (usually zero, with a source such as "local runtime").

## Harnesses

soot can run tasks through any agent that speaks ACP (Agent Client Protocol), using one generic
driver (ADR-027, `--agent acp`, see [installation](installation.md#run-tasks-through-an-acp-agent)).
It has been tested only against soot's own mock ACP agent; no vendor harness has been run
through it, so no harness is listed as supported. soot will never bundle proprietary agent
SDKs, offer a login, bypass the harness's approvals, or present itself as the vendor's product.
