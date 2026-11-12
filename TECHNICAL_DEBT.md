# Technical Debt and Known Limitations

Each item is tagged **[Intentional]** (a deliberate MVP/milestone shortcut) or **[Defect]**
(something wrong that should be fixed). Last reviewed: 2026-11-12.

## Infrastructure

- **[Intentional] Hosted CI is not running.** `.github/workflows/ci.yml` exists but has never
  executed, because the repo has no remote and publishing is not approved (ADR-006). Local
  `scripts/ci.sh` runs the same steps; its results are recorded in `PROJECT_STATUS.md`. The
  workflow itself (action versions, pnpm setup, Node 24/26 matrix) is unverified until the
  first hosted run.
- **[Intentional] Node 26 (Active LTS) is pinned in `.nvmrc`; the build box's system Node is 24.** Both are verified locally (Node 26 via a temporary binary in /tmp).
- **[Intentional] TypeScript pinned to 6.0.x**, not 7.x, because typescript-eslint 8 supports
  `typescript <6.1`. Revisit when typescript-eslint supports TS 7.
- **[Intentional] No git hooks.** Contributors run `pnpm run ci` manually.
- **[Intentional] No coverage reporting or thresholds yet.** Add with Milestone 1 code.
- **[Intentional] No release/versioning tooling** (e.g. changesets). Packages are `private`, `0.0.0`.

## Code

- **[Intentional] 12 of 13 workspace packages are stubs** exporting only `PACKAGE_NAME`,
  `IMPLEMENTATION_STATUS = 'stub'`, and `PLANNED_MILESTONE`. Their package boundaries follow
  spec §15 and may be merged or split once Milestone 1 design settles (record in DECISIONS.md).
- **[Intentional] `parseEnv` is not called by any runtime yet** and nothing loads `.env`
  files; it exists to fix the config contract for local-first state (`SOOT_DATA_DIR`).
- **[Intentional] Vitest projects are discovered by directory scan** in `vitest.config.ts`,
  and workspace packages are aliased to `src/` for tests. Packages under `apps/` other than
  `cli` need an alias entry when added.

## Documentation / community

- **[Intentional] No dedicated security or conduct contact address yet.** `SECURITY.md` and
  `CODE_OF_CONDUCT.md` point to private maintainer contact / GitHub private reporting after
  publish. Must be set before the first public release.
- **[Intentional] Spec-listed docs not yet written** (`installation`, `providers`,
  `model-routing`, `task-decomposition`, `harness-integrations`, `security`, `examples`).
  They will be written with the features they describe, to avoid documenting fiction.

## Security

- None in code yet (no credential handling, no agent execution). Security requirements from
  spec §13 are tracked as tasks in `TASKS.md`.

## UI

- **[Intentional] No UI exists.** Future UI follows ADR-009 (simple, pixelated, Lego-block
  modules); polish is not debt.
