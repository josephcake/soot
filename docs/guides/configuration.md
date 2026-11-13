# Configuration

Configuration is read from environment variables. `.env.example` lists every variable. A local
`.env` is git-ignored and must never be committed; soot does not read it, so load it into your
shell yourself (for example `set -a; . ./.env; set +a`).

> Nothing loads `.env` automatically. Variables are read only by `parseEnv(process.env)` from
> `@soot/core`. The `soot` CLI and `soot mcp` use it for the state directory (override with
> `--data-dir`) and the log level (ADR-030). Export the variables in your shell.

## Orchestrator variables (read today by `parseEnv`)

| Variable         | Default   | Values                                                        | Purpose                                                                                               |
| ---------------- | --------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SOOT_LOG_LEVEL` | `info`    | `silent`, `error`, `warn`, `info`, `debug` (case-insensitive) | Log lines on stderr (see below). Invalid values fail the command with `SOOT_LOG_LEVEL: expected …`.   |
| `SOOT_DATA_DIR`  | `~/.soot` | absolute or relative path (relative resolves against cwd)     | Local-first state: `soot.sqlite` (execution state, M1); `worktrees/<run>/`, `audit/<run>.jsonl` (M5). |

Empty values are treated as unset.

Log levels: `info` prints progress (task assignments, escalations, provider cooldowns carried
over from earlier runs); `warn` only warnings (for example "ACP model NOT applied", a task that
could not be cancelled); `error` only errors; `silent` nothing; `debug` adds the state directory
and where it came from, the config and models files, the effective attempt timeout and the audit
log path. Log lines go to stderr. Command results (stdout, and the final error message) are
always printed. `--json` turns log lines off so the output stays machine-readable. `soot mcp`
logs to stderr only; stdout carries the MCP protocol.

The state directory is created with mode `0700` if missing. `soot.sqlite` holds runs (the
exact original prompt, the task graph) and per-task attempts with their validated structured
results. It never holds credentials or agent transcripts.

## Provider credentials (bring your own keys)

A model config names the variable that holds each provider's key (`apiKeyEnv`, see below);
it never contains the key itself, and the config validator rejects anything that is not an
environment-variable name. Conventional names, reserved in `.env.example` with empty values:

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (the Milestone 2 adapters), `DEEPSEEK_API_KEY` (used
through the `openai-compatible` adapter when you configure a DeepSeek provider, ADR-035), and
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY` (reserved, no adapter yet).

Rules (ADR-022, M2-08):

- Keys stay on the user's machine and are read only by `@soot/provider-adapters`
  (`createModelClient`, `discoverModelIds`) when a client is created. They are sent only as
  the provider's auth header.
- They are never placed in task context, results, logs, warnings, errors, or messages between
  agents. Errors are sanitized and any echoed key is replaced with `[redacted]`.
- Tests never require real keys and never call real providers. `tests/credential-boundary.test.ts`
  fails if production code outside the adapter layer reads a key variable.

## Model registry config

