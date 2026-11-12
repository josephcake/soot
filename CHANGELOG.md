# Changelog

All notable changes are recorded here by milestone. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No versions have been released.

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
