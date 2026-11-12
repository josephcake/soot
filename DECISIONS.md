# Architectural Decision Log

Format: ID, date, context, decision, alternatives considered, consequences, reversibility.
Foundational decisions are never changed silently; a change gets a new entry that supersedes
the old one.

---

## ADR-001: Repository name `intelligent-agent-router`

- **Date:** 2026-11-12
- **Status:** Superseded by ADR-013 (project renamed to `soot`, 2026-11-12)
- **Context:** Build spec §15 suggests `intelligent-agent-router` and asks for one name used consistently.
- **Decision:** Use `intelligent-agent-router` for the repository and the `@intelligent-agent-router/*` npm scope.
- **Alternatives:** Other names may be proposed (spec allows it); none was compelling enough to deviate.
- **Consequences:** Package names, docs, and the default data dir (`~/.intelligent-agent-router`) use this name.
- **Reversible:** Yes, cheaply before first publish; expensive after npm/GitHub publish.

## ADR-002: pnpm workspace monorepo

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** The spec suggests `pnpm-workspace.yaml` and requires packages that build and test independently.
- **Decision:** pnpm 10 workspaces over `apps/*` and `packages/*`; `packageManager` pinned; `engine-strict`.
- **Alternatives:** npm workspaces (weaker isolation, slower), Yarn Berry (PnP friction with tooling), Nx/Turborepo on top (unnecessary at this size; can be added later).
- **Consequences:** Strict dependency isolation, workspace links via `workspace:*`, a single lockfile.
- **Reversible:** Yes.

## ADR-003: TypeScript core with project references

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** Spec §14 recommends TypeScript for the core so it is reusable across harnesses/IDEs; §19 requires strict typing and independent builds.
- **Decision:** Strict TypeScript (incl. `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM/NodeNext, `composite` packages built with `tsc -b` via root project references. TypeScript pinned to 6.0.x because typescript-eslint 8 supports `<6.1`. Python adapters only where a Python ecosystem gives a clear advantage (none yet).
- **Alternatives:** Python core (weaker fit for VS Code/IDE extensions), Rust/Go core (higher contributor barrier), bundlers such as tsup (not needed for libraries yet), TypeScript 7 native compiler (blocked by lint tooling compatibility today).
- **Consequences:** Every package builds and is typechecked independently; upgrading to TS 7 is tracked in `TECHNICAL_DEBT.md`.
- **Reversible:** Yes for tooling details; the TypeScript-core choice is foundational.

## ADR-004: Tooling — ESLint + Prettier + Vitest

- **Date:** 2026-11-12
- **Status:** Accepted
- **Context:** Milestone 0 requires linting, formatting, and a test framework.
- **Decision:** ESLint 10 flat config with typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`, `eslint-config-prettier`; Prettier 3 for formatting; Vitest 5 with one project per package and a `repo` project for repository-level tests.
- **Alternatives:** Biome (single fast tool but no type-aware lint rules), Jest (slower ESM/TS story).
- **Consequences:** Type-aware lint uses `tsconfig.typecheck.json`; tests resolve workspace packages to source.
- **Reversible:** Yes.

## ADR-005: License MIT

- **Date:** 2026-11-12
- **Status:** Accepted (decided by Mochi, 2026-11-12). Replaces the earlier same-day draft that chose Apache-2.0.
- **Context:** The project must be genuinely open source and easy for companies to integrate into harnesses and IDEs.
- **Decision:** MIT License, `Copyright (c) 2026 the soot authors` (originally "the intelligent-agent-router authors"; updated by ADR-013), in `LICENSE` and every `package.json`.
- **Alternatives:** Apache-2.0 (the earlier draft; adds an explicit patent grant but is longer and has NOTICE obligations), MPL-2.0 / GPL (copyleft would discourage harness integrations).
- **Consequences:** Maximally permissive; no explicit patent grant. Contributors license contributions under MIT. `tests/repo-structure.test.ts` checks that `LICENSE` and all manifests agree.
- **Reversible:** Yes before outside contributions are accepted; afterwards requires contributor consent.

## ADR-006: Repository stays on the build box; no public GitHub yet

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi)
- **Context:** Publishing has not been approved. Mochi decides on publishing after Milestone 0 is verified and clean.
- **Decision:** The repository lives only at `/workspace/soot` on the build box (moved from `/workspace/intelligent-agent-router` by ADR-013). Local git only: no remote, no push, no `gh repo create`. A GitHub Actions workflow is committed so CI is ready, and `scripts/ci.sh` runs identical checks locally. Commits use the local identity `Sweed <sweed@bots.local>`.
- **Alternatives:** Private GitHub repo now (still needs approval); no CI file until publish (loses CI-readiness).
- **Consequences:** Hosted CI has never run; local CI results are the only evidence (see `TECHNICAL_DEBT.md`).
- **Reversible:** Yes — add a remote and push once Mochi approves.

