# Engineering Tasks

Source: `docs/specs/build-spec.md` and `docs/specs/project-management.md` (MVP-01…MVP-08,
milestones M0–M7).

**Priorities:** P0 blocks MVP · P1 required for MVP · P2 important improvement · P3 future enhancement.

**Statuses:** Not Started · In Progress · Blocked · Implemented (code exists) · Verified
(acceptance criteria checked by real runs) · Completed (verified and recorded in tracking files).

MVP requirement → task mapping:

| MVP    | Requirement                  | Tasks                      |
| ------ | ---------------------------- | -------------------------- |
| MVP-01 | Prompt intake                | M1-02                      |
| MVP-02 | Task decomposition           | M1-01, M1-03, M1-04        |
| MVP-03 | Model discovery              | M2-01 … M2-07              |
| MVP-04 | Intelligent model routing    | M3-01 … M3-06              |
| MVP-05 | Agent execution              | M1-05, M1-06, M1-07, M1-08 |
| MVP-06 | Adaptive escalation          | M4-01 … M4-06              |
| MVP-07 | Integration and verification | M5-01 … M5-05              |
| MVP-08 | Cost tracking                | M1-09, M5-06               |

---

## M0 — Repository Foundation

| ID    | Description                                                                                            | Priority | Milestone | Dependencies            | Status    | Component                            | Acceptance criteria                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------ | -------- | --------- | ----------------------- | --------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0-01 | Initialize local git repository (no remote)                                                            | P0       | M0        | —                       | Completed | repo                                 | `git log` shows commits by Sweed; `git remote` is empty; specs committed intact.                                                                    |
| M0-02 | pnpm workspace with `apps/cli` + 12 `packages/*` per spec §15                                          | P0       | M0        | M0-01                   | Completed | repo                                 | `pnpm install --frozen-lockfile` succeeds; every package builds and tests via `pnpm --filter`.                                                      |
| M0-03 | Strict TypeScript, project references, no-emit typecheck                                               | P0       | M0        | M0-02                   | Completed | tsconfig.*                           | `pnpm run typecheck` and `pnpm run build` exit 0; `dist/` produced per package.                                                                     |
| M0-04 | ESLint (type-checked) + Prettier                                                                       | P0       | M0        | M0-03                   | Completed | eslint.config.js, .prettierrc.json   | `pnpm run lint` (zero warnings) and `pnpm run format:check` exit 0.                                                                                 |
| M0-05 | Vitest with real smoke tests                                                                           | P0       | M0        | M0-03                   | Completed | vitest.config.ts, tests/             | `pnpm run test` runs per-package and repo tests; tests fail when the guarded property breaks.                                                       |
| M0-06 | Environment configuration (`.env.example`, `parseEnv`, docs)                                           | P1       | M0        | M0-03                   | Completed | packages/core, docs/configuration.md | No secrets in `.env.example` (tested); `SOOT_*` vars documented (tested); `parseEnv` unit-tested.                                                   |
| M0-07 | Basic docs: README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, architecture, configuration, development  | P1       | M0        | M0-02                   | Completed | docs/                                | README states foundation-only status; architecture lists every package (tested).                                                                    |
| M0-08 | CI: GitHub Actions workflow + equivalent `scripts/ci.sh`                                               | P0       | M0        | M0-03, M0-04, M0-05     | Completed | .github/workflows, scripts/ci.sh     | `pnpm run ci` passes locally; workflow and script contain the same steps (tested).                                                                  |
| M0-09 | License MIT                                                                                            | P1       | M0        | M0-01                   | Completed | LICENSE                              | MIT text with agreed copyright line; all manifests say MIT (tested); ADR-005.                                                                       |
| M0-10 | Tracking files (PROJECT_STATUS, ROADMAP, TASKS, DECISIONS, TECHNICAL_DEBT, FUTURE_FEATURES, CHANGELOG) | P1       | M0        | —                       | Completed | repo root                            | All exist (tested); contents follow PM spec §5.                                                                                                     |
| M0-11 | First hosted GitHub Actions run                                                                        | P2       | M0        | M0-08, publish approval | Blocked   | .github/workflows                    | Workflow passes on GitHub for Node 24 and 26. Blocked: repo not published (ADR-006); Mochi decides. Not an M0 exit criterion (CI verified locally). |

## M1 — Core Orchestration

