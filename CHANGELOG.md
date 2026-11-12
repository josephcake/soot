# Changelog

All notable changes are recorded here by milestone. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No versions have been released.

## [Unreleased] — Milestone 6 (partial): CLI, MCP server, universal skill (2026-11-12, fixtures, mock agent)

### Fixed (docs)

- Stale tracking claims after ADR-030: attempt timeouts are no longer described as opt-in,
  `parseEnv` as unused, schema v4 is documented, the ACP runner is listed next to the mock, and
  the already-written docs (`installation`, `providers`, `model-routing`, `security`) and the
  existing `skills/` and `examples/demo-app/` are no longer listed as missing. The vsix sideload
  note now says plainly that the build has not been run in a real editor.

### Added

- `@soot/cli` (was a stub): the `soot` binary with `run`, `models`, `status`, `config`, `cost`,
  `stop`, `install-skill`, `mcp`; `SootEngine`; `soot.config.json` schema; mock scripts;
  terminal approvals (no approve-all); cross-process stop; saved reports.
- `@soot/harness-adapters` (was a stub): `OrchestrationService`, `createSootMcpServer` (official
  MCP SDK v2, tools `soot_run|status|cost|models|stop`), `HARNESS_SUPPORT` (Claude Code, Codex,
  Grok: not implemented, not claimed).
- `skills/universal-orchestrator/SKILL.md` and `soot install-skill`.
- `examples/demo-app` with config, fictional registry and mock script; fixture-backed CLI tests
  for spec §17 Tests 1 and 2 and the Test 4 graph shape, `soot stop` and `soot mcp` over stdio.
- Docs: installation and quick start, providers, model routing, security; config file reference.
- Generic ACP driver (ADR-027): `AcpAgentRunner`, `spawnAcpAgent` and a scripted mock ACP agent
  (test double) in `@soot/harness-adapters`, on the official `@agentclientprotocol/sdk` (stable
  v1). `soot run --agent acp` / `soot mcp --agent acp` spawn the user's configured `acpAgent`
  command. New approval action `harness-permission`. Tested only with the mock ACP agent.
- ACP routed model (ADR-028): soot sets the agent's `model` session option to the routed model
  when offered; otherwise every attempt reports "route not applied". `acpRoutes` in run reports.
- Milestone 7 (partial, ADR-029): `apps/vscode-extension` (`soot-vscode`, private, unpublished),
  a thin VS Code / Cursor extension over the soot CLI: orchestration on/off, task graph by
  layer, active agents, per-attempt models, escalation and retry events, failures, estimate vs
  actual cost, cancel task, stop run. Tested with a fake `vscode` module and the real CLI with
  `--agent mock`; not run in a real editor.
- Engine hardening (ADR-030): `SOOT_LOG_LEVEL` and `SOOT_DATA_DIR` honoured by the CLI and
  `soot mcp` (`runtimeFromEnv`, `createLogger`); provider cooldowns and per-attempt run-budget
  spend persisted in `soot.sqlite` (schema v4) and reloaded on restart; routed estimates written
  into cost records automatically (`costRecordsFromAttempts`, `soot cost` / run report
  `costRecords`); routing decisions in the audit log (`routing-decision`, `model-route`); a
  default 30-minute attempt timeout (`DEFAULT_ATTEMPT_TIMEOUT_MS`); `soot config` shows it.
- Unverified sideload note for the unpublished `.vsix` (VS Code, Cursor).
- `soot stop <run> --task <id>` and MCP `soot_stop` `taskId`: cancel one task (dependents
  skipped, other tasks continue). Live routing events in `reports/<run>.events.jsonl`;
  `soot status <run>` adds per-attempt details, `running` and events.

### Changed

- `@soot/integrations`: protected paths. A task that changes a protected file fails as
  out-of-scope even inside its write lease.

## [Unreleased] — Milestone 5: Codebase integration and safety (verified locally 2026-11-12, fixture repos, mocks)

### Added

- `@soot/integrations` (was a stub): `runCodebaseWorkflow` and its parts:
  - `Repository`: refuses a dirty tree, pins the base, one worktree and branch per task
    (`soot/<run>/<task>`) outside the repo, reset on retry, cleanup of this run's worktrees
  - `WriteLeases`, `withinScope`, `findDiffOverlaps`; out-of-scope edits caught from the real diff
  - `runCheck` / `checkCommand`: argv without a shell, executable allowlist, destructive
    programs and git subcommands refused, scrubbed environment, timeouts, redacted output
  - `IsolatedTaskRunner`: soot commits, diffs and validates each attempt; only soot-run
    evidence verifies a task; failed verification feeds the M4 supervisor
  - `integrateSerially`: merge-tree dry run per task onto the current HEAD; conflicts recorded
    and branches kept; final validation of the merged result
  - fast-forward of the user's working tree only after final validation and explicit approval
  - `buildConsolidatedReport` / `renderConsolidatedReport`: incomplete work listed first
  - `applyStructuredEdits`: the scoped, all-or-nothing write primitive for ADR-020
- `@soot/agent-runtime`: `ApprovalGate` (`UNATTENDED_APPROVALS`, `InteractiveApprovalGate`; no
  auto-approve), `TaskWorkspace` and `TaskPermissions` for runners; `MockAgentRunner` can write
  files, request approval and report fictional `costUsd`; assignments carry their tier.
- `@soot/observability`: `AuditLog` (redacted JSON Lines, mode 0600), `buildCostReport` /
  `renderCostReport` (estimate vs actual per task, per attempt and by model).
- `@soot/context-manager`: schema v3 (`model_outcomes`, migrated in place) with
  `recordModelOutcome` / `modelOutcomes`; `buildAgentContext`, `fenceUntrusted`,
  `scanForInjection` for untrusted content.
- `tests/m5-codebase-end-to-end.test.ts` checks exit criteria EC1–EC4 and M5-05…M5-09. ADR-025.

## [Unreleased] — Milestone 4: Adaptive execution (verified locally 2026-11-12, mocks)

### Added

- `@soot/escalation`: `AdaptiveSupervisor` and pure decision helpers:
  - trigger detection: repeated failure, unexpected complexity, unmet criteria, low confidence,
    tool errors, token blowup, invalid output, crash
  - escalation to an untried, more reliable model via `@soot/model-router`, one tier up
  - provider fallback on outage, auth failure, and persistent rate limits, with health marking
  - bounded retries with retry-after/exponential backoff, attempt and escalation limits, task
    and run budgets
  - downgrade of dependents after a plan or investigation, only when the saving is worth a
    switch, never for high-risk work
  - an explainable event for every decision
- `@soot/agent-runtime`: `AttemptSupervisor` hook, per-attempt records, per-attempt timeouts,
  retry timers that hold no concurrency slot, assignment and `priorAttempts` (context
  transfer) passed to runners, failure classification, cancellation of waiting retries.
  `MockAgentRunner` gains `provider-error`, scripted `signals` and `findings`, and `scriptFor`.
- `@soot/task-graph`: optional `signals` on `AgentResult` (JSON Schema regenerated).
- `@soot/context-manager`: schema v2 (`attempt_details`, migrated in place from v1);
  `loadRun` returns `attemptRecords` for resuming with history.
- `@soot/planner`: spec §17 Test 3 fixture.
- `tests/m4-adaptive-end-to-end.test.ts` checks exit criteria EC1–EC6. ADR-024.

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
