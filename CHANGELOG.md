# Changelog

All notable changes are recorded here by milestone. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No versions have been released.

## [Unreleased] — Milestone 6 (partial): CLI, MCP server, universal skill (2026-11-12, fixtures, mock agent)

### Changed (documentation layout)

- Project tracking and design docs moved from the repository root into `docs/project/` and
  `docs/decisions/`. Guides (`architecture`, `configuration`, `development`, `installation`,
  `model-routing`, `providers`, `security`) moved into `docs/guides/`. `docs/README.md` is the
  index. The repository root keeps README, LICENSE, CHANGELOG, CONTRIBUTING, SECURITY, and
  CODE_OF_CONDUCT.
- Relative links across the repo were updated. `scripts/check-doc-links.mjs` checks relative
  markdown and image links (historical research notes under `docs/research/` are excluded).

### Added (dashboard centerpiece and previous prompts, ADR-031, TASKS D-04; no milestone status change)

- The optional local dashboard now leads with a hand-drawn `<canvas>` (2D context, no chart
  library) showing where tasks went across every recorded prompt: pixel pipes from prompts to
  models, sized by unique tasks that had an attempt on that model. The largest share is orange.
  An empty state is a pixel "no data" block. Prompt text is drawn with `fillText` only.
- A Previous prompts list (newest first) shows each recorded prompt as soot stored it, with
  date, status, and total tokens/cost when the cost report recorded them. Clicking a prompt
  opens its detail: each task with the run's runner (soot records one agent/harness per run,
  not per task), the model(s) that took it, in/out/total tokens per task when every attempt
  reported usage, otherwise an explicit "not reported" reason, plus totals.
- `GET /api/runs` includes an `overview` built by reading each run's status and cost (the same
  engine data as before). `DashboardRun` gains `taskBreakdown`.
- Tests: `apps/dashboard/src/overview.test.ts`, more cases in `view.test.ts`, `ui.test.ts`
  (canvas and task breakdown against a fake DOM) and `server.test.ts`. Mock runs only.

### Changed (DeepSeek data-residency hold lifted, ADR-035 supersedes ADR-016; no milestone status change)

- Joseph reviewed data residency and lifted the hold. `@soot/model-registry` no longer
  restricts providers whose id or base URL is DeepSeek: `providerRestriction`,
  `ProviderRestriction`, `ModelRegistry.restriction` and the `restricted` exclusion reason are
  removed, and `isCallable` refuses only `listed-only` providers. `@soot/provider-adapters` no
  longer refuses DeepSeek in `createModelClient`; `soot models --json` drops the `restriction`
  field.
- DeepSeek is optional and user-configured (`openai-compatible`, `baseURL`
  `https://api.deepseek.com/v1`, `apiKeyEnv` `DEEPSEEK_API_KEY`); it is not a default, and the
  demo config is unchanged. It can be routed to and named as `decomposer.model`.
- Tests: DeepSeek is now shown selectable, routable and callable when configured (fake `fetch`
  and fake key values only); listed-only providers are still never selected or called. No live
  DeepSeek or other provider call was made; live use is unverified.
- Docs: providers, configuration, README, package READMEs, routing and architecture docs.

### Changed (dashboard page order, ADR-031; no milestone status change)

- The run view leads with a compact ident, the assignment graph, usage-by-model charts and a
  short chart legend, then the remaining insight charts; text details (task graph, agents, full
  prompt, savings) come after. Same blocks and data; no new chart types or API change.

### Added (decomposer model in soot.config.json, ADR-034, TASKS P-02; mocks only, no milestone status change)