soot has no built-in model list. You describe providers and models in JSON and load it with
`loadRegistryConfigFile(path)` (`@soot/model-registry`). A model you leave without `pricing`
gets soot's sourced catalog price when one exists for that vendor API and model id (see
[Prices](#prices)):

```json
{
  "version": 1,
  "providers": [
    { "id": "anthropic", "kind": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" },
    {
      "id": "ollama",
      "kind": "openai-compatible",
      "baseURL": "http://localhost:11434/v1",
      "local": true
    }
  ],
  "models": [
    {
      "provider": "anthropic",
      "modelId": "<model id from the provider>",
      "contextWindow": 200000,
      "capabilities": { "tools": true, "structuredOutput": true },
      "structuredOutputMode": "json_schema",
      "pricing": {
        "inputPerMTokUsd": 3,
        "outputPerMTokUsd": 15,
        "source": "<pricing page URL>",
        "asOf": "2026-11-12"
      },
      "reliability": { "low": 0.9, "medium": 0.8, "high": 0.6, "source": "<your evaluation>" }
    }
  ]
}
```

Anything you leave out is **unknown** (`null`), never guessed. Prices must carry a `source`
and an `asOf` date. A price can add a `longContext` tier
(`{ "aboveInputTokens": 272000, "inputPerMTokUsd": ..., "outputPerMTokUsd": ..., "cacheReadPerMTokUsd": ... }`):
a request with more input tokens than that is billed at those rates for every token. `structuredOutputMode` is `"json_schema"` (strict structured outputs) or
`"json_object"` (`response_format: { "type": "json_object" }`, with the JSON parsed and
validated against the schema afterwards). You can set it on a model or, as a default, on the
provider; the model wins if both are set. Omitted, it is `"json_schema"` (ADR-036). `reliability` is your prior estimate (0–1) that the model completes a task
of each complexity. It needs a `source`. The router (`@soot/model-router`) blends it with
recorded success history. A model with no prior and too little history has unknown reliability,
and the built-in policies do not select it. Cost estimates and provider-reported actuals stay separate types.

### Prices

Costs are reported tokens × list price, per task attempt and for the planning call. Where a
price comes from, in order:

1. `pricing` on the model in your models file (always wins; use it for proxies, resellers,
   contracts and local runtimes).
2. soot's **price catalog** (`PRICE_CATALOG` in `@soot/model-registry`, ADR-037): official list
   prices for popular models on the vendor's own API, each with its pricing-page URL and the
   date it was checked. It matches on the provider's API host and the exact model id, and
   never adds a model or a default.
3. Otherwise the model is unpriced. Its costs show as "price not set", and `soot run`,
   `soot config` and `soot models` print a warning that points to the
   [update-model-pricing prompt](../../skills/update-model-pricing/SKILL.md). Run that prompt
   with your AI agent whenever you add a provider or key, or start using a new model id.

`soot models` shows each price and whether it came from your config or the catalog;
`soot config --json` lists `pricing.catalogPriced` and `pricing.unpriced`. soot never fetches
prices over the network.

`tests/repo-structure.test.ts` fails if `.env.example` ever contains a value for a
`*KEY*`, `*TOKEN*`, `*SECRET*`, or `*PASSWORD*` variable, and if any `SOOT_*` variable in
`.env.example` is missing from this document.

## Project config (`soot.config.json`)

The `soot` CLI reads `soot.config.json` from the repository root (or `--config <file>`). Commit
it with the project: it is the only source of the commands soot runs, and soot protects it from
task edits. Unknown keys are rejected.

```json
{
  "version": 1,
  "models": "models.json",
  "policy": "balanced",
  "allowedExecutables": ["node"],
  "checks": [
    { "name": "test", "kind": "test", "argv": ["node", "--test", "tests/**/*.test.js"] },
    { "name": "lint", "kind": "lint", "argv": ["node", "scripts/lint.mjs"] }
  ],
  "acceptance": {
    "update-page-title": [
      {
        "name": "acceptance:title",
        "kind": "acceptance",
        "argv": ["node", "--test", "acceptance/title.test.js"]
      }
    ]
  },
  "protectedPaths": ["acceptance/", "scripts/"]
}
```

| Key                  | Default    | Meaning                                                                                                                  |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `models`             | (required) | Model registry file (above), relative to the config file.                                                                |
| `policy`             | `balanced` | `economy`, `balanced` or `quality` ([routing](model-routing.md)).                                                        |
| `checks`             | `[]`       | Project checks run on every task that changes files, and on the merged result.                                           |
| `acceptance`         | `{}`       | Extra commands per task id; also run for read-only tasks (their only way to be verified).                                |
| `protectedPaths`     | `[]`       | Paths no task may change, even inside its lease. The config, registry, fixtures and mock script are added automatically. |
| `allowedExecutables` | `[]`       | Exact `argv[0]` values allowed to run. Destructive programs are refused regardless.                                      |
| `concurrency`        | `4`        | Tasks running at once (1–16).                                                                                            |
| `attemptTimeoutMs`   | `1800000`  | Abort an attempt after this many ms (default 30 minutes, `DEFAULT_ATTEMPT_TIMEOUT_MS`); a hung runner ends as `timeout`. |
| `escalation`         | defaults   | Escalation limits and budgets (`@soot/escalation`, e.g. `{ "sameModelRetries": 0 }`).                                    |
| `fixtures`           | none       | JSON array of extra recorded decompositions `{ id, prompt, tasks }`.                                                     |
| `acpAgent`           | none       | ACP agent for `--agent acp`: `command`, `args`, `passEnv` (variable names; credential-like names are rejected).          |
| `decomposer`         | none       | `{ "model": "<provider/modelId>" }`: a model from your registry for prompts with no fixture (see below; mocks only).     |

Check entries: `name`, `kind` (`test`, `typecheck`, `lint`, `acceptance`), `argv`, optional
`timeoutMs` and `required` (default `true`).

### Decomposer model (optional, ADR-034)

By default soot decomposes only **recorded** prompts (the build spec examples plus your
`fixtures`) and refuses the rest. To let a model decompose other prompts, name one of the
models in your registry file:

```json
{ "version": 1, "models": "models.json", "decomposer": { "model": "anthropic/<model-id>" } }
```

- `model` is a reference `provider/modelId` exactly as `soot models` lists it. soot ships no
  default and names no vendor; the field is strict, and a key in it is rejected.
- Recorded prompts still come from fixtures, with **no model call**. Only prompts no fixture
  matches go to the model, and its answer is validated like a fixture (ADR-033). A model
  failure or an invalid answer fails the run with the reason; soot never guesses a plan or
  picks a similar fixture.
- The key is read only from the variable the provider's `apiKeyEnv` names, in the environment
  soot was started with (no `.env` file is read). If the model is not in the registry, its
  provider is listed-only, it is configured without structured output, or the
  key variable is unset, the model is **not usable**: no client is built, nothing is sent,
  recorded prompts still work, and other prompts fail with a message that names the setting
  and the reason.
- `soot config` (and `--json`, field `decomposer`) shows the setting and whether it is usable,
  without printing any key. Checking builds a client but makes no request.
- Only decomposition uses this model. Execution still needs `--agent mock` or `--agent acp`,
  and routing is unchanged. Decomposition tokens are recorded in the run report
  (`decomposition.usage`) but are not yet counted in the cost report or run budget.
- **Status:** implemented and verified with mock model clients only. No real model has
  decomposed a prompt (M2-07 is blocked on user-supplied keys).

## CLI state files

Under the state directory: `soot.sqlite` (runs, attempts, model outcomes, provider cooldowns,
per-attempt spend), `reports/<run>.json` (the consolidated report and cost records),
`reports/<run>.events.jsonl` (live routing events), `audit/<run>.jsonl` (security-relevant
actions and every routing decision), `worktrees/<run>/` (removed after the run) and
`control/<run>.lock|.stop|.stop-task.<id>` (used by `soot stop`).

### Attempt timeout

Every attempt has a timeout. When `attemptTimeoutMs` is not set, it is
`DEFAULT_ATTEMPT_TIMEOUT_MS` = 1,800,000 ms (30 minutes), so a runner that hangs and ignores
abort cannot block a run forever: the attempt ends as a `timeout` failure and the escalation
rules decide what happens next. An explicit `attemptTimeoutMs` always wins. `soot config` shows
the effective value. Separately, the ACP driver waits 2 s for an agent to stop after
`session/cancel` before it gives up on it (unchanged).

### What persists across restarts (ADR-030)

- **Provider cooldowns** (`provider_cooldowns`): a provider marked unavailable for an outage,
  rate limit or timeout stays skipped by later runs and restarted processes until its cooldown
  ends. Auth and "not configured" marks last for the process only, so fixing a key and running
  again is enough.
- **Run-budget spend** (`attempt_spend`): one row per attempt, the reported actual cost when the
  runner sent one, otherwise the routed estimate. A restarted run rebuilds its budget from these
  rows, including tasks that already finished. Nothing is filled in: an attempt without a price
  has no row.
