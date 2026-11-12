# Configuration

Configuration is read from environment variables. `.env.example` lists every variable; copy it
to `.env` for local overrides. `.env` is git-ignored and must never be committed.

> Nothing loads `.env` automatically yet. Variables are read only by
> `parseEnv(process.env)` from `@soot/core`; the `soot` CLI uses it for the state directory
> (override with `--data-dir`).

## Orchestrator variables (read today by `parseEnv`)

| Variable         | Default   | Values                                                        | Purpose                                                                                               |
| ---------------- | --------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SOOT_LOG_LEVEL` | `info`    | `silent`, `error`, `warn`, `info`, `debug` (case-insensitive) | Engine log verbosity. Invalid values throw `EnvConfigError`.                                          |
| `SOOT_DATA_DIR`  | `~/.soot` | absolute or relative path (relative resolves against cwd)     | Local-first state: `soot.sqlite` (execution state, M1); `worktrees/<run>/`, `audit/<run>.jsonl` (M5). |

Empty values are treated as unset.

The state directory is created with mode `0700` if missing. `soot.sqlite` holds runs (the
exact original prompt, the task graph) and per-task attempts with their validated structured
results. It never holds credentials or agent transcripts.

## Provider credentials (bring your own keys)

A model config names the variable that holds each provider's key (`apiKeyEnv`, see below);
it never contains the key itself, and the config validator rejects anything that is not an
environment-variable name. Conventional names, reserved in `.env.example` with empty values:

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (the Milestone 2 adapters), and `GEMINI_API_KEY`,
`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY` (reserved, no adapter yet).
DeepSeek endpoints are refused by policy whatever key is set (ADR-016).

Rules (ADR-022, M2-08):

- Keys stay on the user's machine and are read only by `@soot/provider-adapters`
  (`createModelClient`, `discoverModelIds`) when a client is created. They are sent only as
  the provider's auth header.
- They are never placed in task context, results, logs, warnings, errors, or messages between
  agents. Errors are sanitized and any echoed key is replaced with `[redacted]`.
- Tests never require real keys and never call real providers. `tests/credential-boundary.test.ts`
  fails if production code outside the adapter layer reads a key variable.

## Model registry config

soot has no built-in model list or prices. You describe providers and models in JSON and load
it with `loadRegistryConfigFile(path)` (`@soot/model-registry`):

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
and an `asOf` date. `reliability` is your prior estimate (0–1) that the model completes a task
of each complexity. It needs a `source`. The router (`@soot/model-router`) blends it with
recorded success history. A model with no prior and too little history has unknown reliability,
and the built-in policies do not select it. Cost estimates and provider-reported actuals stay separate types.

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
| `attemptTimeoutMs`   | none       | Abort an attempt after this long.                                                                                        |
| `escalation`         | defaults   | Escalation limits and budgets (`@soot/escalation`, e.g. `{ "sameModelRetries": 0 }`).                                    |
| `fixtures`           | none       | JSON array of extra recorded decompositions `{ id, prompt, tasks }`.                                                     |
| `acpAgent`           | none       | ACP agent for `--agent acp`: `command`, `args`, `passEnv` (variable names; credential-like names are rejected).          |

Check entries: `name`, `kind` (`test`, `typecheck`, `lint`, `acceptance`), `argv`, optional
`timeoutMs` and `required` (default `true`).

## CLI state files

Under the state directory: `soot.sqlite` (runs, attempts, model outcomes), `reports/<run>.json`
(the consolidated report), `audit/<run>.jsonl`, `worktrees/<run>/` (removed after the run) and
`control/<run>.lock|.stop` (used by `soot stop`).
