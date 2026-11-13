<p align="center">
  <img src="docs/brand/soot-lockup-4x.png" alt="soot" width="480" />
</p>

<h1 align="center">soot</h1>

<p align="center">
  Open-source, model-agnostic task-level orchestration for the AI coding tools you already use.
</p>

[![CI](https://github.com/josephcake/soot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/josephcake/soot/actions/workflows/ci.yml)

_Named after the soot sprites, the black dust bunnies from Studio Ghibli. Formerly `intelligent-agent-router`._

> **Status: Milestones 1, 3, 4 and 5 done (mocks, fixtures and fixture git repos); Milestones 2
> (provider connectivity) and 6 (CLI and skill) in progress.**
> The `soot` CLI runs the whole workflow on a git repository from one prompt: decompose
> **from recorded fixtures** (an optional configured decomposer model for other prompts exists
> but is verified with mocks only), route each task under an
> Economy, Balanced or Quality policy, run independent tasks in parallel worktrees, verify each
> with the project's own checks, integrate serially and report per-task cost. The only agent is
> a **scripted mock** (no model is called). Provider adapters exist but have **not been run
> against a real provider**. An MCP server and a universal agent skill exist; **no harness
> (Claude Code, Codex, …) is supported yet**. See [`docs/project/PROJECT_STATUS.md`](docs/project/PROJECT_STATUS.md).

## What this project is for

`soot` is planned as an open-source, model-agnostic **task-level
orchestration engine** that plugs into the AI coding tools developers already use
(as a skill, CLI, MCP server, or extension) instead of replacing them.

The intended flow, once built:

1. A developer sends **one prompt** to their existing coding assistant.
2. The engine decomposes it into a **task graph** with explicit dependencies and acceptance criteria.
3. Each task is routed **independently** to the cheapest model that can reliably do it.
4. Independent tasks run **in parallel**, isolated in git worktrees.
5. Tasks can be **escalated or downgraded** mid-flight without restarting unrelated work.
6. Results are integrated, validated with real evidence, and reported with **per-task cost**.

### How it differs from ordinary multi-agent systems

Model selection happens per task, not per prompt or per conversation, and it is revisited
during execution. The engine is a layer under existing harnesses, not another chat app or
coding assistant.

### Non-negotiables

- **Bring your own keys** — you pay providers directly; this project never resells model access.
- **Local-first** — orchestration state, credentials, and project context stay on your machine by default.
- **No vendor lock-in** — models/providers and IDEs/harnesses are replaceable independently.
- **Task-level billing** — every task's cost is tracked, including escalations.
- **Capability benchmarks** — routing learns from measured task outcomes, not marketing claims.
- **Safe concurrency** — git worktrees (or equivalent) isolate agents from each other.

These are recorded in [`docs/decisions/DECISIONS.md`](docs/decisions/DECISIONS.md).

## Current functionality (verified)

| Area                                  | Status                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------- |
| pnpm monorepo, 15 packages            | Builds with `tsc -b` (project references)                              |
| Strict TypeScript                     | Typecheck passes                                                       |
| ESLint + Prettier                     | Lint and format check pass                                             |
| Vitest                                | Unit + repository-structure tests run                                  |
| `@soot/core`                          | Exports package metadata and `parseEnv()` for `SOOT_*` vars            |
| `@soot/task-graph`                    | Task + agent-result contracts (JSON Schema), dependency graph (M1)     |
| `@soot/planner`                       | Prompt intake; fixture decomposer; model decomposer (mocks, ADR-033)   |
| `@soot/agent-runtime`                 | Concurrent scheduler + `MockAgentRunner`; supervised attempts (M1, M4) |
| `@soot/context-manager`               | SQLite execution state and attempt history, resume after kill (M1, M4) |
| `@soot/observability`                 | Cost records and reports (M1, M5); routing log (M3); audit log (M5)    |
| `@soot/model-registry`                | User model config, availability, selection, sourced pricing (M2)       |
| `@soot/provider-adapters`             | `ModelClient` over the AI SDK, mocked-HTTP verified (M2)               |
| `@soot/model-router`                  | Per-task routing with policies and explanations, fixture-verified (M3) |
| `@soot/escalation`                    | Escalation, fallback, bounds, downgrade; mock-verified (M4)            |
| `@soot/integrations`                  | Worktrees, soot-run checks, merge-tree integration, reports (M5)       |
| `@soot/cli`, `@soot/harness-adapters` | `soot` CLI, MCP server, generic ACP driver (M6, partial)               |
| `@soot/dashboard`                     | Optional local dashboard, `soot dashboard`, 127.0.0.1 only (ADR-031)   |

### Supported providers

**Implemented, verified with mocks only.** Milestone 2 (in progress) adds adapters for
Anthropic, OpenAI, and generic OpenAI-compatible endpoints (Ollama, LM Studio) through the
Vercel AI SDK in-process (ADR-017, ADR-019, ADR-022). They are tested against mocked HTTP. **No
real provider has been called yet**: that needs your own keys (M2-07, blocked). soot ships no
built-in model list; you configure models yourself (`@soot/model-registry`). Prices for
popular models come from a sourced catalog of official list prices (ADR-037); refresh them
with the [update-model-pricing prompt](skills/update-model-pricing/SKILL.md). DeepSeek is
optional and user-configured like any OpenAI-compatible provider (ADR-035 lifted the ADR-016
hold); it is not a default. See
[`packages/provider-adapters/README.md`](packages/provider-adapters/README.md).

### Supported harnesses

**None yet.** `soot mcp` serves soot over MCP (tested with the official MCP SDK client, not
inside any product) and `soot install-skill` installs the universal skill into `.agents`,
`.claude` and `.grok` skill folders. `soot run --agent acp` runs tasks through an ACP agent
command you configure (one generic driver, tested only with soot's own mock ACP agent). Claude Code and Codex integration (M6-04/05) are not built.

### IDE extension (Milestone 7, partial)

`apps/vscode-extension` is a thin, unpublished VS Code / Cursor extension that runs the soot CLI
and shows the task graph, active agents, models, escalations, failures and cost as text blocks,
with cancel-task and stop-run. It is tested with a fake editor API and the mock agent only and
**has not been run in VS Code or Cursor**. Windsurf, Kilo Code and Copilot are not claimed. No
compatibility is claimed until tested.

### Local dashboard (optional)

soot is headless by default. `soot dashboard` starts an optional local page on 127.0.0.1
(port 8787; `--port <n>` to change it; `--open` to open a browser). Open the access link it
prints; it holds an access token. With `--agent mock --mock-script <file>` or `--agent acp`,
the landing page is a prompt box: pick a folder you allowed with
`soot dashboard allow <dir>`, type a prompt, press Enter, and it plans and runs right away,
showing each task's model, state and cost so far, with Stop. Without `--agent` it is
read-only. Overview and Prompts show every recorded run: where tasks went, each task's
model, runner, tokens and cost. Unknown costs stay unknown and no savings are claimed. No
other command starts or loads it ([`apps/dashboard`](apps/dashboard/README.md), ADR-031,
ADR-038).

## Try it (no keys)

See [`docs/guides/installation.md`](docs/guides/installation.md): build this checkout, copy
`examples/demo-app` to a temp directory, and run
`soot run "<prompt>" --agent mock --mock-script mock-agent.json`. Also:
[providers](docs/guides/providers.md), [model routing](docs/guides/model-routing.md),
[security](docs/guides/security.md), [configuration](docs/guides/configuration.md).

## Quick start (contributors)

Requirements: Node.js 24 LTS or newer (`.nvmrc` pins 26, the current Active LTS) and pnpm 10.

```sh
pnpm install
pnpm run ci        # install, typecheck, lint, format check, test, build (scripts/ci.sh)
```

Individual steps: `pnpm run typecheck | lint | format:check | test | build`.

## Configuration

`SOOT_LOG_LEVEL` and `SOOT_DATA_DIR` configure soot (listed in `.env.example`); export them
in your shell. Provider keys are read only by the provider adapters, from
the variable your model config names (`apiKeyEnv`), and nothing loads `.env` files yet. Details: [`docs/guides/configuration.md`](docs/guides/configuration.md). Never commit real keys.

## Example execution and cost optimization

No user-facing command exists yet. The Milestone 1 flow (prompt → fixture decomposition →
graph → concurrent mock execution → persisted results) runs in
[`tests/m1-end-to-end.test.ts`](tests/m1-end-to-end.test.ts). Per-task routing of the spec's
fixture prompts under each policy, with explanations, runs in
[`tests/m3-routing-end-to-end.test.ts`](tests/m3-routing-end-to-end.test.ts) against a
fictional registry. Milestone 5 runs mock agents against real temporary git repositories,
with soot running `node --test`, `tsc` and lint on each task's diff, in
[`tests/m5-codebase-end-to-end.test.ts`](tests/m5-codebase-end-to-end.test.ts). No savings are claimed. The
target behavior is described in [`docs/specs/build-spec.md`](docs/specs/build-spec.md);
savings will only be reported from real benchmark data.

## Repository layout

See [`docs/guides/architecture.md`](docs/guides/architecture.md).

## Project tracking

[`docs/project/PROJECT_STATUS.md`](docs/project/PROJECT_STATUS.md) · [`docs/project/ROADMAP.md`](docs/project/ROADMAP.md) ·
[`docs/project/TASKS.md`](docs/project/TASKS.md) · [`docs/decisions/DECISIONS.md`](docs/decisions/DECISIONS.md) ·
[`docs/project/TECHNICAL_DEBT.md`](docs/project/TECHNICAL_DEBT.md) · [`docs/project/FUTURE_FEATURES.md`](docs/project/FUTURE_FEATURES.md) ·
[`CHANGELOG.md`](CHANGELOG.md)

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
Security reports: [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE).
