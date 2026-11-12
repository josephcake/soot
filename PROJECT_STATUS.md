# Project Status

Last Updated: 2026-11-12

## Current Phase

Milestone 6 — Universal Skill and CLI (in progress, partial: CLI, MCP server, skill and docs against fixtures and a scripted mock agent; exit criteria not met); Milestone 2 In Progress (partial; M2-07 Blocked)

## Overall Progress

5 / 8 milestones completed (M0, M1, M3, M4, M5 verified locally; M2 and M6 in progress, partial; M7 not started)

## Current Status

Milestone 6 is In Progress (partial, ADR-026). The `soot` CLI (`run`, `models`, `status`,
`config`, `cost`, `stop`, `install-skill`, `mcp`) runs the full workflow on a real git
repository from one prompt, but only for **recorded prompts** and with the **scripted mock
agent** (`--agent mock`); every run says so. The MCP server exposes the same service and is
tested with the official MCP SDK client (in process and over stdio). The universal skill
installs into `.agents`, `.claude` and `.grok` skill folders. Installation, provider, routing and
security docs exist; the keyless quick start was reproduced from a fresh clone on the build box.
A generic ACP driver (ADR-027) lets `soot run --agent acp` run each task through the
ACP agent command the user configures, with permission requests answered only by a person
(unattended: rejected, the task refused, independent tasks continue). When the agent advertises a `model` session option, soot applies the routed model per attempt;
otherwise it reports "route not applied" (ADR-028). It is tested only against soot's own mock
ACP agent. Not done: no vendor harness has been run (Claude Code
M6-04, Codex M6-05: not claimed), no real provider (M2-07 Blocked), so M6-07 (real recorded acceptance runs) is Blocked and M6-08 not started. M5
gained protected paths: a task that edits a protected file (such as its acceptance test) fails
even inside its lease.

Milestone 5 is Completed and verified locally on real temporary git repositories, with real
`node --test`, `tsc` and lint commands run by soot itself and mock agents that write files (no
model is called). Each writing task runs in its own worktree under a write lease; soot reads the
real diff, runs the checks, and marks a task Verified only from that evidence. Verified work is
integrated serially with a merge-tree dry run; conflicts are surfaced with their branch kept;
the user's working tree moves only by fast-forward after final validation and explicit
approval. The consolidated report lists incomplete work first and shows cost estimates and
actuals separately. Approvals are never automatic; everything is audited (ADR-025). This is
not a finished product: harness runners are Milestone 6 and real providers wait on M2-07.

Milestone 4 is Completed and verified locally with mock agents, the fictional routing registry
and the spec's fixture prompts (§17 Tests 3 and 6). Failed or doubtful work escalates mid-flight
to a stronger model with its findings; unrelated tasks are not restarted; retries, escalations
and spend are bounded; dependents of a finished investigation are downgraded when it saves
enough; timeouts, rate limits, outages, crashes and invalid output recover with state preserved
in SQLite; a task or a whole run cancels cleanly (ADR-024). Triggers rely on agents' structured
self-report until Milestone 5 checks evidence.

Milestone 3 (per-task routing, heuristic evaluation, ADR-023) is Completed.

Milestone 2 stays In Progress (partial). Its mockable scope is verified with mocked HTTP. **No
real provider has been called and no real key has been used.** M2-07 is Blocked, so routed
tasks cannot yet run on real providers. Project name `soot` (ADR-013); repo at `/workspace/soot`,
local only.

## Completed

- [x] Milestone 0 — Repository Foundation (M0-01…M0-10)
- [x] M1-01 Task schema + JSON Schema contract (`@soot/task-graph`)
- [x] M1-02 Prompt intake, byte-for-byte prompt preservation (`@soot/planner`)
- [x] M1-03 Decomposer interface + deterministic fixture decomposer (spec §3, §17 Tests 1, 2, 4)
- [x] M1-04 Dependency graph: DAG, cycles, layers, file-conflict serialization, revision
- [x] M1-05 Scheduler: bounded concurrency, dependency ordering, cancellation (`@soot/agent-runtime`)
- [x] M1-06 Structured agent result schema, validated by the scheduler
- [x] M1-07 SQLite execution state under `SOOT_DATA_DIR`; resume after SIGKILL (`@soot/context-manager`)
- [x] M1-08 Mock agent runner (labeled test double)
- [x] M1-09 Per-task cost records, estimates vs actuals separated (`@soot/observability`)

- [x] M2-01 `ModelClient` provider abstraction + mock test double, with a contract suite (`@soot/provider-adapters`)
- [x] M2-02 Anthropic + OpenAI adapters via the AI SDK; mocked HTTP; retries and rate limits tested
- [x] M2-04 Thin model registry from user config, custom endpoints (`@soot/model-registry`)
- [x] M2-05 Discovery, unavailable-provider handling, fallback (simulated outages)
- [x] M2-06 Sourced and dated pricing; capability metadata; unknown stays unknown
- [x] M2-08 Credential isolation, asserted by leak tests and a repo boundary guard
- [x] Milestone 3 — Intelligent Model Routing (M3-01…M3-06), `@soot/model-router`:
  - M3-01 heuristic complexity and capability evaluation, with reasons
  - M3-02 capability filter, tested per dimension (tools, structured output, vision, reasoning, streaming, context window, max output, availability, DeepSeek)
  - M3-03 per-candidate cost estimates from registry pricing (`EstimatedUsd`, `kind: 'estimate'`)
  - M3-04 best model above the reliability threshold, from priors blended with history
  - M3-05 routing explanation log (`RoutingLog` in `@soot/observability`)
  - M3-06 Economy / Balanced / Quality / Custom policies
