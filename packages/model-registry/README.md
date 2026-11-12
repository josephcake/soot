# @soot/model-registry

> **Status: partial (Milestone 2 scope implemented).** soot ships **no built-in model list**
> and no prices. Every model comes from your config. Routing by cost/quality is Milestone 3.

## Config

`loadRegistryConfigFile(path)` / `parseRegistryConfig(json)` validate a config like:

```json
{
  "version": 1,
  "providers": [
    { "id": "anthropic", "kind": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" },
    { "id": "openai", "kind": "openai", "apiKeyEnv": "OPENAI_API_KEY" },
    {
      "id": "ollama",
      "kind": "openai-compatible",
      "baseURL": "http://127.0.0.1:11434/v1",
      "local": true
    }
  ],
  "models": [
    {
      "provider": "anthropic",
      "modelId": "<model id from the provider>",
      "capabilities": { "tools": true, "structuredOutput": true },
      "contextWindow": 200000,
      "pricing": {
        "inputPerMTokUsd": 0,
        "outputPerMTokUsd": 0,
        "source": "<URL of the provider's price page>",
        "asOf": "2026-11-12"
      }
    }
  ]
}
```

- Provider kinds: `anthropic`, `openai`, `openai-compatible` (Ollama, LM Studio, an optional
  LiteLLM proxy, any compatible endpoint), `listed-only` (metadata only, never called).
- Credentials are never in config: `apiKeyEnv` is the **name** of an environment variable, and
  objects are strict, so an `apiKey` field is rejected.
- Missing metadata (capabilities, context window, max output, pricing) is `null` = unknown.
  Unknown never satisfies a requirement and never prices as zero.
- Every price needs `source` and `asOf`. Time-of-day and long-context tiers are not modeled yet.

## Registry

- `new ModelRegistry(config).select(requirements, health)` returns eligible models in config
  order plus the reasons every other model was excluded. Requirements: capabilities, minimum
  context window, providers, local only.
- `applyDiscovery(provider, ids)` overlays a provider's model list: configured models it does
  not list are excluded; listed models that are not configured are added as unselectable with
  unknown metadata.
- `ProviderHealth` tracks unavailable providers with cooldowns (outage, rate limit, timeout,
  auth). Selection skips them.
- `estimateCost` (planned tokens) and `actualCostFromUsage` (reported usage) return
  `EstimatedUsd` / `ActualUsd` from `@soot/observability` with the price's provenance.

## DeepSeek (ADR-016)

Providers with id `deepseek*` or a `deepseek.com` base URL are restricted
(`data-residency-review`): listed, never selected, never callable, until Joseph reviews data
residency.
