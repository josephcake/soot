# soot

_Named after the soot sprites, the black dust bunnies from Studio Ghibli. Formerly `intelligent-agent-router`._

> **Status: Milestones 1 and 3 done (mocks and fixtures); Milestone 2 (provider connectivity)
> in progress, verified with mocked HTTP only.**
> The engine can take one prompt, decompose it **from recorded fixtures** (there is no
> model-backed decomposition), build a dependency graph, run independent tasks concurrently
> with **mock agents** (a test double; no model is called), persist state in SQLite, and
> resume after a crash. It can route each task to a model from your registry under an
> Economy, Balanced, Quality, or Custom policy, and explain every choice (heuristic complexity
> evaluation). Provider adapters (Anthropic, OpenAI, OpenAI-compatible) exist but have **not
> been run against a real provider**. There is **no CLI
> command, no agent skill, and no IDE extension** yet. See
> [`PROJECT_STATUS.md`](PROJECT_STATUS.md) for the live status.

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

These are recorded in [`DECISIONS.md`](DECISIONS.md).

## Current functionality (verified)

| Area                       | Status                                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| pnpm monorepo, 13 packages | Builds with `tsc -b` (project references)                              |
| Strict TypeScript          | Typecheck passes                                                       |
| ESLint + Prettier          | Lint and format check pass                                             |
| Vitest                     | Unit + repository-structure tests run                                  |
| `@soot/core`               | Exports package metadata and `parseEnv()` for `SOOT_*` vars            |
| `@soot/task-graph`         | Task + agent-result contracts (JSON Schema), dependency graph (M1)     |
| `@soot/planner`            | Immutable prompt intake; fixture-backed decomposer only (M1)           |
| `@soot/agent-runtime`      | Concurrent scheduler + `MockAgentRunner` test double (M1)              |
| `@soot/context-manager`    | SQLite execution state, resume after kill (M1)                         |
| `@soot/observability`      | Estimate vs actual cost records (M1); routing explanation log (M3)     |
| `@soot/model-registry`     | User model config, availability, selection, sourced pricing (M2)       |
| `@soot/provider-adapters`  | `ModelClient` over the AI SDK, mocked-HTTP verified (M2)               |
| `@soot/model-router`       | Per-task routing with policies and explanations, fixture-verified (M3) |
| Everything else            | **Stub** (exports only its name and `IMPLEMENTATION_STATUS = 'stub'`)  |

### Supported providers

**Implemented, verified with mocks only.** Milestone 2 (in progress) adds adapters for
Anthropic, OpenAI, and generic OpenAI-compatible endpoints (Ollama, LM Studio) through the
Vercel AI SDK in-process (ADR-017, ADR-019, ADR-022). They are tested against mocked HTTP. **No
real provider has been called yet**: that needs your own keys (M2-07, blocked). soot ships no
built-in model list; you configure models yourself (`@soot/model-registry`). DeepSeek
endpoints are refused by policy (ADR-016). See
[`packages/provider-adapters/README.md`](packages/provider-adapters/README.md).

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

Copy `.env.example` to `.env` if you need to override defaults. `SOOT_LOG_LEVEL` and
`SOOT_DATA_DIR` configure soot. Provider keys are read only by the provider adapters, from
the variable your model config names (`apiKeyEnv`), and nothing loads `.env` files yet. Details: [`docs/configuration.md`](docs/configuration.md). Never commit real keys.

## Example execution and cost optimization

No user-facing command exists yet. The Milestone 1 flow (prompt → fixture decomposition →
graph → concurrent mock execution → persisted results) runs in
[`tests/m1-end-to-end.test.ts`](tests/m1-end-to-end.test.ts). Per-task routing of the spec's
fixture prompts under each policy, with explanations, runs in
[`tests/m3-routing-end-to-end.test.ts`](tests/m3-routing-end-to-end.test.ts) against a
fictional registry. No savings are claimed. The
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
