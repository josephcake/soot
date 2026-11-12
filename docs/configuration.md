# Configuration

Configuration is read from environment variables. `.env.example` lists every variable; copy it
to `.env` for local overrides. `.env` is git-ignored and must never be committed.

> Nothing loads `.env` automatically yet. Variables are read only by
> `parseEnv(process.env)` from `@soot/core`. No CLI exists yet (Milestone 6); callers pass
> `parseEnv(process.env).dataDir` to `openExecutionStore` from `@soot/context-manager`.

## Orchestrator variables (read today by `parseEnv`)

| Variable         | Default   | Values                                                        | Purpose                                                                             |
| ---------------- | --------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `SOOT_LOG_LEVEL` | `info`    | `silent`, `error`, `warn`, `info`, `debug` (case-insensitive) | Engine log verbosity. Invalid values throw `EnvConfigError`.                        |
| `SOOT_DATA_DIR`  | `~/.soot` | absolute or relative path (relative resolves against cwd)     | Local-first state: `soot.sqlite` (execution state, M1); later worktrees, audit log. |

Empty values are treated as unset.

The state directory is created with mode `0700` if missing. `soot.sqlite` holds runs (the
exact original prompt, the task graph) and per-task attempts with their validated structured
results. It never holds credentials or agent transcripts.

## Provider credentials (reserved, not read)

Bring-your-own-keys is a core principle, but **no provider integration exists yet**
(Milestone 2). These names are reserved so contributors do not invent conflicting ones; no
code reads them today:

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`,
`OPENROUTER_API_KEY`, `XAI_API_KEY`.

Rules for when they are used:

- Credentials stay on the user's machine (local-first) and are read only by provider adapters.
- They must never be placed in task context, logs, or messages between agents.
- Tests must not require them; real-provider tests will be opt-in.

`tests/repo-structure.test.ts` fails if `.env.example` ever contains a value for a
`*KEY*`, `*TOKEN*`, `*SECRET*`, or `*PASSWORD*` variable, and if any `SOOT_*` variable in
`.env.example` is missing from this document.