- Optional `"decomposer": { "model": "<provider/modelId>" }` in `soot.config.json` (strict; the
  reference must be a model in the user's registry file). Absent: unchanged, fixture-only.
- The CLI/MCP engine builds the decomposer from it: `createDecomposer({ fixtures, model })` when
  a client can be built (registry model, callable provider, key variable set in the environment
  soot started with), otherwise fixture-only with no client. Recorded prompts never call the
  model. An unknown prompt with an unusable model fails naming the setting and the reason (for
  example `ANTHROPIC_API_KEY is not set`) and says no model was called; a model failure or
  invalid answer fails the run with `ModelDecompositionError`'s reason, never a guess.
- Run output: `decomposition` (fixture or model source, with model usage) in the run JSON and
  saved report; `fixtureId` is `null` for model plans; the text plan line names the model.
- `soot config` shows `Decomposition: ...` and `--json` has `decomposer` (`model`, `status`
  `not-configured` | `usable` | `unusable`, `reason`). No key value is printed.
- `@soot/cli` depends on `@soot/provider-adapters` (client creation through
  `createModelClient`; keys are still read only inside the adapter layer). `EngineOptions` has
  `modelEnv` and a `modelClientFactory` test seam.
- Docs: configuration, installation, skill, README, architecture. Tests:
  `tests/p02-decomposer-config.test.ts` (mock clients, `fetch` stubbed to fail) and the config
  schema test. No real model has decomposed a prompt; M2-07 stays Blocked.

### Added (model-backed decomposition, ADR-033, TASKS P-01; mocks only, no milestone status change)

- `ModelDecomposer` in `@soot/planner`: asks a caller-supplied `ModelClient` for structured
  output shaped like the task contract and validates the answer like a fixture (`parseTask`,
  `buildTaskGraph`, unpriced estimates, a task limit). Invalid answers fail with
  `ModelDecompositionError` (`model-call-failed`, `invalid-output`, `invalid-graph`).
- `createDecomposer({ fixtures, model })`: fixture-only without a client (no network);
  fixtures first, then the model, with one. `FixtureThenModelDecomposer` implements the latter.
- `Decomposition.decomposer` is now a union: `{ kind: 'fixture', fixtureId }` or
  `{ kind: 'model', modelRef, servedModelId, usage, attempts }`. `FixtureDecomposer` still
  returns the fixture form; `Decomposer.decompose` takes an optional `AbortSignal`.
- `@soot/planner` depends on `@soot/provider-adapters` for the `ModelClient` type (type-only
  import in production code; tests use its mock client).
- Verified with mock model clients only. No real model has decomposed a prompt (M2-07 is
  Blocked) and the CLI still decomposes from fixtures only.

### Changed (repository published, ADR-032; M0-11 Completed)

- The repository is public at https://github.com/josephcake/soot (MIT). ADR-006 (box-only) is
  superseded by ADR-032.
- Hosted GitHub Actions CI passed for Node 24 and Node 26
  ([run 43334786373](https://github.com/josephcake/soot/actions/runs/43334786373) on `8a38865`),
  so M0-11 is Completed. The workflow's stale "never run" header comment is gone and the README
  shows the CI badge. Tracking files and docs no longer say the repo is unpublished; there is
  still no npm package or release.

### Added (project logo; no milestone status change)

- Pixel soot logo (black / orange / cream, Lego-block cubes and a wordmark with an ember in
  the second O) in `docs/brand/`. The optional local dashboard header and favicon use it
  (`/logo.png`, `/mark.png`); the root README shows the lockup.

### Changed (dashboard palette and chart types, ADR-031 amendment, TASKS D-03; no milestone status change)

- Palette: near-black page and blocks, orange `#ff7a1a` accent, cream `#e8dcc8` highlights and
  hatched estimates, warm-gray notes, redder-orange errors. Yellow and blue are gone.
- New chart types from the existing payload: outcome pixel donut and success-rate meter, stacked
  input/output token bars (planned and reported apart), estimate-only and actual-only cost
  charts, an attempt timeline, validation counts by status, a transition count chart, and
  estimated/actual USD share donuts in each usage block. Cost by model is folded into the usage
  by model block with its numbers as text. No API or dependency change.
- Tests: more `apps/dashboard/src/ui.test.ts` cases (zero slices left out, null rate n/a with no
  fill, estimates and actuals apart, no finished bar for a running or unknown end).

### Added (dashboard charts, ADR-031 amendment; no milestone status change)

- Usage charts by model, task and runner (estimated USD, actual USD, planner tokens, reported
  tokens as separate CSS bar charts; unknown written as "unknown", never a bar) and an
  assignment view (prompt → tasks → model chain with retry/fallback/escalate/downgrade). Same
  run API, no chart library, no new dependencies.
- `DashboardRun` adds `agent`, `usage` and `assignment`; `soot status <run>` adds task
  `title`/`instructions` and run `agent`/`agentLabel`.
- Tests: `apps/dashboard/src/charts.test.ts`, `ui.test.ts` (page blocks against a fake DOM),
  more cases in `view.test.ts`, and an escalation run in `tests/dashboard.test.ts`.

### Added (optional local dashboard, ADR-031; no milestone status change)

- `@soot/dashboard` (`apps/dashboard`): a static block page and a read-only JSON API
  (`/api/runs`, `/api/runs/<id>`) on Node's `http`, bound to 127.0.0.1 only, showing the spec
  §12 fields from the engine's own status and cost data. No framework, no dependencies, no
  outbound requests, no savings claimed.
- `soot dashboard [--port <n>] [--open]`: default port 8787, fails if the port is taken, opens a
  browser only with `--open`, stops on Ctrl-C. Loaded lazily by that command only; headless
  commands never load it.
- `soot status <run>` data adds run `createdAt`, attempt `startedAt`/`finishedAt`, per-task
  `checks`, `finalValidation` and `problems` (additive).
- Tests: `apps/dashboard/src/{view,server}.test.ts`, `tests/dashboard.test.ts` (built binary:
  127.0.0.1-only listen checked on the socket and in `/proc/net/tcp`; taken port fails; headless
  commands and `soot mcp` run with the dashboard made unloadable and never listen).

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
  and cost estimates kept separate from actuals. DeepSeek endpoints are restricted (ADR-016; lifted by ADR-035).
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
