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

| ID    | Description                                                                                            | Priority | Milestone | Dependencies             | Status    | Component                                   | Acceptance criteria                                                                                                                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------ | -------- | --------- | ------------------------ | --------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0-01 | Initialize local git repository (no remote)                                                            | P0       | M0        | —                        | Completed | repo                                        | `git log` shows commits by Sweed; `git remote` is empty; specs committed intact.                                                                                                                                                                                                                               |
| M0-02 | pnpm workspace with `apps/cli` + 12 `packages/*` per spec §15                                          | P0       | M0        | M0-01                    | Completed | repo                                        | `pnpm install --frozen-lockfile` succeeds; every package builds and tests via `pnpm --filter`.                                                                                                                                                                                                                 |
| M0-03 | Strict TypeScript, project references, no-emit typecheck                                               | P0       | M0        | M0-02                    | Completed | tsconfig.*                                  | `pnpm run typecheck` and `pnpm run build` exit 0; `dist/` produced per package.                                                                                                                                                                                                                                |
| M0-04 | ESLint (type-checked) + Prettier                                                                       | P0       | M0        | M0-03                    | Completed | eslint.config.js, .prettierrc.json          | `pnpm run lint` (zero warnings) and `pnpm run format:check` exit 0.                                                                                                                                                                                                                                            |
| M0-05 | Vitest with real smoke tests                                                                           | P0       | M0        | M0-03                    | Completed | vitest.config.ts, tests/                    | `pnpm run test` runs per-package and repo tests; tests fail when the guarded property breaks.                                                                                                                                                                                                                  |
| M0-06 | Environment configuration (`.env.example`, `parseEnv`, docs)                                           | P1       | M0        | M0-03                    | Completed | packages/core, docs/guides/configuration.md | No secrets in `.env.example` (tested); `SOOT_*` vars documented (tested); `parseEnv` unit-tested.                                                                                                                                                                                                              |
| M0-07 | Basic docs: README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, architecture, configuration, development  | P1       | M0        | M0-02                    | Completed | docs/                                       | README states foundation-only status; architecture lists every package (tested).                                                                                                                                                                                                                               |
| M0-08 | CI: GitHub Actions workflow + equivalent `scripts/ci.sh`                                               | P0       | M0        | M0-03, M0-04, M0-05      | Completed | .github/workflows, scripts/ci.sh            | `pnpm run ci` passes locally; workflow and script contain the same steps (tested).                                                                                                                                                                                                                             |
| M0-09 | License MIT                                                                                            | P1       | M0        | M0-01                    | Completed | LICENSE                                     | MIT text with agreed copyright line; all manifests say MIT (tested); ADR-005.                                                                                                                                                                                                                                  |
| M0-10 | Tracking files (PROJECT_STATUS, ROADMAP, TASKS, DECISIONS, TECHNICAL_DEBT, FUTURE_FEATURES, CHANGELOG) | P1       | M0        | —                        | Completed | repo root                                   | All exist (tested); contents follow PM spec §5.                                                                                                                                                                                                                                                                |
| M0-11 | First hosted GitHub Actions run                                                                        | P2       | M0        | M0-08, publish (ADR-032) | Completed | .github/workflows                           | Workflow passes on GitHub for Node 24 and 26. Evidence: [run 43334786373](https://github.com/josephcake/soot/actions/runs/43334786373) on `8a38865` (success, 2026-11-12 4:09–4:11 PM PT); earlier [run 43329225136](https://github.com/josephcake/soot/actions/runs/43329225136) on `30aaf29` also succeeded. |

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
`tests/m1-end-to-end.test.ts`. Limits of what "Completed" means here: see `docs/project/TECHNICAL_DEBT.md`
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

> Status: **Completed (verified locally with a fictional registry and the spec fixture prompts)**,
> 2026-11-12. Complexity evaluation is heuristic (ADR-023). Routing calls no model, so real
> providers are not needed for these exit criteria; using the routes for real calls still
> depends on M2-07 (Blocked). Evidence: `packages/model-router/src/*.test.ts`,
> `packages/observability/src/routing-log.test.ts`, `tests/m3-routing-end-to-end.test.ts`.

| ID    | Description                                                                              | Priority | Milestone | Dependencies | Status    | Component                            | Acceptance criteria                                                            |
| ----- | ---------------------------------------------------------------------------------------- | -------- | --------- | ------------ | --------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| M3-01 | Task complexity and required-capability evaluation                                       | P0       | M3        | M1-01        | Completed | packages/model-router                | Fixture tasks classified; reasons recorded.                                    |
| M3-02 | Capability filter (drop models lacking mandatory capabilities)                           | P0       | M3        | M2-04, M3-01 | Completed | packages/model-router                | Unit tests for each capability dimension.                                      |
| M3-03 | Cost estimation per task per candidate model                                             | P0       | M3        | M2-06, M3-01 | Completed | packages/model-router                | Estimates computed from registry pricing; labeled as estimates.                |
| M3-04 | Select cheapest model above reliability threshold (uses historical success when present) | P0       | M3        | M3-02, M3-03 | Completed | packages/model-router                | Simple task → cheap model, complex → stronger model; per-task, not per-prompt. |
| M3-05 | Routing explanation log                                                                  | P1       | M3        | M3-04        | Completed | packages/model-router, observability | Every decision has a readable reason and candidate list.                       |
| M3-06 | Policies: Economy / Balanced / Quality / Custom                                          | P1       | M3        | M3-04        | Completed | packages/model-router                | Same task set routes differently per policy (tested).                          |

## M4 — Adaptive Execution

> Status: **Completed (verified locally with mock agents and a fictional registry)**,
> 2026-11-12. Signals come from agent self-report until Milestone 5 checks evidence (ADR-024).
> Running escalated tasks on real providers still depends on M2-07 (Blocked). Evidence:
> `packages/escalation/src/*.test.ts`, `packages/agent-runtime/src/scheduler-attempts.test.ts`,
> `packages/context-manager/src/execution-store.test.ts`, `tests/m4-adaptive-end-to-end.test.ts`.

| ID    | Description                                                                                                | Priority | Milestone | Dependencies | Status    | Component                            | Acceptance criteria                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------- | -------- | --------- | ------------ | --------- | ------------------------------------ | ---------------------------------------------------------------------- |
| M4-01 | Escalation trigger detection (repeated failure, unmet criteria, low confidence, tool errors, token blowup) | P0       | M4        | M1-05, M3-04 | Completed | packages/escalation                  | Simulated failures trigger escalation (spec §17 Test 3).               |
| M4-02 | Reassignment with context transfer (findings preserved)                                                    | P0       | M4        | M4-01, M1-07 | Completed | packages/escalation, context-manager | Escalated task receives prior findings; unrelated tasks not restarted. |
| M4-03 | Bounded retries, escalation limits, budget constraints                                                     | P0       | M4        | M4-01        | Completed | packages/escalation                  | Loop bound enforced in tests.                                          |
| M4-04 | Downgrade rules after plan/investigation completes                                                         | P1       | M4        | M4-02        | Completed | packages/escalation                  | Downgrade observed in scripted scenario; avoids needless switching.    |
| M4-05 | Failure recovery: timeout, rate limit, outage, invalid output (spec §17 Test 6)                            | P1       | M4        | M2-05, M4-03 | Completed | packages/agent-runtime               | Each failure simulated; state preserved; workflow resumes.             |
| M4-06 | Task and workflow cancellation                                                                             | P1       | M4        | M1-05        | Completed | packages/agent-runtime               | Cancel one task / whole run; no orphaned work.                         |

## M5 — Codebase Integration and Safety

> Status: **Completed (verified locally on real fixture git repositories with mock agents)**,
> 2026-11-12. soot runs the checks itself on each task's real diff; agent self-report is never
> evidence (ADR-018, ADR-025). Real-model diffs depend on M2-07 (Blocked) and M6 runners.
> Evidence: `tests/m5-codebase-end-to-end.test.ts`, `packages/integrations/src/*.test.ts`,
> `packages/observability/src/audit-cost-report.test.ts`,
> `packages/context-manager/src/untrusted.test.ts`, `packages/agent-runtime/src/permissions.test.ts`.

| ID    | Description                                                                       | Priority | Milestone | Dependencies | Status    | Component                             | Acceptance criteria                                                             |
| ----- | --------------------------------------------------------------------------------- | -------- | --------- | ------------ | --------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| M5-01 | Git worktree isolation per writing task                                           | P0       | M5        | M1-05        | Completed | packages/integrations                 | Parallel tasks write in separate worktrees of a fixture repo; cleanup verified. |
| M5-02 | File-conflict detection across task diffs                                         | P0       | M5        | M5-01        | Completed | packages/integrations                 | Overlapping edits detected and reported.                                        |
| M5-03 | Patch integration into the main working tree                                      | P0       | M5        | M5-02        | Completed | packages/integrations                 | Non-conflicting patches merged; conflicts surfaced, not dropped.                |
| M5-04 | Validation runner (tests, typecheck, lint where available) against real diffs     | P0       | M5        | M5-03        | Completed | packages/integrations                 | Completion requires evidence; failing validation marks task incomplete.         |
| M5-05 | Honest consolidated report incl. incomplete work                                  | P1       | M5        | M5-04        | Completed | packages/integrations, observability  | Report lists incomplete/failed tasks explicitly.                                |
| M5-06 | Per-task and total cost display (estimate vs actual), including escalations       | P1       | M5        | M1-09, M2-01 | Completed | packages/observability                | Totals match provider usage metadata in tests.                                  |
| M5-07 | Capability benchmark feedback loop (record per-model task outcomes, feed routing) | P1       | M5        | M3-04, M5-04 | Completed | packages/observability, model-router  | Outcomes stored locally and influence later routing (tested).                   |
| M5-08 | Permission-aware execution, command controls, destructive-op approval, audit log  | P0       | M5        | M5-01        | Completed | packages/agent-runtime, observability | Host harness permissions never bypassed; audit log written.                     |
| M5-09 | Untrusted tool output / prompt-injection handling                                 | P1       | M5        | M5-08        | Completed | packages/context-manager              | Injection fixtures do not escalate permissions.                                 |

## M6 — Universal Skill and CLI

| ID    | Description                                                        | Priority | Milestone | Dependencies   | Status      | Component                 | Acceptance criteria                                                     |
| ----- | ------------------------------------------------------------------ | -------- | --------- | -------------- | ----------- | ------------------------- | ----------------------------------------------------------------------- |
| M6-01 | CLI: `soot` commands run, models, status, config, cost, stop       | P1       | M6        | M5             | Completed   | apps/cli                  | Each command works against fixtures; `run` executes the full workflow.  |
| M6-02 | Universal agent skill (`skills/universal-orchestrator/SKILL.md`)   | P1       | M6        | M6-01          | Implemented | skills/                   | Installable; host agent delegates to engine.                            |
| M6-03 | MCP server exposing orchestration                                  | P1       | M6        | M6-01          | Completed   | packages/harness-adapters | Works with at least one MCP client, tested.                             |
| M6-04 | Claude Code integration                                            | P2       | M6        | M6-02 or M6-03 | Not Started | packages/harness-adapters | Verified end to end in Claude Code before any claim.                    |
| M6-05 | Codex integration                                                  | P2       | M6        | M6-02 or M6-03 | Not Started | packages/harness-adapters | Verified end to end in Codex before any claim.                          |
| M6-06 | Installation, provider, routing, and security docs                 | P1       | M6        | M6-01          | Implemented | docs/                     | Fresh-machine quick start reproduced.                                   |
| M6-07 | Acceptance scenarios spec §17 Tests 1, 2, 4 end to end             | P0       | M6        | M6-01, M2-07   | Blocked     | tests/                    | Recorded runs; Test 4 needs ≥2 real providers (BYOK).                   |
| M6-08 | Cost comparison benchmark (spec §17 Test 5)                        | P2       | M6        | M6-07          | Not Started | tests/, observability     | Savings claimed only from measured data.                                |
| M6-09 | Generic ACP driver (soot as ACP client) and `soot run --agent acp` | P1       | M6        | M6-01          | Completed   | packages/harness-adapters | Tested against soot's own mock ACP agent only; no vendor agent claimed. |

M6 notes (2026-11-12, ADR-026):

- **M6-01 Completed:** `soot run|models|status|config|cost|stop` (plus `install-skill`, `mcp`)
  work against fixtures; `run` executes the full M1–M5 workflow with the scripted mock agent
  (`tests/m6-cli-end-to-end.test.ts`, `tests/m6-cli-subprocess.test.ts`). The binary is `soot`,
  not `orchestrator` (project rename). Without `--agent mock` it refuses: no real runner exists.
- **M6-02 Implemented:** the skill exists and installs into `.agents/skills`, `.claude/skills`
  and `.grok/skills` (tested in temp directories only). "Host agent delegates to engine" is not
  verified in any real host agent.
- **M6-03 Completed:** `soot mcp` (stdio) and `createSootMcpServer`, tested with the official MCP
  SDK client in process and over stdio against the built binary. Not verified inside any
  product. Runs over MCP are unattended (approvals refused).
- **M6-04 / M6-05 Not Started:** `HARNESS_SUPPORT` lists them as `not-implemented`,
  `verifiedEndToEnd: false`. The generic ACP driver (M6-09) is the intended way they would
  connect later (through an ACP mode or adapter the user installs and signs in to), but neither
  has been run, so nothing is claimed.
- **M6-06 Implemented:** `docs/guides/installation.md`, `docs/guides/providers.md`, `docs/guides/model-routing.md`,
  `docs/guides/security.md`. The keyless quick start was reproduced step by step from a fresh local clone
  in a temp directory on the build box, not on a separate fresh machine.
- **M6-07 Blocked (on M2-07):** fixture-backed CLI runs of Tests 1, 2 and the Test 4 graph
  shape pass with the mock agent, but they are not the recorded real runs the criterion asks
  for, and Test 4 needs ≥2 real providers.
- **M6-08 Not Started:** no savings are claimed without measured runs.
- **M6-09 Completed (ADR-027):** `AcpAgentRunner` drives any ACP agent over the stable ACP v1
  protocol (official `@agentclientprotocol/sdk`), one session per attempt in the task's
  worktree. Permission requests go to soot's approval gate only (unattended → rejected, task
  refused, independent tasks continue; approved → "allow once" only). `soot run --agent acp`
  spawns only the `acpAgent` command the user configured. Tested only with soot's own mock ACP
  agent, in process (`packages/harness-adapters/src/acp/runner.test.ts`) and spawned over stdio
  by the CLI (`tests/m6-acp-end-to-end.test.ts`). No vendor binary was run. ADR-028 adds the
  routed model through the agent's `model` session option when offered, and "route not applied"
  records otherwise (mock agent only).

