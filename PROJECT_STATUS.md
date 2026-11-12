# Project Status

Last Updated: 2026-11-12

## Current Phase

Milestone 0 — Repository Foundation

## Overall Progress

1 / 8 milestones completed (M0 verified locally; M1–M7 not started)

## Current Status

Completed (Milestone 0). Project renamed to `soot` (ADR-013); repo at `/workspace/soot`. Milestone 1 approved by Mochi; feature work not started yet.

## Completed

- [x] Local git repository (no remote), specs committed verbatim (M0-01)
- [x] pnpm 10 workspace: `apps/cli` + 12 `packages/*` (M0-02)
- [x] Strict TypeScript 6 with project references; no-emit typecheck (M0-03)
- [x] ESLint 10 (type-checked, zero warnings) + Prettier 3 (M0-04)
- [x] Vitest 5: per-package and repository guard tests (M0-05)
- [x] Environment configuration: `.env.example`, `parseEnv`, `docs/configuration.md` (M0-06)
- [x] Basic docs incl. repository layout in `docs/architecture.md` (M0-07)
- [x] CI: `.github/workflows/ci.yml` + `scripts/ci.sh`, passing locally (M0-08)
- [x] MIT license (M0-09)
- [x] Tracking files (M0-10)

## In Progress

- [ ] Nothing in progress. M0-11 (first hosted CI run) is blocked on publish approval.

## Not Started

- [ ] Milestone 1 — Core Orchestration (MVP-01, MVP-02, MVP-05)
- [ ] Milestone 2 — Multi-Provider Model Connectivity (MVP-03)
- [ ] Milestone 3 — Intelligent Model Routing (MVP-04)
- [ ] Milestone 4 — Adaptive Execution (MVP-06)
- [ ] Milestone 5 — Codebase Integration and Safety (MVP-07, MVP-08)
- [ ] Milestone 6 — Universal Skill and CLI
- [ ] Milestone 7 — IDE Extensions

## Blockers

- Hosted GitHub Actions CI cannot run until the repository is published (ADR-006; Mochi decides). Not a Milestone 0 blocker: the same checks are verified locally.
- Future: Milestone 2's real-provider exit criterion needs user-supplied (BYOK) keys (ADR-011).

## Known Issues

- 12 of 13 workspace packages are stubs (by design for Milestone 0).
- No dedicated security/conduct contact address yet.
- See `TECHNICAL_DEBT.md`.

## Next Actions

1. Mochi: review Milestone 0 and decide on publishing (enables M0-11 hosted CI run).
2. Fold Lumen's pre-implementation research into ADRs (provider layer, SQLite driver, harness surfaces).
3. Start Milestone 1 when approved: M1-01 task schema, then M1-04 dependency graph.

## MVP Readiness

Not Ready

## Latest Validation

Recorded 2026-11-12 ~00:45 PST from real runs of `bash scripts/ci.sh` (install --frozen-lockfile → typecheck → lint → format:check → test → clean build):

- Build: pass — `tsc -b` built all 13 packages (13 `dist/index.js` present). Node 24.22.1 and Node 26.13.1, pnpm 10.34.6, on fresh clones and in the working copy.
- Tests: pass — 15 test files, 72 tests, 0 failures (Vitest 5.1.0). Mutation checks confirmed tests fail when a package name drifts or `.env.example` gains a key value.
- Typecheck / lint / format: pass — `tsc -p tsconfig.typecheck.json`, `eslint . --max-warnings=0`, `prettier --check .`.
- Hosted CI: not run — repository not published (ADR-006). Workflow file is present but unverified on GitHub.
- Integration: not applicable (no orchestration yet).
- Real provider execution: none — no provider code exists; no keys used (ADR-011).
