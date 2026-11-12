# Project Status

Last Updated: 2026-11-12

## Current Phase

Milestone 1 — Core Orchestration (completed); Milestone 2 not started

## Overall Progress

2 / 8 milestones completed (M0 and M1 verified locally; M2–M7 not started)

## Current Status

Completed (Milestone 1), verified with mock agents and fixture-backed decomposition. Project
name `soot` (ADR-013); repo at `/workspace/soot`, local only. Milestone 2 has not been started
and needs a go-ahead from Mochi.

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

## In Progress

- [ ] Nothing in progress. M0-11 (first hosted CI run) is blocked on publish approval.

## Not Started

- [ ] Milestone 2 — Multi-Provider Model Connectivity (MVP-03): Anthropic + OpenAI via AI SDK, mocks until BYOK (ADR-017, ADR-019)
- [ ] Milestone 3 — Intelligent Model Routing (MVP-04)
- [ ] Milestone 4 — Adaptive Execution (MVP-06)
- [ ] Milestone 5 — Codebase Integration and Safety (MVP-07, MVP-08)
- [ ] Milestone 6 — Universal Skill and CLI
- [ ] Milestone 7 — IDE Extensions

## Blockers

- Hosted GitHub Actions CI cannot run until the repository is published (ADR-006; Mochi decides). Not a milestone blocker: the same checks are verified locally.
- Milestone 2's real-provider exit criterion needs user-supplied (BYOK) keys (ADR-011, ADR-017).

## Known Issues

- Decomposition is fixture-only: prompts without a recorded fixture are refused (`NoFixtureError`).
- Agents are mocks; "succeeded" means agent-reported success, not verified evidence (Milestone 5).
- No retries or escalation yet (Milestone 4).
- See `TECHNICAL_DEBT.md`.

## Next Actions

1. Mochi: review Milestone 1 and decide whether to start Milestone 2.
2. Fold Lumen's research (`/workspace/research/lumen/2026-11-12-soot.md`) into M2 task details when it lands.
3. Milestone 2 start (when approved): M2-01 provider abstraction interface + mocked provider.

## MVP Readiness

Not Ready (MVP-01, MVP-02, MVP-05 core in place with fixtures/mocks; MVP-03, -04, -06, -07, -08 open)

## Latest Validation

Recorded 2026-11-12 ~01:08 PST from real runs of `bash scripts/ci.sh` (install --frozen-lockfile → typecheck → lint → format:check → test → clean build) in `/workspace/soot` and on fresh clones under Node 24.22.1 and Node 26.13.1:

- Build: pass — `tsc -b` built all 13 packages.
- Tests: pass — 27 test files, 162 tests, 0 failures (Vitest 5.1.0); full suite repeated 3 more times without failure.
- Typecheck / lint / format: pass.
- Milestone 1 exit criteria (`tests/m1-end-to-end.test.ts`):
  - EC1: spec §17 Test 1 prompt → 2 tasks (`update-page-title`, `update-button-color`) from the fixture decomposer.
  - EC2: Test 1 graph has one layer and no implicit edges; Test 4 graph has `implement-feature` as the sole prerequisite of `add-feature-tests` and `security-review`.
  - EC3: with 150 ms mock delays, both Test 1 tasks started before either finished, peak concurrency 2, wall time < 285 ms; in Test 4 both dependents started after the implementation finished and overlapped each other.
  - EC4: validated results available from the `RunReport` and from `soot.sqlite` (identical), original prompt and SHA-256 persisted, cost summary computed.
- Resume: `tests/resume-after-kill.test.ts` SIGKILLs a child running the built packages mid-run; restart re-ran only the interrupted task (attempt 2) and its dependent.
- Hosted CI: not run — repository not published (ADR-006).
- Real provider execution: none — no provider code exists; no keys used (ADR-011).