| ID    | Description                                                                                                                                                       | Priority | Milestone | Dependencies | Status    | Component                | Acceptance criteria                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- | ------------ | --------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| M1-01 | Task schema + JSON Schema contract (id, instructions, acceptance criteria, required capabilities, complexity, est. tokens/cost, files read/written, dependencies) | P0       | M1        | M0           | Completed | packages/task-graph      | Schema validates fixture tasks; invalid tasks rejected with clear errors.                           |
| M1-02 | Prompt intake: accept prompt + project context, preserve original prompt immutably, capture intended outcome                                                      | P0       | M1        | M1-01        | Completed | packages/planner         | Original prompt round-trips byte-for-byte; context attached; unit tests.                            |
| M1-03 | Decomposer interface with deterministic fixture-based implementation (LLM-backed decomposer after M2)                                                             | P0       | M1        | M1-01, M1-02 | Completed | packages/planner         | Spec §3 and §17 Test 1/2 prompts produce expected task sets from fixtures; no fake "AI" claims.     |
| M1-04 | Dependency graph: DAG build, cycle detection, topological layers, write-conflict detection on declared files, graph revision                                      | P0       | M1        | M1-01        | Completed | packages/task-graph      | Unit tests for cycles, layering, conflicting write sets serialized, revision keeps completed tasks. |
| M1-05 | Scheduler: run independent tasks concurrently (bounded), dependents wait, cancellation                                                                            | P0       | M1        | M1-04, M1-08 | Completed | packages/agent-runtime   | Test proves overlap of independent tasks (timestamps) and ordering of dependents.                   |
| M1-06 | Structured agent result schema (status, findings, diff/patch ref, evidence, usage)                                                                                | P0       | M1        | M1-01        | Completed | packages/task-graph      | Results validated; free-form transcripts not stored as shared memory.                               |
| M1-07 | Execution state persisted in SQLite under `SOOT_DATA_DIR`; resume after interruption                                                                              | P1       | M1        | M1-05, M1-06 | Completed | packages/context-manager | Kill/restart test resumes without re-running completed tasks.                                       |
| M1-08 | Mock agent runtime (scripted outcomes, delays, failures) for tests                                                                                                | P0       | M1        | M1-06        | Completed | packages/agent-runtime   | Used by scheduler tests; clearly labeled as test double.                                            |
| M1-09 | Per-task usage/cost record type (estimate vs actual fields)                                                                                                       | P1       | M1        | M1-06        | Completed | packages/observability   | Type + tests; estimates and actuals never conflated.                                                |

M1 evidence (2026-11-12, local `bash scripts/ci.sh`, Node 24.22.1 and 26.13.1 on fresh clones):
M1-01/M1-06 `packages/task-graph/src/{task,result,json-schema}.test.ts`; M1-04
`graph.test.ts`; M1-02 `packages/planner/src/intake.test.ts`; M1-03 `decomposer.test.ts`;
M1-05/M1-08 `packages/agent-runtime/src/{scheduler,mock-agent}.test.ts`; M1-07
`packages/context-manager/src/execution-store.test.ts` and `tests/resume-after-kill.test.ts`
(SIGKILL); M1-09 `packages/observability/src/cost.test.ts`; exit criteria
`tests/m1-end-to-end.test.ts`. Limits of what "Completed" means here: see `TECHNICAL_DEBT.md`
(fixture decomposer only, mock agents only, agent-reported success).

## M2 — Multi-Provider Model Connectivity

> Status: **In Progress (partial)**. Mockable scope verified 2026-11-12 with mocked HTTP and a
> scripted test double only; no real provider call has been made. M2-03 is Implemented, not Verified: the generic
> OpenAI-compatible adapter is covered by mocked HTTP, but the live local-runtime test was
> **skipped** (no Ollama or LM Studio was running). M2-07 is Blocked on user-supplied keys
> (ADR-011). Evidence: `packages/provider-adapters/src/*.test.ts`,
> `packages/model-registry/src/*.test.ts`, `tests/credential-boundary.test.ts`; choices in ADR-022.