## M7 — IDE Extensions

| ID    | Description                                                              | Priority | Milestone | Dependencies | Status      | Component                  | Acceptance criteria                                                                |
| ----- | ------------------------------------------------------------------------ | -------- | --------- | ------------ | ----------- | -------------------------- | ---------------------------------------------------------------------------------- |
| M7-01 | VS Code extension (thin adapter over the soot CLI)                       | P2       | M7        | M6-01        | Verified    | apps/vscode-extension      | Loaded and used in a real VS Code; core orchestration stays outside the extension. |
| M7-02 | Cursor compatibility                                                     | P2       | M7        | M7-01        | Not Started | apps/vscode-extension      | Verified individually in a real Cursor before any claim.                           |
| M7-03 | Windsurf compatibility                                                   | P3       | M7        | M7-01        | Not Started | apps/vscode-extension      | Verified individually in a real Windsurf before any claim.                         |
| M7-04 | Kilo Code compatibility                                                  | P3       | M7        | M7-01        | Not Started | apps/vscode-extension      | Verified individually in a real Kilo Code before any claim.                        |
| M7-05 | Task visualization: task graph by layer, active agents, execution status | P2       | M7        | M7-01        | Verified    | apps/vscode-extension      | Graph and status match the engine's `soot status` for a run.                       |
| M7-06 | Model assignment visibility: models per attempt, escalation/retry events | P2       | M7        | M7-01        | Implemented | apps/vscode-extension, cli | Each attempt's model and each escalation shown as the engine recorded them.        |
| M7-07 | Cost reporting: estimate and actual, per run                             | P2       | M7        | M7-01        | Verified    | apps/vscode-extension      | Same numbers as `soot cost`; estimates and actuals never mixed.                    |
| M7-08 | Task cancellation and orchestration on/off from the IDE (`stop --task`)  | P2       | M7        | M7-01        | Verified    | apps/vscode-extension, cli | Cancelling one task skips its dependents; other tasks continue.                    |

