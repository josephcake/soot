# intelligent-agent-router

> **Status: Milestone 0 — repository foundation only.**
> There is **no working orchestration yet**: no prompt decomposition, no model routing, no
> provider connectivity, no CLI commands, no agent skill, and no IDE extension. Every package
> under `packages/` and `apps/` except a small piece of `core` is an explicitly labeled stub.
> This README describes the goal and the current, real state. It will be updated as each
> milestone is verified. See [`PROJECT_STATUS.md`](PROJECT_STATUS.md) for the live status.

## What this project is for

`intelligent-agent-router` is planned as an open-source, model-agnostic **task-level
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

These are recorded in [`DECISIONS.md`](DECISIONS.md).

## Current functionality (verified)

| Area                             | Status                                                                |
| -------------------------------- | --------------------------------------------------------------------- |
| pnpm monorepo, 13 packages       | Builds with `tsc -b` (project references)                             |
| Strict TypeScript                | Typecheck passes                                                      |
| ESLint + Prettier                | Lint and format check pass                                            |
| Vitest                           | Unit + repository-structure tests run                                 |
| `@intelligent-agent-router/core` | Exports package metadata and `parseEnv()` for `IAR_*` vars            |
| Everything else                  | **Stub** (exports only its name and `IMPLEMENTATION_STATUS = 'stub'`) |

### Supported providers

**None yet.** Provider connectivity (planned via LiteLLM or an equivalent, plus local
endpoints such as Ollama) is Milestone 2.

### Supported harnesses

**None yet.** A universal agent skill and Claude Code / Codex / MCP integration are
Milestone 6; IDE extensions are Milestone 7. No compatibility is claimed until tested.

## Quick start (contributors)

Requirements: Node.js 24 LTS or newer (`.nvmrc` pins 26, the current Active LTS) and pnpm 10.

```sh
pnpm install
pnpm run ci        # install, typecheck, lint, format check, test, build (scripts/ci.sh)
```

Individual steps: `pnpm run typecheck | lint | format:check | test | build`.

## Configuration

Copy `.env.example` to `.env` if you need to override defaults. Only `IAR_LOG_LEVEL` and
`IAR_DATA_DIR` exist today; provider key names are listed as reserved and are not read by
any code. Details: [`docs/configuration.md`](docs/configuration.md). Never commit real keys.

## Example execution and cost optimization

Not available yet. There is nothing to run end to end, and no savings are claimed. The
target behavior is described in [`docs/specs/build-spec.md`](docs/specs/build-spec.md);
savings will only be reported from real benchmark data.

## Repository layout

See [`docs/architecture.md`](docs/architecture.md).

## Project tracking

[`PROJECT_STATUS.md`](PROJECT_STATUS.md) · [`ROADMAP.md`](ROADMAP.md) ·
[`TASKS.md`](TASKS.md) · [`DECISIONS.md`](DECISIONS.md) ·
[`TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md) · [`FUTURE_FEATURES.md`](FUTURE_FEATURES.md) ·
[`CHANGELOG.md`](CHANGELOG.md)

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
Security reports: [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE).
