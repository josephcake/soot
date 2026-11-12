# Changelog

All notable changes are recorded here by milestone. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No versions have been released.

## [Unreleased] — Milestone 3: Intelligent model routing (verified locally 2026-11-12, fixtures)

### Added

- `@soot/model-router`: per-task routing with these parts:
  - heuristic complexity and capability evaluation that records its reasons
  - a capability filter
  - cost estimates from registry list prices
  - reliability estimates from configured priors blended with recorded history
  - selection of the best model above the policy threshold
  - Economy, Balanced, Quality and Custom policies
  - a full explanation for every decision
- `@soot/observability`: `RoutingLog` with readable text and JSON Lines output.
- `@soot/model-registry`: optional `reliability` priors per complexity tier. They are unknown by
  default and need a source when set.
- `tests/m3-routing-end-to-end.test.ts` checks exit criteria EC1–EC4 on the spec's fixture
  prompts.
- ADR-023.

## [Unreleased] — Milestone 2: Multi-provider connectivity (in progress; mocks only)

### Added

- `@soot/model-registry`: user model config (no built-in models or prices), strict validation
  (key fields must name environment variables), provider health with cooldowns, discovery
  overlay, requirement-based selection with exclusion reasons, sourced and dated pricing,
  and cost estimates kept separate from actuals. DeepSeek endpoints are restricted (ADR-016).
- `@soot/provider-adapters`: the `ModelClient` interface (chat, streaming, tool calls,
  validated structured output, usage) over the Vercel AI SDK in-process. Adapters for Anthropic,
  OpenAI (Chat Completions) and generic OpenAI-compatible endpoints. soot-owned retries with
  rate-limit handling, a sanitized error taxonomy, outage fallback, `GET /models` discovery,
  credential isolation, and a scripted mock test double.
- Tests: one provider contract suite run against the mock and each adapter over mocked HTTP;
  credential-leak tests; outage and fallback tests; a repo-level credential boundary guard; and a
  live local-endpoint test that is skipped when no local runtime is running.
- `docs/research/2026-11-12-soot.md` (copy of Lumen's research) and ADR-022.

### Not done

- M2-07, real calls with user-supplied keys, is Blocked (ADR-011). No real provider has been
  called.

## [Unreleased] — Milestone 1: Core orchestration (verified locally 2026-11-12, mock agents)

### Added

- `@soot/task-graph`: strict task and agent-result contracts (zod) with generated, committed
  JSON Schema; dependency graph with cycle detection, topological layers, file-conflict
  serialization, and revision that keeps completed tasks.
- `@soot/planner`: immutable, byte-exact prompt intake with project context and intended
  outcome; `Decomposer` interface and deterministic `FixtureDecomposer` with fixtures for build
  spec §3 and §17 Tests 1, 2, 4. No model-backed decomposition.
- `@soot/agent-runtime`: `Scheduler` (bounded concurrency, dependency ordering, cancellation,
  result validation, resume) and `MockAgentRunner` test double.
- `@soot/context-manager`: SQLite execution state (`node:sqlite`) in `SOOT_DATA_DIR`, resume
  after the process is killed.
- `@soot/observability`: per-task cost records with estimates and actuals kept separate.
- End-to-end exit-criteria test and SIGKILL resume test.
- ADR-014…ADR-021 (Mochi's binding calls on Lumen's research; Milestone 1 implementation choices).

### Changed

- Provider plan is the Vercel AI SDK in-process, not LiteLLM (ADR-019); docs updated.

## [Unreleased] — Milestone 0: Repository foundation (verified locally 2026-11-12)

### Changed

- Project renamed from `intelligent-agent-router` to `soot` (ADR-013): root package `soot`, scope
  `@soot/*`, env vars `IAR_*` → `SOOT_*`, default data dir `~/.soot`, repo path `/workspace/soot`.

### Added

- pnpm 10 workspace monorepo: `apps/cli` and 12 `packages/*` per build-spec §15 (stubs except `core`).
- Strict TypeScript 6 with project references (`tsc -b`) and a no-emit typecheck config.
- ESLint 10 (typescript-eslint strict, type-checked) and Prettier 3.
- Vitest 5 with per-package projects and repository-structure guard tests.
- `@soot/core`: package metadata exports and `parseEnv()` for `SOOT_LOG_LEVEL` / `SOOT_DATA_DIR`.
- `.env.example` and `docs/configuration.md` (no secrets; provider key names reserved only).
- GitHub Actions workflow (not yet run; repo unpublished) and equivalent `scripts/ci.sh`.
- MIT license, README, CONTRIBUTING, CODE_OF_CONDUCT (Contributor Covenant 2.1), SECURITY.
- Docs: architecture and repository layout, configuration, development.
- Tracking files: PROJECT_STATUS, ROADMAP, TASKS, DECISIONS (ADR-001…013), TECHNICAL_DEBT, FUTURE_FEATURES.