- [x] Milestone 4 — Adaptive Execution (M4-01…M4-06), `@soot/escalation` + `@soot/agent-runtime` + `@soot/context-manager`:
  - M4-01 trigger detection (repeated failure, unexpected complexity, unmet criteria, low confidence, tool errors, token blowup, invalid output, crash)
  - M4-02 reassignment one tier up with context transfer (`priorAttempts`: summaries and findings)
  - M4-03 attempt and escalation limits, retry backoff, task and run budgets
  - M4-04 downgrade after a `planReady` prerequisite, gated on a 30% saving; never high-risk work
  - M4-05 recovery from timeout, rate limit, outage, auth, crash, invalid output; attempt history in SQLite (schema v2); resume replays the same decisions
  - M4-06 cancellation of one task or the whole run, including pending retries
- [x] Milestone 5 — Codebase Integration and Safety (M5-01…M5-09), `@soot/integrations` + `observability` + `context-manager` + `agent-runtime`:
  - M5-01 worktree per writing task from a pinned base, reset on retry, cleanup verified
  - M5-02 out-of-scope edits and overlapping diffs detected from real diffs
  - M5-03 serial merge-tree integration; conflicts surfaced with branches kept
  - M5-04 soot-run test/typecheck/lint/acceptance checks; failure marks the task incomplete
  - M5-05 consolidated report listing incomplete and failed work first
  - M5-06 per-task, per-attempt and total cost, estimates and actuals separate
  - M5-07 soot verdicts stored per model and tier (schema v3) and fed back into routing
  - M5-08 approval gates (interactive waits, unattended refuses), command controls, audit log
  - M5-09 untrusted content fenced and scanned; injection grants no permissions

## In Progress

- [ ] Milestone 2. M2-03 (local endpoint) is Implemented: covered by mocked HTTP, but the live test skipped because no Ollama or LM Studio was running. M2-07 is Blocked.
- [ ] M0-11 (first hosted CI run) is blocked on publish approval.
- [ ] Milestone 6. M6-01, M6-03 and M6-09 (generic ACP driver, mock ACP agent only) Completed; M6-02 and M6-06 Implemented; M6-04, M6-05, M6-08 Not Started; M6-07 Blocked on M2-07. Exit criteria not met.

## Not Started

- [ ] Milestone 7 — IDE Extensions

## Blockers

- Hosted GitHub Actions CI cannot run until the repository is published (ADR-006; Mochi decides). Not a milestone blocker: the same checks are verified locally.
- **Milestone 6 exit criteria** need a supported harness: running the generic ACP driver against a real harness the user already installed and signed in to (M6-04/05), which this box must not do, plus real providers (M2-07). Mochi decides next steps.
- **M2-07 Blocked:** Milestone 2's real-provider exit criterion needs user-supplied (BYOK) keys for at least two providers (ADR-011, ADR-017). soot will not mint, request, or spend.

## Known Issues

- Decomposition is fixture-only: prompts without a recorded fixture are refused (`NoFixtureError`).
- Agents are mocks. Since M5, "complete" means soot ran the checks on the task's real diff, but no real model has produced a diff yet.
- No OS sandbox: worktrees isolate git state, not processes (TECHNICAL_DEBT.md).
- Provider adapters are verified against mocked HTTP only. Real wire behaviour is unverified until M2-07.
- Escalation triggers still use agent signals, plus soot's own verification since M5. Provider health and run spend are in memory; model outcomes are persisted.
- See `TECHNICAL_DEBT.md`.

## Next Actions

1. Mochi: review the generic ACP driver (ADR-027). Verifying it with a real harness (M6-04/05) needs a machine where the user has installed and signed in to that harness and agrees to a run; Mochi decides when and where. Milestone 7 not started.
2. Mochi: decide when and whether to run M2-07 with user-supplied keys. Real routing outcomes, model-backed evaluation and calibrated thresholds depend on it.
3. Optional: run `pnpm vitest run packages/provider-adapters/src/local-endpoint.test.ts` with Ollama or LM Studio running to verify M2-03 live.

## MVP Readiness

Not Ready (MVP-01, MVP-02, MVP-05 core in place with fixtures/mocks; MVP-03 partial (mocks only, real providers blocked); MVP-04 routing in place with heuristic evaluation; MVP-06 in place with mocks; MVP-07, -08 in place, verified on fixture repos with mock agents; CLI and MCP surfaces exist (fixture prompts, mock agent only); no supported harness yet)

## Latest Validation

Recorded 2026-11-12 ~03:22 PST from a real run of `bash scripts/ci.sh` in `/workspace/soot`, Node 24.22.1, git 2.47.3. The run covers install --frozen-lockfile, typecheck, lint, format:check, test and a clean build.

- **Build:** pass. `tsc -b` built all 13 packages.
- **Tests:** pass. 58 test files (57 passed, 1 skipped) and 423 tests (422 passed, 1 skipped, 0 failures), Vitest 5.1.0. The skipped test is the live local-endpoint test: no runtime was listening on 127.0.0.1:11434 or :1234.
- **Typecheck / lint / format:** pass.
- **Network audit:** the in-process suite was re-run with a global `fetch` guard; the only real requests were the two localhost probes. Subprocess tests (`soot stop`, `soot mcp`, and the mock ACP agent processes spawned by `soot run --agent acp`) run built soot code that does not depend on the provider adapters. The only ACP agent ever spawned is soot's own mock (`node .../mock-agent-bin.js`); no vendor binary was run. No key-like environment variables were set.
- **Quick start:** `docs/installation.md` reproduced step by step from a fresh `git clone` of this repo in `/tmp` (demo runs: unattended INCOMPLETE exit 2, interactive `y` COMPLETE exit 0 with fast-forward, Test 4 shape INCOMPLETE with the review unverified, skill installed into a temp dir).
