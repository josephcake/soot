# Project Status

Last Updated: 2026-11-12

## Current Phase

Milestone 2 — Multi-Provider Model Connectivity (In Progress, partial; mocks only)

## Overall Progress

2 / 8 milestones completed (M0 and M1 verified locally; M2 in progress; M3–M7 not started)

## Current Status

In Progress (Milestone 2, partial). The mockable scope is implemented and verified with mocked
HTTP and a scripted test double. **No real provider has been called and no real key has been
used.** M2-07 (real calls on ≥ 2 providers with user keys) is Blocked, so Milestone 2 is not
Completed. Project name `soot` (ADR-013); repo at `/workspace/soot`, local only.

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

## In Progress

- [ ] Milestone 2. M2-03 (local endpoint) is Implemented: covered by mocked HTTP, but the live test skipped because no Ollama or LM Studio was running. M2-07 is Blocked.
- [ ] M0-11 (first hosted CI run) is blocked on publish approval.

## Not Started

- [ ] Milestone 3 — Intelligent Model Routing (MVP-04)
- [ ] Milestone 4 — Adaptive Execution (MVP-06)
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
- Task-level retries and escalation are Milestone 4; Milestone 2 has only provider-call retries.
- See `TECHNICAL_DEBT.md`.

## Next Actions

1. Mochi: review the Milestone 2 mockable scope, and decide when and whether to run M2-07 with user-supplied keys.
2. Optional: run `pnpm vitest run packages/provider-adapters/src/local-endpoint.test.ts` with Ollama or LM Studio running to verify M2-03 live.
3. Milestone 3 (routing) starts only on Mochi's go-ahead.

## MVP Readiness

Not Ready (MVP-01, MVP-02, MVP-05 core in place with fixtures/mocks; MVP-03 partial (mocks only, real providers blocked); MVP-04, -06, -07, -08 open)

## Latest Validation

Recorded 2026-11-12 ~01:27 PST from a real run of `bash scripts/ci.sh` (install --frozen-lockfile → typecheck → lint → format:check → test → clean build) in `/workspace/soot`, Node 24.22.1:

- Build: pass. `tsc -b` built all 13 packages.
- Tests: pass. 34 test files (33 passed, 1 skipped), 259 tests (258 passed, 1 skipped, 0 failures), Vitest 5.1.0. The skipped test is the live local-endpoint test: no runtime was listening on 127.0.0.1:11434 or :1234.
- Typecheck / lint / format: pass.
- Network audit: the full suite was re-run with a global `fetch` guard. The only real requests were the two localhost probes. Every provider request went to injected mock `fetch` functions. No key-like environment variables were set.
- Milestone 2 evidence:
  - `contract.test.ts` runs 13 contract cases against each of 4 targets (mock, Anthropic, OpenAI, OpenAI-compatible), plus 5 request-wiring checks.
  - `credentials.test.ts` covers leaks.
  - `fallback.test.ts` covers outages, fallback, discovery and the DeepSeek refusal.
  - `tests/credential-boundary.test.ts` is the repo guard.
  - The model-registry tests cover config, selection and pricing.
- Milestone 1 evidence is unchanged: `tests/m1-end-to-end.test.ts`, `tests/resume-after-kill.test.ts`.
- Hosted CI: not run, because the repository is not published (ADR-006).
