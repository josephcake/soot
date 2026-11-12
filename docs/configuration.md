# Configuration

Configuration is read from environment variables. `.env.example` lists every variable; copy it
to `.env` for local overrides. `.env` is git-ignored and must never be committed.

> Milestone 0: nothing loads `.env` automatically yet. Variables are read only by
> `parseEnv(process.env)` from `@soot/core`, which no runtime calls yet.

## Orchestrator variables (read today by `parseEnv`)

| Variable         | Default   | Values                                                        | Purpose                                                              |
| ---------------- | --------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `SOOT_LOG_LEVEL` | `info`    | `silent`, `error`, `warn`, `info`, `debug` (case-insensitive) | Engine log verbosity. Invalid values throw `EnvConfigError`.         |
| `SOOT_DATA_DIR`  | `~/.soot` | absolute or relative path (relative resolves against cwd)     | Local-first state directory: future SQLite DB, worktrees, audit log. |

Empty values are treated as unset.

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
