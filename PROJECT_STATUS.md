# Project Status

Last Updated: 2026-11-12

## Current Phase

Milestone 5 — Codebase Integration and Safety (completed, verified locally on fixture git repositories with mock agents); Milestone 2 In Progress (partial; M2-07 Blocked)

## Overall Progress

5 / 8 milestones completed (M0, M1, M3, M4, M5 verified locally; M2 in progress, partial; M6–M7 not started)

## Current Status

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

## Not Started

- [ ] Milestone 6 — Universal Skill and CLI
- [ ] Milestone 7 — IDE Extensions

## Blockers

- Hosted GitHub Actions CI cannot run until the repository is published (ADR-006; Mochi decides). Not a milestone blocker: the same checks are verified locally.
- **M2-07 Blocked:** Milestone 2's real-provider exit criterion needs user-supplied (BYOK) keys for at least two providers (ADR-011, ADR-017). soot will not mint, request, or spend.

## Known Issues

- Decomposition is fixture-only: prompts without a recorded fixture are refused (`NoFixtureError`).
- Agents are mocks. Since M5, "complete" means soot ran the checks on the task's real diff, but no real model has produced a diff yet.
- No OS sandbox: worktrees isolate git state, not processes (TECHNICAL_DEBT.md).
- Provider adapters are verified against mocked HTTP only. Real wire behaviour is unverified until M2-07.
- Escalation triggers still use agent signals, plus soot's own verification since M5. Provider health and run spend are in memory; model outcomes are persisted.
- See `TECHNICAL_DEBT.md`.

## Next Actions

1. Mochi: review Milestone 5. Decide whether to start Milestone 6 (universal skill and CLI). Not started.
2. Mochi: decide when and whether to run M2-07 with user-supplied keys. Real routing outcomes, model-backed evaluation and calibrated thresholds depend on it.
3. Optional: run `pnpm vitest run packages/provider-adapters/src/local-endpoint.test.ts` with Ollama or LM Studio running to verify M2-03 live.

## MVP Readiness

Not Ready (MVP-01, MVP-02, MVP-05 core in place with fixtures/mocks; MVP-03 partial (mocks only, real providers blocked); MVP-04 routing in place with heuristic evaluation; MVP-06 in place with mocks; MVP-07, -08 in place, verified on fixture repos with mock agents; no harness-facing surface until M6)

## Latest Validation

Recorded 2026-11-12 ~02:28 PST from a real run of `bash scripts/ci.sh` in `/workspace/soot`, Node 24.22.1, git 2.47.3. The run covers install --frozen-lockfile, typecheck, lint, format:check, test and a clean build.

- **Build:** pass. `tsc -b` built all 13 packages.
- **Tests:** pass. 50 test files (49 passed, 1 skipped) and 370 tests (369 passed, 1 skipped, 0 failures), Vitest 5.1.0. The skipped test is the live local-endpoint test: no runtime was listening on 127.0.0.1:11434 or :1234.
- **Typecheck / lint / format:** pass.
- **Network audit:** the full suite was re-run with a global `fetch` guard. The only real requests were the two localhost probes. No key-like environment variables were set; the secret-isolation test sets a fake one and checks it never appears.
- **Mutation checks** (temporarily breaking the code, then restoring it): ignoring failing checks fails 6 M5 tests; auto-approving deletions fails 2; dropping conflicts silently fails 2; skipping the scope check fails 2.
- **Milestone 5 exit criteria** (`tests/m5-codebase-end-to-end.test.ts`, 12 tests, real temporary git repos, mock agents):
  - **EC1 safe parallel changes:** two Test 1 tasks run concurrently in separate worktrees outside the repo; the user's tree is untouched during the run; both are verified, integrated (`soot: integrate …` commits), validated again, approved, and fast-forwarded; only the main worktree remains afterwards.
  - **EC2 conflicts detected:** an edit outside the write lease is caught from the real diff (`out-of-scope`) and reported as an overlap; a commit made by the user mid-run produces an integration conflict in `src/button.ts`, surfaced with the branch kept, while the other task integrates.
  - **EC3 integration failures reported:** conflicts, refused approvals and a working tree left untouched are listed under `NOT COMPLETE` and `problems`.
  - **EC4 evidence:** soot runs `node --test`, `tsc -p tsconfig.json` and the lint script on each task's commit. A type error with forged agent evidence ends as `failed-validation: typecheck failed (exit 2)`; a failing acceptance test is fed back and the task escalates `alpha/test-small` → `beta/test-mid` and is verified.
  - **M5-06 cost:** totals match the mocks' reported usage across 4 attempts, by model, with estimates shown separately.
  - **M5-07 routing feedback:** after two runs where the small model fails soot's acceptance test, the stored outcomes move Balanced routing from `alpha/test-small` to `beta/test-mid`; outcomes survive a reopen.
  - **M5-08 permissions:** unattended deletion is refused (never auto-approved) and its dependent skipped while independent work continues; the interactive gate pauses until answered (approved proceeds, denied refused); destructive checks (`rm`, `git push`, a non-allowlisted interpreter) are refused and audited; a fake key in the environment never reaches checks, reports or the audit log.
  - **M5-09 injection:** hostile check output and findings cause no approval requests and no scope change; the dependent that "followed" them fails out-of-scope; the flags are audited.
  - **Cancellation:** aborting a run mid-flight aborts the agents, removes worktrees and leaves the tree clean.
  - **DeepSeek:** never assigned.
- **Milestone 4, 3, 2 and 1 evidence** is unchanged (`tests/m4-adaptive-end-to-end.test.ts`, `tests/m3-routing-end-to-end.test.ts`; `packages/provider-adapters`, `packages/model-registry`, `tests/credential-boundary.test.ts`; `tests/m1-end-to-end.test.ts`, `tests/resume-after-kill.test.ts`). M2-07 is Blocked.
- **Hosted CI:** not run, because the repository is not published (ADR-006).
