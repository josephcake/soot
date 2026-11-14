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

Local model probing ([below](#keyless-local-models-adr-044)) reads two more variables, from the
environment soot starts in: `SOOT_LOCAL_MODELS` (`off`, `0` or `false` turns probing off) and
`SOOT_LOCAL_MODEL_URLS` (comma-separated OpenAI-compatible base URLs to probe instead of the
defaults).

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
`XAI_API_KEY` (xAI through the `openai-compatible` adapter), and `GEMINI_API_KEY`,
`OPENROUTER_API_KEY` (reserved; configure them as `openai-compatible` providers yourself).
The first four are also detected by name (presence only) and add that vendor's models
automatically ([auto models](#auto-models-from-your-keys-adr-043)).

Rules (ADR-022, M2-08):

- Keys stay on the user's machine and are read only by `@soot/provider-adapters`
  (`createModelClient`, `discoverModelIds`) when a client is created. They are sent only as
  the provider's auth header.
- They are never placed in task context, results, logs, warnings, errors, or messages between
  agents. Errors are sanitized and any echoed key is replaced with `[redacted]`.
- Tests never require real keys and never call real providers. `tests/credential-boundary.test.ts`
  fails if production code outside the adapter layer reads a key variable.

## Model registry config

soot has no built-in model list beyond the [auto models](#auto-models-from-your-keys-adr-043)
it adds for well-known keys. You describe providers and models in JSON and load it with
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

| Key                  | Default    | Meaning                                                                                                                         |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `models`             | none       | Model registry file (above), relative to the config file. Optional: without it, models come from your keys (`autoModels`).      |
| `autoModels`         | `true`     | Add models for well-known vendor keys that are set (see [Auto models](#auto-models-from-your-keys-adr-043)). `false` = off.     |
| `localModels`        | `true`     | Probe local runtimes for keyless models ([below](#keyless-local-models-adr-044)). `false` = off; `{ "urls", "contextWindow" }`. |
| `policy`             | `balanced` | `economy`, `balanced` or `quality` ([routing](model-routing.md)).                                                               |
| `checks`             | `[]`       | Project checks run on every task that changes files, and on the merged result.                                                  |
| `acceptance`         | `{}`       | Extra commands per task id; also run for read-only tasks (their only way to be verified).                                       |
| `protectedPaths`     | `[]`       | Paths no task may change, even inside its lease. The config, registry, fixtures and mock script are added automatically.        |
| `allowedExecutables` | `[]`       | Exact `argv[0]` values allowed to run. Destructive programs are refused regardless.                                             |
| `concurrency`        | `4`        | Tasks running at once (1–16).                                                                                                   |
| `attemptTimeoutMs`   | `1800000`  | Abort an attempt after this many ms (default 30 minutes, `DEFAULT_ATTEMPT_TIMEOUT_MS`); a hung runner ends as `timeout`.        |
| `modelCallTimeoutMs` | `120000`   | Wall-clock limit for one model call: one `--agent api` try (with its repair round and retries) or one planner call (ADR-040).   |
| `escalation`         | defaults   | Escalation limits and budgets (`@soot/escalation`, e.g. `{ "sameModelRetries": 0 }`).                                           |
| `fixtures`           | none       | JSON array of extra recorded decompositions `{ id, prompt, tasks }`.                                                            |
| `acpAgent`           | none       | ACP agent for `--agent acp`: `command`, `args`, `passEnv` (variable names; credential-like names are rejected).                 |
| `decomposer`         | none       | `{ "model": "<provider/modelId>" }` or `{ "model": "auto" }`: the model for prompts with no fixture (see below).                |

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
- Only decomposition uses this model. Execution needs `--agent api` (each task on its routed
  model, ADR-039), `--agent mock` or `--agent acp`; routing is unchanged.
- **Planning cost (ADR-045).** The planning call's tokens and price are a line of their own in
  `soot cost`, the run report and the dashboard ("Planning (decomposition, not a task)"), and
  the run total includes them (`cost.totals.run`). An unpriced model or unreported usage stays
  `unknown`, never $0. Priced planning counts against `escalation.runBudgetUsd` before any
  task starts: if planning alone is over the budget, the run stops with that reason and no
  task starts; otherwise the tasks share what is left. Unknown planning cost is not counted
  (soot logs a warning when a run budget is set).
- **Provider cooldowns (ADR-045).** The planner call is skipped while its provider is in a
  cooldown recorded by an earlier task attempt or planner call (the model is reported as not
  usable, with the time it ends), and an outage, rate limit, timeout or auth failure of the
  planner call records a cooldown the same way a task attempt does.
- **Status:** implemented, verified with mock model clients, and run live with
  `deepseek/deepseek-flash` (2026-11-13).

### Auto models from your keys (ADR-043)

If a well-known vendor key is set in the environment soot starts in, soot adds that vendor's
models by itself, so you can have several keys and let soot pick per task:

| Key variable        | Provider id | Endpoint                                             |
| ------------------- | ----------- | ---------------------------------------------------- |
| `ANTHROPIC_API_KEY` | `anthropic` | Anthropic Messages API                               |
| `OPENAI_API_KEY`    | `openai`    | OpenAI Chat Completions                              |
| `XAI_API_KEY`       | `xai`       | `https://api.x.ai/v1` (OpenAI-compatible)            |
| `DEEPSEEK_API_KEY`  | `deepseek`  | `https://api.deepseek.com/v1` (`json_object` output) |

- soot checks only that the variable is set (inside the adapter layer); the value is never
  printed, logged or written anywhere.
- The models are that vendor's entries in soot's [price catalog](#prices), with the
  catalog's sourced price. Each gets `tools` and `structuredOutput`; vision, reasoning and
  context window stay unknown. Reliability stays unknown too.
- Each gets a **tier** from its list output price: `low` under $2.50 per million output
  tokens, `medium` from $2.50, `high` from $15. While a model has no reliability data, the
  router gives it work up to its tier, cheapest first; once soot has recorded enough outcomes
  for the model, measured reliability decides instead ([routing](model-routing.md)).
- **Your models file wins.** A vendor whose provider id or key variable your file already
  configures gets nothing added. Configure a vendor yourself to choose its models, tiers or
  priors. `"autoModels": false` turns the pool off.
- You can set `"tier": "low" | "medium" | "high"` on your own models too, for example a free
  [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) endpoint for light work.
- Work that needs a capability soot does not assume (for example `reasoning` for security
  review) still needs a model that declares it in your models file.
- `soot config` lists each vendor as added, not used (no key), configured (your file covers
  it) or off. `soot models` marks auto models and shows each tier.
- `"decomposer": { "model": "auto" }` picks the cheapest priced model with structured output
  whose key is set, skipping `low`-tier models when another is available. Without
  `decomposer`, decomposition stays fixtures-only as before.

### Keyless local models (ADR-044)

Local runtimes need no key. When `soot run`, `soot models` or `soot config` starts, soot asks
each local runtime for its models (`GET <baseURL>/models`, no key sent, 500 ms limit, all
runtimes at once) and adds what answers:

| Runtime   | Provider id | Base URL probed             |
| --------- | ----------- | --------------------------- |
| Ollama    | `ollama`    | `http://127.0.0.1:11434/v1` |
| LM Studio | `lmstudio`  | `http://127.0.0.1:1234/v1`  |

- Each runtime that answers becomes an `openai-compatible` provider with `local: true` and no
  `apiKeyEnv`. Its chat models (embedding models are skipped, at most 32 per runtime) are
  priced at $0 (`source: "local runtime"`) and get tier `low`, so light work goes to them
  first and harder work still goes to stronger models.
- Each gets `tools` and `structuredOutput` (soot's API runner needs both; most current local
  chat models offer them through these runtimes). A model that cannot do either fails its
  try, and escalation moves the task on.
- The listing does not say how much context a runtime loaded, and Ollama and LM Studio both
  default to 4096 tokens, so soot assumes **4096** and routes only tasks that fit. If you
  raised the runtime's context, set `"localModels": { "contextWindow": 32768 }` to match.
- **Other addresses:** `"localModels": { "urls": ["http://127.0.0.1:8080/v1"] }` in
  soot.config.json, or `SOOT_LOCAL_MODEL_URLS=http://127.0.0.1:8080/v1,...` (the variable
  wins). A URL with no path gets `/v1`. Runtimes on other ports get ids like
  `local-127-0-0-1-8080`.
- **Your models file wins.** A runtime whose provider id or base URL (`localhost` and
  `127.0.0.1` count as the same) your file configures gets nothing added. Configure it
  yourself to choose models, tiers, context windows or priors.
- **Off:** `"localModels": false`, `"autoModels": false`, or `SOOT_LOCAL_MODELS=off`.
- `soot config` and `soot models` list each runtime as added, not-running, no-models, error,
  configured or off, and `soot models` marks local models `(auto: local runtime at <url>, no
key)`. The dashboard's project panel reads config without probing and shows `not-probed`;
  a dashboard run probes like `soot run`.
- Nothing leaves your machine: the probe goes only to the addresses above (or yours), and
  `"decomposer": { "model": "auto" }` never picks a local model, since they are tier `low`.

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

### Model call limit (ADR-040)

`modelCallTimeoutMs` (default 120,000 ms = 120 s) is a wall-clock limit on one model call:

- **`--agent api`:** one try, meaning both of its rounds (the reply and the one repair round)
  and the provider adapter's own transient retries. When it expires soot aborts the HTTP
  request and the try ends as a `timeout`. The escalation rules then retry the same model (up
  to `transientRetries`, default 2) and after that fall back to another provider. The attempt
  history, `soot status` and the dashboard's timeline say, for example, "timed out after 120s
  waiting for xai/grok-4.7". A timeout is not counted as a failed result in routing history,
  which measures whether soot verified the work.
- **Planner:** the decomposer model call. On expiry the run stops before any task runs, with
  "the planner model … timed out after 120s".

`attemptTimeoutMs` still bounds the whole attempt, including soot's checks. Requests are not
streamed, so there is no separate idle timeout. Usage of an aborted request is not reported by
the provider, so a timed-out try has no token count or cost (the provider may still bill it).
`soot config` shows the effective limit.

### What persists across restarts (ADR-030)

- **Provider cooldowns** (`provider_cooldowns`): a provider marked unavailable for an outage,
  rate limit or timeout stays skipped by later runs and restarted processes until its cooldown
  ends. Auth and "not configured" marks last for the process only, so fixing a key and running
  again is enough.
- **Run-budget spend** (`attempt_spend`): one row per attempt, the reported actual cost when the
  runner sent one, otherwise the routed estimate. A restarted run rebuilds its budget from these
  rows, including tasks that already finished. Nothing is filled in: an attempt without a price
  has no row.