## ADR-007: Intended MVP stack (intent, not built)

- **Date:** 2026-11-12
- **Status:** Accepted as direction; **nothing below is implemented yet**
- **Context:** Spec §14 and §20 suggest: TypeScript orchestration engine + LiteLLM + SQLite + git worktrees + universal agent skill, before IDE extensions.
- **Decision:** Plan the MVP around that stack: TypeScript engine (packages/*); LiteLLM or an equivalent OpenAI-compatible gateway for provider connectivity rather than hand-written clients for every provider; SQLite for local state; git worktrees for isolation; a universal agent skill (plus CLI/MCP) as the first integration surface. IDE extensions come after (Milestone 7). Exact library choices (e.g. SQLite driver, LiteLLM proxy vs. SDK) will be confirmed against Lumen's pre-implementation research and recorded as new ADRs.
- **Alternatives:** LangGraph or similar workflow engine (only if it adds value; avoid framework stacking), Postgres (contradicts local-first), building IDE extensions first (spec says not to).
- **Consequences:** Milestone sequencing in `ROADMAP.md` follows this order.
- **Reversible:** Yes, component by component, via new ADRs.

## ADR-008: Six non-negotiable product principles

- **Date:** 2026-11-12
- **Status:** Accepted (foundational)
- **Context:** Joseph's build spec closes with six principles to establish before implementation.
- **Decision:** Every milestone must uphold:
  1. **BYOK first** — users bring their own API keys; the project never resells model access.
  2. **Local-first** — orchestration state, credentials, and project context stay on the user's machine by default.
  3. **No vendor lock-in** — models/providers and IDEs/harnesses are independently replaceable.
  4. **Task-level billing** — track the cost of every individual task, including escalations.
  5. **Capability benchmarks** — a feedback loop measuring which models actually succeed at which tasks.
  6. **Safe concurrency** — git worktrees or equivalent isolation so agents never overwrite each other.
- **Alternatives:** Hosted orchestration / managed keys (rejected: contradicts 1–2).
- **Consequences:** Cloud hosting, accounts, and subscription billing are out of scope (`FUTURE_FEATURES.md`). The task graph, execution state, and file-conflict management are first-class engine concerns. Milestone 0 reflects this only in config (`SOOT_DATA_DIR` local default, no key handling) and docs.
- **Reversible:** No — changing any of these requires an explicit, documented decision by Joseph.

## ADR-009: UI and graph presentations stay simple, pixelated, and Lego-block modular

- **Date:** 2026-11-12
- **Status:** Accepted (standing constraint; decided by Joseph, relayed by Mochi)
- **Context:** The spec calls for a cost/performance dashboard, task-graph visualization, and IDE extension views (Milestones 5–7). Polished custom UIs are expensive to build and to change, and would pull effort away from the core engine.
- **Decision:** All future UI and graph presentations — dashboards, task-graph views, IDE extension panels — are deliberately simple and pixelated, built as small interchangeable "Lego block" pieces rather than a polished custom interface. Improvements should come from swapping or adding blocks, not redesigning a bespoke UI. No UI work happens in Milestone 0.
- **Alternatives:** A polished, branded custom interface (rejected: costly to iterate, encourages scope creep); no UI at all (rejected: the spec requires visibility into tasks, models, and cost).
- **Consequences:** UI components must consume plain data produced by the core (task graph, events, costs) so blocks stay replaceable and the core stays UI-independent. Visual polish is out of scope unless this decision is revisited.
- **Reversible:** Yes, but only by an explicit new decision from Joseph.

## ADR-010: TypeScript monorepo managed with pnpm (confirmation)

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi)
- **Context:** Mochi asked for the language/monorepo choice to be recorded as a single binding decision.
- **Decision:** The project is a TypeScript monorepo managed with pnpm workspaces. Details in ADR-002 (pnpm) and ADR-003 (TypeScript).
- **Alternatives:** See ADR-002 and ADR-003.
- **Consequences:** New components are added as workspace packages, not as separate repositories.
- **Reversible:** Costly after Milestone 1; requires a new ADR.

## ADR-011: No spending, no paid APIs, no minted keys; mocks and local fixtures until BYOK

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi)
- **Context:** Development happens before any user has supplied their own provider keys, and no budget is approved.
- **Decision:** No spending, no paid API calls, and no minting or requesting of API keys during development. Tests and demos use mocked providers and local fixtures (local model runtimes are acceptable when free). Real-provider execution happens only when a user brings their own keys, through opt-in tests.
- **Alternatives:** Project-owned test keys (rejected: costs money, violates BYOK).
- **Consequences:** Milestone 2's "works with real API credentials" exit criterion cannot be verified until BYOK keys are provided; such tasks will be marked partially verified, not complete.
- **Reversible:** Only by explicit approval from Mochi/Joseph.

## ADR-012: Prefer the smaller extensible approach; escalate blockers to Mochi

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi)
- **Context:** Avoid stalls and over-engineering during incremental development.
- **Decision:** When two approaches would both work, pick the smaller one that stays extensible and keep moving; record it here if it is foundational. Blockers are escalated to Mochi, not Joseph.
- **Alternatives:** Pausing for review on every design fork (slow); building the most general abstraction up front (contradicts spec §19 "avoid unnecessary abstractions").
- **Consequences:** Expect small, revisable decisions; foundational ones still get ADRs.
- **Reversible:** Yes.

## ADR-013: Project renamed to `soot`

- **Date:** 2026-11-12
- **Status:** Accepted (decided by Joseph, relayed by Mochi). Supersedes ADR-001.
- **Context:** Joseph renamed the project to `soot`, after the black dust bunnies (soot sprites) from Studio Ghibli. The previous name `intelligent-agent-router` is retired.
- **Decision:** The repository, root package, and npm scope are `soot` and `@soot/*` (e.g. `@soot/cli`, `@soot/core`, `@soot/planner`, `@soot/task-graph`). The working copy moved from `/workspace/intelligent-agent-router` to `/workspace/soot` with git history intact. Environment variables are renamed from `IAR_*` to `SOOT_*` (`SOOT_LOG_LEVEL`, `SOOT_DATA_DIR`); the default data dir is `~/.soot`, and the git-ignored local state dir is `.soot/`. The license copyright line becomes `Copyright (c) 2026 the soot authors`. The original specs under `docs/specs/` are historical and keep the original title.
- **Alternatives:** Keep `intelligent-agent-router` (rejected by Joseph); keep `IAR_*` env vars for compatibility (rejected: nothing was released, so there are no users to break).
- **Consequences:** All package names, imports, docs, tests, and tracking files say `soot`. No published artifacts existed, so the rename had no external impact. License (MIT), pnpm TypeScript monorepo, box-only repo, mocks-until-BYOK, and the Lego-block UI rule are unchanged.
- **Reversible:** Yes, cheaply until first publish.