M7 notes (2026-11-12, ADR-029; real-editor run 2026-11-14, ADR-041):

- **M7-01 Verified in VS Code (2026-11-14):** `apps/vscode-extension` (`soot-vscode`, private,
  unpublished) is an ESM extension for VS Code ^1.100 with no runtime dependencies. It runs the
  soot CLI (`run`, `status`, `cost`, `stop`, all `--json`) and imports no soot package. Unit
  tests use a fake `vscode` module (`src/test-support/fake-vscode.ts`) and the real built CLI
  with `--agent mock` (`tests/m7-vscode-extension.test.ts`). A `.vsix` builds locally (`pnpm
--filter soot-vscode package:vsix`, `vsce package` through `pnpm dlx`, never `publish`). The
  `.vsix` was installed with `code --install-extension` in **VS Code 1.144.0 on macOS** and used
  on a copy of `examples/demo-app` with `soot.agent: mock`: the soot view appeared in the
  Explorer, Enable turned it on, Run a prompt ran both Test 1 tasks to verified on
  `anthropic/claude-haiku-5-5`, and the run ended incomplete only because nobody approved the
  working-tree update (as designed). **Found:** Enable wrote `"soot.enabled": true` to
  `.vscode/settings.json`, a tracked file, so the next run was refused ("working tree … has
  uncommitted changes"); fixed by ADR-041 and re-run in the editor the same day (see M7-08).
  The fake `vscode` module never wrote files, which is why the unit tests missed it.
- **M7-05 and M7-07 Verified in VS Code:** for run `ide-20261114-081608-7c21` the tree and board
  showed the same tasks, states, verdicts and models as `soot status`, and the same estimate
  ($0.000750) and actual ($0.001630, mock usage) as `soot cost`. The sidebar truncates long
  labels; the board shows them in full.
- **M7-02…M7-04 Not Started:** nothing is claimed for Cursor, Windsurf or Kilo Code (or GitHub
  Copilot). Each needs its own run in that editor.
- **M7-05…M7-07:** the tree view and the plain-text board show what `soot status <run>` and
  `soot cost <run>` report: task graph by layer, per-attempt models, escalation level and
  failures, escalate/retry/fallback/downgrade events (from the run's new
  `reports/<run>.events.jsonl`), estimate vs actual cost. Text blocks only (ADR-009). **M7-06
  stays Implemented:** per-attempt models showed correctly in VS Code, but no mock run escalated
  or retried, so escalation events were not seen in the editor.
- **M7-08 Verified in VS Code (cancel, stop and on/off):** `soot stop <run> --task <id>` (and MCP
  `soot_stop` with `taskId`) cancels one task through the scheduler; its dependents are skipped
  and other tasks continue. In VS Code, right-click **Cancel task** cancelled both tasks of run
  `ide-20261114-082748-f749` (`cancelled by request`) and right-click **Stop run** cancelled run
  `ide-20261114-083954-69c4` (`run cancelled`). "Other tasks continue" was checked from the CLI
  on the same build (`cli-cancel-test`); "dependents are skipped" was not exercised in the
  editor. The ADR-041 on/off fix was re-run in VS Code 1.144.0 on 2026-11-14: after
  **Developer: Reload Window**, Disable then Enable left `git status` clean and
  `.vscode/settings.json` unchanged, and VS Code's workspace storage held
  `{"soot.enabled":true}`. Runs started from the IDE are unattended: approvals are refused,
  never given.

## Planner: model-backed decomposition (cross-cutting, ADR-033)

Follows up M1-03's "LLM-backed decomposer after M2". This row does not change any milestone
status and does not depend on M2-07 for its mock-only scope.

| ID   | Description                                                                                | Priority | Milestone | Dependencies | Status      | Component        | Acceptance criteria                                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------ | -------- | --------- | ------------ | ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-01 | Model-backed decomposer behind `Decomposer`, over `ModelClient`; fixtures stay the default | P1       | — (cross) | M1-03, M2-01 | Implemented | packages/planner | Unknown prompts decompose via a mock client into a validated graph; malformed or invalid output fails with `ModelDecompositionError`; no client means fixture-only with no network; recorded prompts never call the model. Verified with mocks only; real-model use waits on M2-07.         |
| P-02 | Optional `decomposer.model` in `soot.config.json`, wired into the CLI/MCP engine (ADR-034) | P1       | — (cross) | P-01, M6-01  | Implemented | apps/cli         | Absent: fixture-only, unchanged; usable model: unknown prompts go to it, recorded prompts make zero model calls; unknown ref or missing key: no client, no network, recorded prompts work, unknown prompts fail naming the setting; `soot config` shows status without secrets. Mocks only. |

Planner notes (2026-11-12):

- **P-01:** `packages/planner/src/model-decomposer.ts`; tests in
  `packages/planner/src/model-decomposer.test.ts` (mock clients via `createMockModelClient` and
  hand-written `ModelClient` doubles; `fetch` replaced by a spy that fails on any call). Status
  is Implemented, not Verified: no real model has produced a decomposition, the prompt is
  untuned. The CLI/MCP wiring it lacked is P-02.
- **P-02:** `apps/cli/src/config.ts` (`DecomposerConfigSchema`), `apps/cli/src/decomposer-model.ts`
  (resolution: `not-configured` / `usable` / `unusable`), `apps/cli/src/engine.ts` (run and
  `soot config`); tests in `tests/p02-decomposer-config.test.ts` and
  `apps/cli/src/config.test.ts` (mock clients through an injected `modelClientFactory`, a fake
  key string only to prove a client can be built and is never printed or called; `fetch`
  replaced by a spy that fails on any call). Implemented, not Verified: no real model has
  decomposed a prompt (M2-07 Blocked).
- **DeepSeek (ADR-035, 2026-11-12):** the ADR-016 hold is lifted, so a user-configured DeepSeek
  provider can be the decomposer model. That removes a policy refusal only; P-01/P-02 stay
  Implemented, not Verified, until a real model has decomposed a prompt.

## Optional local dashboard (cross-cutting, ADR-031)

A new optional local surface, not a milestone. This row does not change any milestone status.

| ID   | Description                                                                                   | Priority | Milestone | Dependencies | Status      | Component                | Acceptance criteria                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------- | -------- | --------- | ------------ | ----------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | `soot dashboard`: simple local page + read-only JSON API for spec §12 fields                  | P3       | — (cross) | M6-01        | Implemented | apps/dashboard, apps/cli | Binds 127.0.0.1 only (tested on the socket); opt-in, lazy-loaded; headless commands never load it; unknowns stay null.                                      |
| D-02 | Dashboard charts: usage by model/task/runner; prompt → task → model assignment view           | P3       | — (cross) | D-01         | Implemented | apps/dashboard, apps/cli | Estimates and actuals in separate charts; unknown shown as unknown; transitions shown per task.                                                             |
| D-03 | Dashboard palette (black/orange/cream) and more chart types (donut, meter, stacked, timeline) | P3       | — (cross) | D-02         | Implemented | apps/dashboard           | Zero slices omitted; null rate n/a with no fill; estimates and actuals never share a chart; no zero-length bar for an unknown or running end.               |
| D-04 | Center canvas (tasks→models across all prompts) and previous-prompts detail                   | P3       | — (cross) | D-03         | Implemented | apps/dashboard           | Hand-drawn canvas, no chart library; biggest share prominent; prompt list newest first; per-task tokens from the cost report or an explicit unknown reason. |

Dashboard notes (2026-11-12):

- **D-01:** Implemented and tested locally against mock runs only (no real model has produced
  data). Not run by anyone in a desktop browser session; a headless Chrome screenshot of a mock
  run was checked on the build box. Tests: `apps/dashboard/src/view.test.ts`,
  `apps/dashboard/src/server.test.ts`, `tests/dashboard.test.ts`.
- **D-02:** chart blocks on the same page and API (ADR-031 amendment), CSS bars and plain DOM.
  Mock runs only; checked by tests (including the page script against a fake DOM) and a
  headless Chrome screenshot of an escalated mock run. Tests: `apps/dashboard/src/charts.test.ts`,
  `apps/dashboard/src/ui.test.ts`, `apps/dashboard/src/view.test.ts`, `tests/dashboard.test.ts`.
- **D-03:** palette and chart types per the ADR-031 amendment; page script only, no API or
  dependency change. Mock runs only; checked by `apps/dashboard/src/ui.test.ts` (fake DOM) and a
  headless Chrome screenshot of an escalated mock run. Not looked at in a desktop browser by
  anyone yet.
- **D-04:** aggregate canvas and previous-prompts list, from the same status/cost data (the
  list endpoint now also loads each run to build `overview`). Per-task tokens are the cost
  report's attempt usage when complete; otherwise the page says they were not reported. Runner
  is the run-level agent label (soot does not record a per-task agent). Mock runs only;
  checked by `overview.test.ts`, `ui.test.ts`, `view.test.ts`, `server.test.ts` and a headless
  screenshot of several mock runs. Not looked at in a desktop browser by anyone yet.

## Engine hardening (cross-cutting, ADR-030)

Prepares the engine for real keys or a real harness; nothing here uses either. These rows do
not change any milestone status.

| ID   | Description                                                          | Priority | Milestone  | Dependencies | Status      | Component                                        | Acceptance criteria                                                                     |
| ---- | -------------------------------------------------------------------- | -------- | ---------- | ------------ | ----------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| H-01 | `SOOT_DATA_DIR` / `SOOT_LOG_LEVEL` honoured by the real CLI and MCP  | P1       | M6 (cross) | M0-04, M6-01 | Completed   | core, apps/cli                                   | Real `soot` and `soot mcp` processes change state dir and log output by variable.       |
| H-02 | Provider health and run-budget spend persisted in `soot.sqlite`      | P1       | M4 (cross) | M4-05        | Completed   | model-registry, context-manager, escalation, cli | A restarted process skips a down provider until cooldown; budget rebuilt from attempts. |
| H-03 | Routed estimates in cost records; routing decisions in the audit log | P1       | M3/M5 (x)  | M3-03, M5-08 | Completed   | observability, cli                               | Estimates on records without fabricated actuals; every decision audited.                |
| H-04 | Default attempt timeout (30 min), explicit `attemptTimeoutMs` wins   | P1       | M4 (cross) | M4-05        | Completed   | agent-runtime, cli, docs                         | A hung runner without a configured timeout still ends; explicit value wins; documented. |
| H-05 | Sideload note for the unpublished `.vsix` (VS Code, Cursor)          | P3       | M7         | M7-01        | Implemented | apps/vscode-extension                            | Clearly marked unverified; does not complete M7-01 or M7-02.                            |

Hardening notes (2026-11-12):

- **H-01:** `runtimeFromEnv` (apps/cli) wraps `parseEnv`; `createLogger` (core) applies the level.
  Tests: `tests/hardening-cli.test.ts` (built binary and `soot mcp` over stdio).
- **H-02:** tables `provider_cooldowns` and `attempt_spend` (schema v4). Tests:
  `tests/hardening-restart.test.ts` (store reopened, new `ProviderHealth`/supervisor/scheduler),
  and a two-process `soot run` test in `tests/hardening-cli.test.ts`.
- **H-03:** `costRecordsFromAttempts` and `recordRoutedEstimate` (observability); audit types
  `routing-decision` and `model-route`. Routing history is still credited only where the route
  was applied (ADR-028 for ACP). Tests: `packages/observability/src/cost.test.ts`,
  `tests/hardening-cli.test.ts`.
- **H-04:** `DEFAULT_ATTEMPT_TIMEOUT_MS` in `@soot/agent-runtime`; the ACP 2 s cancel cutoff is
  unchanged. Tests: `packages/agent-runtime/src/scheduler-attempts.test.ts` (fake timers).
- **H-05:** `apps/vscode-extension/README.md#sideloading-the-local-build-unverified`. M7-01 and
  M7-02 stay as they were.