| ID    | Description                                                                                                | Priority | Milestone | Dependencies     | Status      | Component                        | Acceptance criteria                                                                                |
| ----- | ---------------------------------------------------------------------------------------------------------- | -------- | --------- | ---------------- | ----------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| M2-01 | Provider abstraction interface (chat, streaming, tool calling, structured output, usage) + mocked provider | P0       | M2        | M1-06            | Completed   | packages/provider-adapters       | Contract tests pass against the mock.                                                              |
| M2-02 | Anthropic + OpenAI adapters via Vercel AI SDK (ADR-017, ADR-019); mocks only                               | P0       | M2        | M2-01            | Completed   | packages/provider-adapters       | Mocked HTTP tests; retries and rate-limit handling tested.                                         |
| M2-03 | Local endpoint support (Ollama / LM Studio)                                                                | P1       | M2        | M2-02            | Implemented | packages/provider-adapters       | Works against a local runtime when available; skipped (not faked) otherwise.                       |
| M2-04 | Model registry with manual model config; no hardcoded model names                                          | P0       | M2        | M2-01            | Completed   | packages/model-registry          | Registry loads user config; tests cover custom endpoints.                                          |
| M2-05 | Model discovery + unavailable-provider handling + fallback                                                 | P1       | M2        | M2-04            | Completed   | packages/model-registry          | Simulated outage marks provider unavailable; fallback tested.                                      |
| M2-06 | Pricing and capability metadata (context window, tools, structured output, vision, reasoning)              | P1       | M2        | M2-04            | Completed   | packages/model-registry          | Metadata sourced/refreshable; missing data represented as unknown, not guessed.                    |
| M2-07 | Real execution on ≥2 independent providers with user-supplied keys                                         | P0       | M2        | M2-02, BYOK keys | Blocked     | packages/provider-adapters       | Opt-in test run with real credentials recorded. Will be Blocked until keys are provided (ADR-011). |
| M2-08 | Credential isolation: keys read only by adapters, never in task context/logs                               | P0       | M2        | M2-01            | Completed   | packages/provider-adapters, core | Tests assert keys absent from context, logs, results.                                              |

## M3 — Intelligent Model Routing

| ID    | Description                                                                              | Priority | Milestone | Dependencies | Status      | Component                            | Acceptance criteria                                                            |
| ----- | ---------------------------------------------------------------------------------------- | -------- | --------- | ------------ | ----------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| M3-01 | Task complexity and required-capability evaluation                                       | P0       | M3        | M1-01        | Not Started | packages/model-router                | Fixture tasks classified; reasons recorded.                                    |
| M3-02 | Capability filter (drop models lacking mandatory capabilities)                           | P0       | M3        | M2-04, M3-01 | Not Started | packages/model-router                | Unit tests for each capability dimension.                                      |
| M3-03 | Cost estimation per task per candidate model                                             | P0       | M3        | M2-06, M3-01 | Not Started | packages/model-router                | Estimates computed from registry pricing; labeled as estimates.                |
| M3-04 | Select cheapest model above reliability threshold (uses historical success when present) | P0       | M3        | M3-02, M3-03 | Not Started | packages/model-router                | Simple task → cheap model, complex → stronger model; per-task, not per-prompt. |
| M3-05 | Routing explanation log                                                                  | P1       | M3        | M3-04        | Not Started | packages/model-router, observability | Every decision has a readable reason and candidate list.                       |
| M3-06 | Policies: Economy / Balanced / Quality / Custom                                          | P1       | M3        | M3-04        | Not Started | packages/model-router                | Same task set routes differently per policy (tested).                          |

## M4 — Adaptive Execution

| ID    | Description                                                                                                | Priority | Milestone | Dependencies | Status      | Component                            | Acceptance criteria                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------- | -------- | --------- | ------------ | ----------- | ------------------------------------ | ---------------------------------------------------------------------- |
| M4-01 | Escalation trigger detection (repeated failure, unmet criteria, low confidence, tool errors, token blowup) | P0       | M4        | M1-05, M3-04 | Not Started | packages/escalation                  | Simulated failures trigger escalation (spec §17 Test 3).               |
| M4-02 | Reassignment with context transfer (findings preserved)                                                    | P0       | M4        | M4-01, M1-07 | Not Started | packages/escalation, context-manager | Escalated task receives prior findings; unrelated tasks not restarted. |
| M4-03 | Bounded retries, escalation limits, budget constraints                                                     | P0       | M4        | M4-01        | Not Started | packages/escalation                  | Loop bound enforced in tests.                                          |
| M4-04 | Downgrade rules after plan/investigation completes                                                         | P1       | M4        | M4-02        | Not Started | packages/escalation                  | Downgrade observed in scripted scenario; avoids needless switching.    |
| M4-05 | Failure recovery: timeout, rate limit, outage, invalid output (spec §17 Test 6)                            | P1       | M4        | M2-05, M4-03 | Not Started | packages/agent-runtime               | Each failure simulated; state preserved; workflow resumes.             |
| M4-06 | Task and workflow cancellation                                                                             | P1       | M4        | M1-05        | Not Started | packages/agent-runtime               | Cancel one task / whole run; no orphaned work.                         |

## M5 — Codebase Integration and Safety

