# Project Status

Last Updated: 2026-11-12

## Current Phase

Milestone 4 — Adaptive Execution (completed, verified locally with mock agents); Milestone 2 In Progress (partial; M2-07 Blocked)

## Overall Progress

4 / 8 milestones completed (M0, M1, M3, M4 verified locally; M2 in progress, partial; M5–M7 not started)

## Current Status

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

## In Progress

- [ ] Milestone 2. M2-03 (local endpoint) is Implemented: covered by mocked HTTP, but the live test skipped because no Ollama or LM Studio was running. M2-07 is Blocked.
- [ ] M0-11 (first hosted CI run) is blocked on publish approval.

## Not Started

- [ ] Milestone 5 — Codebase Integration and Safety (MVP-07, MVP-08)
- [ ] Milestone 6 — Universal Skill and CLI
- [ ] Milestone 7 — IDE Extensions

## Blockers

- Hosted GitHub Actions CI cannot run until the repository is published (ADR-006; Mochi decides). Not a milestone blocker: the same checks are verified locally.
- **M2-07 Blocked:** Milestone 2's real-provider exit criterion needs user-supplied (BYOK) keys for at least two providers (ADR-011, ADR-017). soot will not mint, request, or spend.

## Known Issues

- Decomposition is fixture-only: prompts without a recorded fixture are refused (`NoFixtureError`).
- Agents are mocks; "succeeded" means agent-reported success, not verified evidence (Milestone 5).
- Provider adapters are verified against mocked HTTP only. Real wire behaviour is unverified until M2-07.
- Escalation triggers rely on agent self-report (`AgentResult.signals`); provider health and success history are in memory.
- See `TECHNICAL_DEBT.md`.

## Next Actions

1. Mochi: review Milestone 4. Decide whether to start Milestone 5 (codebase integration and safety: worktrees, patches, tests), which can proceed locally without providers.
2. Mochi: decide when and whether to run M2-07 with user-supplied keys. Real routing outcomes, model-backed evaluation and calibrated thresholds depend on it.
3. Optional: run `pnpm vitest run packages/provider-adapters/src/local-endpoint.test.ts` with Ollama or LM Studio running to verify M2-03 live.

## MVP Readiness

Not Ready (MVP-01, MVP-02, MVP-05 core in place with fixtures/mocks; MVP-03 partial (mocks only, real providers blocked); MVP-04 routing in place with heuristic evaluation; MVP-06 in place with mocks; MVP-07, -08 open)

## Latest Validation

Recorded 2026-11-12 ~01:59 PST from a real run of `bash scripts/ci.sh` in `/workspace/soot`, Node 24.22.1. The run covers install --frozen-lockfile, typecheck, lint, format:check, test and a clean build.

- **Build:** pass. `tsc -b` built all 13 packages.
- **Tests:** pass. 44 test files (43 passed, 1 skipped) and 340 tests (339 passed, 1 skipped, 0 failures), Vitest 5.1.0. The skipped test is the live local-endpoint test: no runtime was listening on 127.0.0.1:11434 or :1234.
- **Typecheck / lint / format:** pass.
- **Network audit:** the full suite was re-run with a global `fetch` guard. The only real requests were the two localhost probes. No key-like environment variables were set.
- **Milestone 4 exit criteria** (`tests/m4-adaptive-end-to-end.test.ts`, 13 tests, mock agents, fictional registry, spec fixture prompts):
  - **EC1 escalation with context (Test 3):** `update-theme-color` fails on `alpha/test-small` reporting higher complexity and confidence 0.3, escalates once to `beta/test-mid` (medium tier), and the second attempt receives the first attempt's summary and findings. A "succeeded" result with unmet criteria is rejected and escalated too.
  - **EC2 unrelated tasks:** the two Test 1 tasks in the same run each ran exactly once, and were still running when the escalation started.
  - **EC3 bounds:** an always-failing task climbs `test-small ×2 → test-mid ×2 → test-large` and stops at "attempt limit reached (5/5)"; with more attempts allowed it stops at "escalation limit reached"; a $0.05 task budget stops escalation to `alpha/test-large`; a run budget caps the second task; an outage on every provider ends with "no fallback model available" after 2 calls.
  - **EC4 downgrade:** after `investigate-race` reports `planReady`, `apply-race-fix` is routed as low instead of medium (`alpha/test-small`, est. $0.016 → $0.004625, saves 71%); the high-risk review is not downgraded; no plan means no downgrade; a 80% savings gate keeps the model.
  - **EC5 recovery (Test 6):** in one 6-task run, an outage falls back from alpha to `beta/test-mid` and marks alpha down; a 40 ms retry-after is honoured on the same model; a hung attempt times out (aborted) and is retried; a crash and an invalid output are each retried once. 11 calls total; every attempt, failure and review is in SQLite; no `running` rows remain. A persistent rate limit falls back after 2 retries. After a simulated process death during a pending retry, a reopened store resumes at attempt 2 on the same model without re-running the completed task.
  - **EC6 cancellation:** cancelling a task during a 30 s backoff ends it in under 1 s and skips its dependents; aborting a run during running attempts and a pending retry cancels everything, aborts both running mocks, and leaves no `running` rows. A scheduler test checks no live timer is left behind.
  - **DeepSeek:** never assigned in any M4 scenario.
- **Milestone 3, 2 and 1 evidence** is unchanged (`tests/m3-routing-end-to-end.test.ts`; `packages/provider-adapters`, `packages/model-registry`, `tests/credential-boundary.test.ts`; `tests/m1-end-to-end.test.ts`, `tests/resume-after-kill.test.ts`). M2-07 is Blocked.
- **Hosted CI:** not run, because the repository is not published (ADR-006).