| ID    | Description                                                                       | Priority | Milestone | Dependencies | Status      | Component                             | Acceptance criteria                                                             |
| ----- | --------------------------------------------------------------------------------- | -------- | --------- | ------------ | ----------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| M5-01 | Git worktree isolation per writing task                                           | P0       | M5        | M1-05        | Not Started | packages/integrations                 | Parallel tasks write in separate worktrees of a fixture repo; cleanup verified. |
| M5-02 | File-conflict detection across task diffs                                         | P0       | M5        | M5-01        | Not Started | packages/integrations                 | Overlapping edits detected and reported.                                        |
| M5-03 | Patch integration into the main working tree                                      | P0       | M5        | M5-02        | Not Started | packages/integrations                 | Non-conflicting patches merged; conflicts surfaced, not dropped.                |
| M5-04 | Validation runner (tests, typecheck, lint where available) against real diffs     | P0       | M5        | M5-03        | Not Started | packages/integrations                 | Completion requires evidence; failing validation marks task incomplete.         |
| M5-05 | Honest consolidated report incl. incomplete work                                  | P1       | M5        | M5-04        | Not Started | packages/integrations, observability  | Report lists incomplete/failed tasks explicitly.                                |
| M5-06 | Per-task and total cost display (estimate vs actual), including escalations       | P1       | M5        | M1-09, M2-01 | Not Started | packages/observability                | Totals match provider usage metadata in tests.                                  |
| M5-07 | Capability benchmark feedback loop (record per-model task outcomes, feed routing) | P1       | M5        | M3-04, M5-04 | Not Started | packages/observability, model-router  | Outcomes stored locally and influence later routing (tested).                   |
| M5-08 | Permission-aware execution, command controls, destructive-op approval, audit log  | P0       | M5        | M5-01        | Not Started | packages/agent-runtime, observability | Host harness permissions never bypassed; audit log written.                     |
| M5-09 | Untrusted tool output / prompt-injection handling                                 | P1       | M5        | M5-08        | Not Started | packages/context-manager              | Injection fixtures do not escalate permissions.                                 |

## M6 — Universal Skill and CLI

| ID    | Description                                                          | Priority | Milestone | Dependencies   | Status      | Component                 | Acceptance criteria                                                    |
| ----- | -------------------------------------------------------------------- | -------- | --------- | -------------- | ----------- | ------------------------- | ---------------------------------------------------------------------- |
| M6-01 | CLI: `orchestrator` commands run, models, status, config, cost, stop | P1       | M6        | M5             | Not Started | apps/cli                  | Each command works against fixtures; `run` executes the full workflow. |
| M6-02 | Universal agent skill (`skills/universal-orchestrator/SKILL.md`)     | P1       | M6        | M6-01          | Not Started | skills/                   | Installable; host agent delegates to engine.                           |
| M6-03 | MCP server exposing orchestration                                    | P1       | M6        | M6-01          | Not Started | packages/harness-adapters | Works with at least one MCP client, tested.                            |
| M6-04 | Claude Code integration                                              | P2       | M6        | M6-02 or M6-03 | Not Started | packages/harness-adapters | Verified end to end in Claude Code before any claim.                   |
| M6-05 | Codex integration                                                    | P2       | M6        | M6-02 or M6-03 | Not Started | packages/harness-adapters | Verified end to end in Codex before any claim.                         |
| M6-06 | Installation, provider, routing, and security docs                   | P1       | M6        | M6-01          | Not Started | docs/                     | Fresh-machine quick start reproduced.                                  |
| M6-07 | Acceptance scenarios spec §17 Tests 1, 2, 4 end to end               | P0       | M6        | M6-01, M2-07   | Not Started | tests/                    | Recorded runs; Test 4 needs ≥2 real providers (BYOK).                  |
| M6-08 | Cost comparison benchmark (spec §17 Test 5)                          | P2       | M6        | M6-07          | Not Started | tests/, observability     | Savings claimed only from measured data.                               |

## M7 — IDE Extensions (post-MVP)

| ID    | Description                                                                               | Priority | Milestone | Dependencies | Status      | Component             | Acceptance criteria                    |
| ----- | ----------------------------------------------------------------------------------------- | -------- | --------- | ------------ | ----------- | --------------------- | -------------------------------------- |
| M7-01 | VS Code extension: task graph, agents, models, escalations, cost, cancel (UI per ADR-009) | P3       | M7        | M6           | Not Started | apps/vscode-extension | Functional in VS Code; core unchanged. |
| M7-02 | Cursor compatibility                                                                      | P3       | M7        | M7-01        | Not Started | extensions/cursor     | Verified individually.                 |
| M7-03 | Windsurf compatibility                                                                    | P3       | M7        | M7-01        | Not Started | extensions/windsurf   | Verified individually.                 |
| M7-04 | Kilo Code compatibility                                                                   | P3       | M7        | M7-01        | Not Started | extensions/kilo       | Verified individually.                 |
