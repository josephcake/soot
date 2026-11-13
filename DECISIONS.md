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
- **Status:** Superseded by ADR-032 (repository published on GitHub, 2026-11-12). Kept as written below for history.
- **Context:** Publishing has not been approved. Mochi decides on publishing after Milestone 0 is verified and clean.
- **Decision:** The repository lives only at `/workspace/soot` on the build box (moved from `/workspace/intelligent-agent-router` by ADR-013). Local git only: no remote, no push, no `gh repo create`. A GitHub Actions workflow is committed so CI is ready, and `scripts/ci.sh` runs identical checks locally. Commits use the local identity `Sweed <sweed@bots.local>`.
- **Alternatives:** Private GitHub repo now (still needs approval); no CI file until publish (loses CI-readiness).
- **Consequences:** Hosted CI has never run; local CI results are the only evidence (see `TECHNICAL_DEBT.md`).
- **Reversible:** Yes — add a remote and push once Mochi approves.

## ADR-007: Intended MVP stack (intent, not built)

- **Date:** 2026-11-12
- **Status:** Superseded in part by ADR-019 (provider layer: Vercel AI SDK in-process instead of LiteLLM; SQLite driver: `node:sqlite`). Remaining direction stands; **nothing below is implemented yet**
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

## ADR-014: License stays MIT (reconfirmed)

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi, binding call on Lumen's research questions)
- **Context:** Lumen's pre-implementation research asked whether the license should change.
- **Decision:** No change. MIT as in ADR-005.
- **Alternatives:** Apache-2.0 (see ADR-005).
- **Consequences:** None; the tree already matches.
- **Reversible:** As ADR-005.

## ADR-015: soot may launch the user's own installed, signed-in CLIs

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi). Not implemented (harness execution is Milestone 6).
- **Context:** Harness CLIs (e.g. Claude Code, Codex) can run tasks on the user's machine using the user's own subscription or keys.
- **Decision:** soot may launch CLIs the user has already installed and already signed in to, on the user's own machine, using only that local install and existing login. soot never offers or performs a login flow, never bundles proprietary agent SDKs, never bypasses the host's approval prompts, and never brands itself as the vendor's product.
- **Alternatives:** Bundling vendor SDKs (rejected: licensing, lock-in); soot-managed logins (rejected: credential handling, BYOK/local-first).
- **Consequences:** Harness adapters detect an existing install and session and fail clearly if absent. Proprietary SDKs, if ever used, are optional peer dependencies only (ADR-019).
- **Reversible:** Only by a new decision from Mochi/Joseph.

## ADR-016: DeepSeek excluded from the default MVP path pending data-residency review

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi)
- **Context:** Sending user code to DeepSeek's hosted API raises data-residency questions Joseph has not reviewed.
- **Decision:** DeepSeek is not part of the default MVP routing path and is not used in any demo or test that would send code to its API, until Joseph reviews data residency. The model registry may still list DeepSeek models as metadata.
- **Alternatives:** Include by default (rejected until review); drop entirely (unnecessary: listing is harmless).
- **Consequences:** Default routing policies (M3) must exclude DeepSeek-hosted endpoints; any opt-in must be explicit.
- **Reversible:** Yes, after Joseph's review.

## ADR-017: First providers are Anthropic and OpenAI (Milestone 2), mocks until BYOK

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi). Not implemented (Milestone 2).
- **Context:** Milestone 2 needs two independent providers behind the provider abstraction.
- **Decision:** Implement Anthropic and OpenAI first, behind the provider abstraction, tested with mocks. No real paid calls and no spending until Joseph provides BYOK keys (ADR-011).
- **Alternatives:** Google, OpenRouter, or local runtimes first (later).
- **Consequences:** Milestone 2's real-credential exit criterion stays blocked on BYOK keys.
- **Reversible:** Yes.

## ADR-018: Never auto-approve; pause for approval or refuse the task

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi). Partially reflected in Milestone 1: the scheduler has no approval bypass; approval handling arrives with real runners.
- **Context:** Headless agents and harness CLIs can ask for approval (destructive commands, file writes outside scope). Spec §13 forbids bypassing host permissions.
- **Decision:** soot never auto-approves. When a user can answer, the task pauses until they approve or deny. When the run is unattended and no approval can be collected, that task is refused (it does not succeed); independent tasks may continue.
- **Alternatives:** Auto-approve within a sandbox (rejected); fail the whole run (rejected: unrelated work is lost).
- **Consequences:** Runners must surface approval requests as a distinct outcome. In Milestone 1 terms, a refused task ends as not-succeeded and its dependents are skipped while independent tasks continue, which the scheduler already does.
- **Reversible:** Only by a new decision from Mochi/Joseph.

## ADR-019: Architecture direction after Lumen's research

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi). Supersedes the LiteLLM and SQLite-driver parts of ADR-007. Mostly not implemented yet.
- **Context:** Lumen's research compared provider layers, state engines, harness protocols, and isolation strategies.
- **Decision:**
  - **Provider layer:** Vercel AI SDK in-process. LiteLLM is not a required dependency; an OpenAI-compatible endpoint may be supported later as an option.
  - **Model registry:** thin (metadata + capabilities + pricing), no heavy framework.
  - **State:** a SQLite-backed task state machine, not a workflow engine. Driver: Node's built-in `node:sqlite` (no native addon, no extra dependency). Used from Milestone 1 (`@soot/context-manager`).
  - **Harness protocol:** ACP (Agent Client Protocol).
  - **Isolation and integration:** write-scope leases; one git worktree per write task from a pinned base commit; soot runs the tests itself for evidence; merges go through a single queue.
  - **Not adopted for M1–M5:** the experimental AI SDK harness packages.
  - **Proprietary SDKs:** optional peer dependencies only, never bundled.
  - **Repository layout:** keep the current monorepo packages; do not collapse packages just to reduce their number.
- **Alternatives:** LiteLLM proxy/SDK (extra runtime, Python dependency); LangGraph or similar workflow engine (framework stacking); `better-sqlite3` (native addon); MCP as the only harness protocol (still usable for tools).
- **Consequences:** Milestone 1 declared file sets (`files.read`/`files.write`) and the scheduler's conflict serialization are the precursor of write-scope leases (M5). The provider abstraction in M2 wraps the AI SDK; tests use mocks.
- **Reversible:** Component by component, via new ADRs.

## ADR-020: Minimal soot-owned API executor for trivial tasks only

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi). Not implemented (after Milestone 2).
- **Context:** Some tasks (e.g. change a CSS value) are too small to justify launching a full harness.
- **Decision:** soot may run a minimal executor for trivial, tightly scoped tasks: the model returns structured edits, and soot applies them in the task's worktree under the same leases, worktrees, and evidence tests as any other task. No general shell access and a tight file allowlist (the task's declared write set). This is not a competing coding assistant.
- **Alternatives:** Always delegate to a harness (heavier for trivial edits); a general-purpose agent loop (rejected: competes with harnesses, larger attack surface).
- **Consequences:** The executor's output must be an `AgentResult` like any runner's; edits outside the declared write set are rejected.
- **Reversible:** Yes.

## ADR-021: Milestone 1 implementation choices

- **Date:** 2026-11-12
- **Status:** Accepted (Sweed, under ADR-012: smaller extensible option)
- **Context:** Milestone 1 needed a task contract with JSON Schema, a graph engine, a scheduler, persisted state, and cost records, with mocks only.
- **Decision:**
  - **Contracts:** `zod` 4 is the single source for runtime validation and JSON Schema (`z.toJSONSchema`, draft 2020-12). Generated schemas are committed in `packages/task-graph/schema/` and a test fails if they drift. Objects are strict; agent-result text is length-capped so transcripts cannot enter shared state. `zod` is the only new runtime dependency (no transitive dependencies).
  - **File conflicts:** tasks the planner left unordered whose declared files overlap (write/write or read/write; a trailing `/` marks a directory) are serialized in declaration order with recorded implicit edges, never run concurrently. This is the Milestone 1 precursor of write-scope leases (ADR-019).
  - **Scheduler:** in-process, bounded concurrency, declaration-order start. `succeeded` means the agent reported success with a valid result; evidence-based verification is Milestone 5. A non-succeeded task skips its transitive dependents; independent tasks continue (matches ADR-018's refusal semantics). No retries or escalation in M1 (Milestone 4). Cancellation does not wait for runners that ignore the abort.
  - **State:** `node:sqlite` (built into Node ≥ 22.13; no native addon), one file `soot.sqlite` in `SOOT_DATA_DIR`, WAL + `synchronous = FULL`, synchronous journal writes from the scheduler. Attempts left `running` by a dead process are closed as `interrupted` on restart and re-run with the next attempt number.
  - **Cost records:** estimates and actuals use distinct branded types; unknown costs stay `null`.
  - **Labels:** packages with real Milestone 1 code export `IMPLEMENTATION_STATUS = 'partial'`; the mock runner's `kind` is `mock-test-double` and its results are prefixed `[mock]`.
- **Alternatives:** hand-written validators plus a hand-written JSON Schema (two sources that drift); Ajv (validation only, schema still hand-written); `better-sqlite3` (native build); failing graph construction on file conflicts instead of serializing (forces the planner to order everything).
- **Consequences:** Packages build and test independently; the kill/restart test builds the packages and runs them in a child process.
- **Reversible:** Yes, each part independently.

## ADR-022: Milestone 2 implementation choices (provider connectivity, mocks only)

- **Date:** 2026-11-12
- **Status:** Accepted (Sweed, under ADR-012: smaller extensible option)
- **Context:** Milestone 2 needs one provider abstraction, Anthropic and OpenAI adapters (ADR-017), a thin registry, availability and fallback, sourced pricing, and credential isolation. ADR-011 rules out real keys and paid calls, so everything is verified against mocks. Lumen's research (`docs/research/2026-11-12-soot.md` §3, §4, §6) informed the details.
- **Decision:**
  - **AI SDK, pinned exactly:** `ai@7.0.170`, `@ai-sdk/anthropic@4.0.102`, `@ai-sdk/openai@4.0.115`, `@ai-sdk/openai-compatible@3.0.90`, `@ai-sdk/provider@4.0.37`, all dependencies of `@soot/provider-adapters` only. Exact pins are a supply-chain measure (research §6). No `@ai-sdk/harness` or other experimental packages (ADR-019). No LiteLLM. No proprietary agent SDKs.
  - **Model objects only, never string ids:** a bare string model in the AI SDK routes through the hosted Vercel gateway. `AiSdkModelClient` rejects strings, and adapters always build provider model objects.
  - **OpenAI uses Chat Completions** (`openai.chat()`), the same wire format as OpenAI-compatible endpoints. The Responses API is deferred.
  - **soot owns retries:** SDK retries are off (`maxRetries: 0`). `withRetries` makes at most 3 attempts by default. It honours `retry-after-ms`/`retry-after` (seconds or HTTP date, capped at 30 s) and otherwise uses exponential backoff with half jitter. That fallback matters because Anthropic 429s may omit `retry-after`. Streams are retried only before their first event, so output is never replayed.
  - **Error taxonomy:** every failure becomes a `ProviderError` with a `kind` (429 → `rate-limited`; 401/403 → `auth`; 408 → `timeout`; ≥ 500 including 529 → `unavailable`; other 4xx → `invalid-request`), plus `status` and `retryAfterMs`. It carries no raw cause, headers, or body, and its message is scrubbed of the key.
  - **Structured output is validated on receipt** against the caller's zod schema. A response that ignores the schema becomes `invalid-output`, because research §3 found silently ignored capabilities to be a pattern. Tool names must be portable snake_case.
  - **Fallback is soot's, not the SDK's:** `generateWithFallback` marks provider-level failures (outage, rate limit after retries, timeout, auth) in `ProviderHealth` with a cooldown (outage 60 s, rate limit = retry-after or 30 s, auth until fixed) and tries the next candidate. Request-level failures and aborts do not fall back.
  - **Registry:** soot ships no model names and no prices. Users configure them. Unknown metadata is `null`. Prices are per million tokens and require `source` and `asOf`. Cost estimates and actuals keep distinct branded types (ADR-021), and cached tokens without a cache price give an unknown actual rather than a guess. Discovery (`GET /models`) only adds unselectable entries with unknown metadata, and models the provider no longer lists are excluded from selection.
  - **DeepSeek (ADR-016):** any provider whose id or base URL host is DeepSeek is `restricted`. Restricted and `listed-only` providers are excluded from selection, and `createModelClient` / `discoverModelIds` refuse them before any network access.
  - **Credentials:** keys are read in one place, the adapter layer (`readApiKey` in `createModelClient` and `discoverModelIds`), from the variable a config names (`apiKeyEnv`, validated as a variable name). The key is passed to the SDK factory and kept privately only as a redaction pattern. Clients serialize to `{ref, adapter}`. A repo guard test fails if production code elsewhere reads a key variable. Explicit keys are always passed to SDK factories, so they never fall back to reading `process.env` themselves.
  - **AI SDK warning logging is off by default** (`globalThis.AI_SDK_LOG_WARNINGS ??= false`). Warnings are returned on responses, scrubbed, instead of printed.
  - **Health is in memory** for Milestone 2. Persisting it is debt.
  - **Local endpoints** use the generic OpenAI-compatible adapter. The live test probes only `127.0.0.1:11434` (Ollama) and `127.0.0.1:1234` (LM Studio) and is skipped when neither is listening.
- **Alternatives:** the SDK's built-in retries (not rate-limit-aware and not observable in tests); hand-written HTTP clients per provider (more code, more drift); the OpenAI Responses API first (different wire format from compatible endpoints); a bundled model catalogue with prices (goes stale and would be guessed).
- **Consequences:** Provider behaviour is covered by one contract suite that runs against the mock test double and each adapter over a scripted `fetch`. Real-provider behaviour is unverified until M2-07 (BYOK).
- **Reversible:** Yes. The `ModelClient` interface isolates callers from the AI SDK.

## ADR-023: Milestone 3 implementation choices (task-level routing)

- **Date:** 2026-11-12
- **Status:** Accepted (Sweed, under ADR-012: smaller extensible option)
- **Context:** Milestone 3 needs per-task model selection that is cheap where possible, strong where needed, explainable, and policy-driven (build spec §5). There is no model-backed planner yet, no real provider runs (M2-07 Blocked), and soot must never hardcode model names or guess metadata.
- **Decision:**
  - **Heuristic evaluation:** `evaluateTask` starts from the planner's declared complexity and only raises it. `debugging`, security and architecture work raise it to at least medium. More than 50k planned tokens means at least medium, and more than 150k means high. A small rule table maps the open task-capability vocabulary onto model capabilities. Every task needs `tools` and `structuredOutput`, because soot's API executor uses tool calls and validated results. Security, architecture and data-migration work is _high-risk_ and uses the `high` reliability threshold. Every rule that fires is recorded as a reason. Unmapped capabilities are reported, not guessed. A model-backed evaluator can replace this behind `TaskProfile`.
  - **Reliability = configured prior ⊕ measured history.** Model config gains optional `reliability: {low, medium, high, source}`, which is unknown by default and needs a source when set. History blends in as (prior·k + successes)/(k + attempts), with k = 5. Without a prior, history counts after 3 attempts. Only succeeded and failed attempts count; cancelled and blocked ones say nothing about the model. Unknown reliability is excluded unless a policy allows it.
  - **Policies are one validated structure.** Economy, Balanced and Quality are presets; Custom is a preset plus overrides.
    - Economy: cheapest model at thresholds 0.60/0.70/0.80.
    - Balanced: lowest estimated cost per success (cost ÷ p) at 0.75/0.85/0.90, so a slightly pricier but more reliable model can win.
    - Quality: highest reliability at 0.85/0.90/0.95, and the only preset that allows unpriced models.
    - Custom can also set provider allow and deny lists, local-only, a per-task cost cap, the prior weight, and what to do when nothing qualifies.
    - These numbers are defaults, not measurements.
  - **No silent fallbacks.** If no model meets the threshold, the decision is `unroutable` with a reason, unless the policy opts into `onNoQualifying: 'most-reliable'`.
  - **Filtering reuses `ModelRegistry.select`**, which covers capabilities (unknown counts as missing), context window, availability, and restricted (DeepSeek) and listed-only providers. The router adds checks for max output tokens, price, the cost cap and reliability.
  - **Costs are estimates end to end.** Costs come from the registry's sourced list prices, are typed `EstimatedUsd`, and are labelled `kind: 'estimate'`. Routing never writes into a task's planner estimate or into actuals.
  - **Explanations:** every decision lists every registry model with its outcome (selected, eligible, below threshold, or excluded), estimate, reliability and exclusion reasons, plus a one-sentence reason. `RoutingLog` in `@soot/observability` stores entries in memory and renders text and JSON Lines.
  - **Routing is pure and per task:** `routeTasks` maps `routeTask` over the tasks independently. The router calls no model.
- **Alternatives:** a single quality score per model (cannot express "fine for CSS, unreliable for debugging"); ranking without thresholds (cannot meet "cheapest above a reliability threshold"); LLM-based complexity scoring now (needs real providers, M2-07); built-in benchmark priors (would be guesses or go stale).
- **Consequences:** Routing quality depends on the user's priors until history accumulates. The fixture registry in tests is fictional. Latency is not considered yet.
- **Reversible:** Yes. The evaluator, policy presets and blending formula are each isolated.

## ADR-024: Milestone 4 implementation choices (adaptive execution, mocks only)

- **Date:** 2026-11-12
- **Status:** Accepted (Sweed, under ADR-012: smaller extensible option)
- **Context:** Milestone 4 must escalate failing or doubtful work to a stronger model mid-flight with its findings, leave unrelated tasks alone, bound every loop, downgrade after planning, recover from provider failures, and cancel cleanly (build spec §6, §17 Tests 3 and 6). Real providers are unavailable (M2-07 Blocked), so everything is verified with mock agents and the fictional routing registry.
- **Decision:**
  - **Mechanics vs decisions.** The `@soot/agent-runtime` Scheduler owns mechanics: attempts, per-attempt timeouts (`attemptTimeoutMs`), retry timers, cancellation, and journaling. A pluggable `AttemptSupervisor` (`plan` before each attempt, `review` after it) owns decisions. `SINGLE_ATTEMPT` is the default and keeps Milestone 1 behaviour. `@soot/escalation`'s `AdaptiveSupervisor` is the real one. Waiting retries hold no concurrency slot.
  - **Decisions are pure and replayable.** `nextStep(task, record, earlier, config)` derives the next step from attempt history alone, so `plan` can recompute after a restart what `review` decided before it. History (assignment, failure, review per attempt) is persisted in `soot.sqlite` (schema v2, `attempt_details`, in-place v1→v2 migration) and fed back via `previousAttemptRecords`, so limits and context survive restarts.
  - **Signals come from the agent's structured result.** `AgentResult.signals` (optional) carries `confidence`, `complexity` (`higher` = harder than planned), `toolErrors`, `unmetCriteria`, and `planReady`. Triggers: repeated failure, unexpected complexity, unmet criteria, low confidence (< 0.6), tool errors (≥ 3), token blowup (> 3× planned), invalid output, crash. A "succeeded" result with low confidence or unmet criteria is not accepted (recorded as `rejected`) and escalates.
  - **Failure policy.**
    - Rate limit / timeout: retry the same model after `retry-after` or exponential backoff (1 s doubling, 30 s cap), up to 2 times, then fall back to another provider and mark the provider rate-limited for its cooldown.
    - Outage / auth: fall back to another provider immediately; mark provider health.
    - Reported failure, invalid output, crash: escalate at once if a strong trigger fired (complexity, unmet criteria, confidence, tool errors, token blowup); otherwise retry the same model once, then escalate as repeated failure.
    - Blocked: fail (needs human input; another model would not help). Never auto-approve (ADR-018).
  - **Escalation = re-route one tier up.** Each escalation raises the routing complexity by one level and routes through `@soot/model-router` with the run's policy and health, then picks the first usable candidate that is untried, not on a failed provider, and strictly more reliable at the new tier than the previous model. If none qualifies at the threshold, a below-threshold stronger model may be used; otherwise the task stops with a reason. DeepSeek stays excluded by the registry.
  - **Context transfer** passes `priorAttempts` (attempt, model, outcome, summary, structured findings, failure message, the supervisor's note) to the next attempt. Never transcripts or credentials.
  - **Bounds:** max 5 attempts per task, max 2 escalations, optional per-task and per-run USD budgets. Spend counts reported actual cost, else the routed estimate; in-flight attempts reserve their estimate so concurrent tasks cannot overspend the run budget. An attempt whose cost cannot be estimated is refused when a budget is set.
  - **Downgrade** applies when a task starts and a prerequisite result has `signals.planReady`: route one tier lower and switch only if the model differs and the estimate drops by ≥ 30%. High-risk work (ADR-023) is never downgraded. Every skip is recorded with its reason.
  - **Explainability:** every assign, retry, fallback, escalate, downgrade, downgrade-skipped, accept, fail, and stop is an `AdaptiveEvent` with a readable reason; each attempt's assignment reason is persisted.
  - **Defaults are choices, not measurements.** All thresholds are in `EscalationConfigSchema`.
- **Alternatives:** escalation inside the scheduler (mixes policy into mechanics, hard to test); restarting the whole run on failure (violates "unrelated tasks not restarted"); LLM-judged confidence (needs real providers, M2-07); mid-attempt model switching (needs a streaming agent loop; deferred).
- **Consequences:** Trigger quality depends on agents reporting honest signals until Milestone 5 verifies evidence. Provider health and success history remain in memory. Downgrade happens only at task start.
- **Reversible:** Yes. The supervisor is an interface; thresholds are config.

## ADR-025: Milestone 5 implementation choices (codebase integration and safety)

- **Date:** 2026-11-12
- **Status:** Accepted (Sweed, under ADR-012: smaller extensible option)
- **Context:** Milestone 5 must let several tasks change a real repository safely, detect conflicts, report integration failures, and run the relevant checks itself so that "complete" means soot-verified evidence (build spec §8, §13; ADR-014…ADR-020). Real providers are unavailable (M2-07 Blocked) and harness runners are M6, so agents are mocks that write files into the worktree they are given; everything else (git, checks, merges) is real.
- **Decision:**
  - **One wrapper, no scheduler changes.** `runCodebaseWorkflow` (`@soot/integrations`) wraps any `AgentRunner` in an `IsolatedTaskRunner`. The M1 scheduler and the M4 supervisor are unchanged; soot's verdict is folded back into the result the supervisor reviews.
  - **Worktrees from a pinned base.** Opening a run refuses a dirty working tree and pins `HEAD`. Each task gets `soot/<run>/<task>` in a worktree under `SOOT_DATA_DIR/worktrees/<run>/`, outside the repo; a retry resets the same worktree (`reset --hard`, `clean -fdx`). A dependent's base is the pinned base merged (merge-tree, no checkout) with its prerequisites' verified commits. Write leases (`WriteLeases`) are acquired per write set; overlapping leases are refused. Cleanup removes this run's worktrees in `finally` and deletes only branches already integrated into the user's tree.
  - **soot reads the real diff.** After an attempt soot commits the worktree with its own identity and lists changes with `git diff --name-status --no-renames`. Files outside the lease → `out-of-scope`; a write task with no changes → `no-changes`; deletions need a `delete-files` approval. Agent-reported evidence and patches are kept as claims only.
  - **soot runs the checks.** Project checks (test, typecheck, lint) and per-task acceptance commands come only from configuration, run as argv without a shell, with an executable allowlist, a denylist of destructive programs and git subcommands, a timeout, and an environment scrubbed to PATH/HOME/locale/TMP (no keys, no `NODE_OPTIONS`). Output tails are redacted and marked untrusted. A task is `verified` only when every required check passed on its commit; read-only tasks with no acceptance command are `unverified`, which counts as incomplete.
  - **Failed verification feeds M4.** `failed-validation`, `out-of-scope` and `no-changes` become a `failed` result with soot's finding, so the supervisor retries or escalates with that finding as context. A refused approval becomes `blocked` (terminal; another model would not help).
  - **Serial integration.** Verified tasks are integrated in dependency order onto the current `HEAD` with `git merge-tree --write-tree` and `commit-tree` (no checkout, no index). A conflict is recorded with its paths and the task's branch is kept; the rest continue. Overlapping changes across diffs are reported separately. The merged result gets final validation in a detached worktree.
  - **The user's working tree moves only by fast-forward,** and only after final validation passed, an explicit `integrate-into-working-tree` approval, a clean tree and an unchanged `HEAD`. Otherwise the result stays on `soot/<run>/integration` and the report says why.
  - **Approvals are never automatic (ADR-018).** `ApprovalGate` has two implementations: `UNATTENDED_APPROVALS` answers `unavailable` (the task is refused, independent tasks continue) and `InteractiveApprovalGate` waits until a person answers `approved` or `denied` (cancel → `unavailable`). There is no approve-all gate. Agents ask through the same gate (`TaskPermissions`).
  - **Audit log.** `AuditLog` (`@soot/observability`) appends redacted JSON Lines (mode 0600) to `SOOT_DATA_DIR/audit/<run>.jsonl` for worktrees, leases, attempts, scope violations, commands run or refused, approvals, verdicts, integration and working-tree updates, and flagged untrusted content.
  - **Untrusted content.** `buildAgentContext` (`@soot/context-manager`) separates trusted task fields from fenced untrusted blocks (dependency results, prior attempts, tool output), with fence tags neutralised and a heuristic injection scan. Permissions in the packet come only from the task (write set, no agent commands, approval mode); nothing in untrusted text can change scope, approvals or verdicts.
  - **Cost report.** `buildCostReport` lists per task and in total the planner estimate, the sum of routed per-attempt estimates, and actual usage as reported by the runner, side by side and never mixed; unpriced or missing usage makes the actual unknown rather than zero. Per-attempt lines show the escalation path.
  - **Outcome feedback.** Each soot verdict with its model and tier is stored in `soot.sqlite` (schema v3, `model_outcomes`, migrated in place). Only soot verdicts count (verified → success; failed-validation, out-of-scope, no-changes, agent failure → failure). They feed `historyFromAttempts` and change later routing.
  - **Structured edits (ADR-020).** `applyStructuredEdits` is the only write primitive for a future soot-owned API executor: whole-file writes and deletes inside the write set, all-or-nothing, size and count caps, no `..`, absolute paths, `.git` or symlink escapes.
- **Alternatives:** applying patches in the user's tree (risks the user's work; no isolation); `git merge` with checkout for integration (touches an index and can leave a half-merged tree); trusting agent evidence (forbidden by ADR-018); a shell for checks (injection); an LLM injection classifier (needs providers; heuristic for now); storing the audit log in SQLite (append-only file is simpler and survives store corruption).
- **Consequences:** Completion now means soot evidence. There is no OS sandbox: a runner that writes outside its worktree is not seen in the diff, so real runners must be confined by the host harness or a sandbox (M6+). Checks run whatever the configuration lists, inside the allowlist. Injection detection is heuristic and only informs; safety comes from permissions not depending on untrusted text.
- **Reversible:** Yes. Each piece (gate, runner wrapper, integrator, report) is an interface or a function.

## ADR-026: Milestone 6 implementation choices (CLI, MCP server, universal skill)

- **Date:** 2026-11-12
- **Status:** Accepted (Sweed, under ADR-012: smaller extensible option)
- **Context:** Milestone 6 makes orchestration invocable from existing harnesses (build spec §2, §15). Real providers need BYOK keys (M2-07, Blocked) and no harness runner exists, so this milestone can only deliver the invocation surfaces, tested against fixtures and the scripted mock agent. Mochi's brief: CLI, skill, MCP server and docs; Claude Code / Codex not claimed; no proprietary SDKs; never auto-approve.
- **Decision:**
  - **One service, two surfaces.** `OrchestrationService` (`@soot/harness-adapters`: run, status, cost, models, stop; each returns text plus JSON) is implemented once by `SootEngine` in `apps/cli` and exposed by the CLI and by the MCP server. The engine is the reusable entry point TECHNICAL_DEBT called for: load config and registry, decompose (recorded fixtures only), load routing history from `model_outcomes`, build the M4 supervisor, call `runCodebaseWorkflow`, save the report.
  - **Binary `soot`** (the spec's `orchestrator`, renamed with the project). Commands: `run`, `models`, `status`, `config`, `cost`, `stop`, plus `install-skill`, `mcp`. Text by default, `--json` for machines. Exit codes: 0 complete, 1 error, 2 incomplete, 3 cancelled. No UI.
  - **No pretend runner.** `soot run` needs `--agent mock --mock-script <file>` and labels the run as a fixture/test-double run in its output and report. Without it, it refuses and says why (M2-07, no harness runner).
  - **Project config `soot.config.json`**, committed with the project and strict: model registry path, policy, checks, per-task acceptance commands, protected paths, allowed executables, concurrency, timeouts, escalation limits, extra fixtures. Commands come only from it. The config, registry, fixtures and mock script are added to the protected paths automatically.
  - **Protected paths (M5 gap fix).** `IsolatedTaskRunner` now fails a task as `out-of-scope` when it changes a protected path even inside its lease, so acceptance tests and soot config cannot be weakened by the task under test.
  - **Approvals.** The CLI asks on the terminal one question at a time (`y`/`yes` approves; anything else or EOF denies). Without a terminal, or with no `--interactive`, it is unattended: approvals are unavailable and the work is refused. There is no approve-all flag. The MCP server is always unattended for now (no elicitation): results wait on `soot/<run>/integration`.
  - **Stop is a request, not a kill.** A running `soot run` holds `<data>/control/<run>.lock` and polls for `<run>.stop`; `soot stop` writes the request, and the run cancels through the M4 cancellation path. SIGINT in the running process does the same.
  - **Reports** are saved as `<data>/reports/<run>.json`; `soot cost` rebuilds the cost report from stored attempts, keeping estimates and reported actuals apart (mock actuals are labelled fictional).
  - **MCP** uses the official MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, Apache-2.0; `@modelcontextprotocol/client` for tests only). MCP is an open protocol, not a proprietary agent SDK. Tools: `soot_run`, `soot_status`, `soot_cost`, `soot_models`, `soot_stop`, with zod input schemas and read-only hints. The prompt is passed verbatim. ACP remains the planned protocol for soot to drive harness agents (M6-04/05), not implemented.
  - **Universal skill** `skills/universal-orchestrator/SKILL.md` (Agent Skills format: `name`, `description`). It tells the host agent to pass multi-part requests verbatim to `soot_run` (or the CLI), never to approve for the user, and to trust soot's verdicts. `soot install-skill --target <dir>` copies it into `.agents/skills`, `.claude/skills` and `.grok/skills` under the target only; it never defaults to the home directory and never overwrites a changed copy without `--force`.
  - **Harness support is declared, not claimed.** `HARNESS_SUPPORT` lists Claude Code, Codex and Grok as `not-implemented`, `verifiedEndToEnd: false`. A future runner may launch a CLI the user already installed and signed in to; soot will not bundle proprietary SDKs, offer login, bypass host approvals or brand itself as the vendor's product.
- **Alternatives:** a long-running daemon for status/stop (more moving parts than files in the state dir); MCP elicitation for approvals (not supported uniformly by clients; deferred); a CLI flag that auto-approves (forbidden by ADR-018); bundling vendor agent SDKs to drive harnesses (forbidden); model-backed decomposition (needs M2-07).
- **Consequences:** soot is invocable end to end, but only on recorded prompts with a scripted agent. Milestone 6's exit criteria (a supported harness, real execution) are not met. Every surface reports fixture/mock runs as such.
- **Reversible:** Yes. The service interface, config schema and skill are small and versioned (`version: 1`).

## ADR-027: One generic ACP driver for harness agents

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi authorised the slice; Sweed chose the details under ADR-012)
- **Context:** ADR-019 picked ACP (Agent Client Protocol) as soot's harness protocol, and Lumen's research lists ACP modes or adapters for many coding agents. Mochi asked for one generic driver, tested only against a mock agent soot controls, with no vendor binary run, nothing proprietary bundled, and the host's approval model respected.
- **Decision:**
  - **soot is the ACP client; the harness is the ACP agent.** `AcpAgentRunner` (`@soot/harness-adapters`) implements `AgentRunner`: per attempt it connects, sends `initialize` (protocol v1, client capabilities `fs.readTextFile` and `fs.writeTextFile` only, `terminal: false`), `session/new` with the task's worktree as `cwd` and no MCP servers, then one `session/prompt` with the task text from `buildAgentContext` (trusted task fields, fenced untrusted context). It collects `agent_message_chunk` text, tool-call counts and a USD `usage_update`, and maps the stop reason: `end_turn` → succeeded (still only a claim until soot's checks), any other → failed.
  - **Official SDK, stable protocol.** `@agentclientprotocol/sdk` 2.6.0 (Apache-2.0, the protocol's reference TypeScript library; its peers are the zod and MCP server packages soot already uses), default stable v1 entry point only. Not experimental v2, and not the AI SDK harness packages.
  - **Approvals stay with a person.** `session/request_permission` goes to soot's approval gate as `harness-permission` with the tool call's kind, title, locations and input (cleaned, truncated). Approved → the agent's `allow_once` option only (never `allow_always`; without `allow_once` soot cancels). Denied or unavailable → `reject_once` (or `reject_always`, or cancel), then `session/cancel`, and the task ends `blocked` (refused, not retried; independent tasks continue). soot never calls `authenticate`, `session/set_mode` or `session/set_config_option`, so it cannot switch a harness into a less careful mode. An agent that needs sign-in blocks the task with "sign in yourself".
  - **soot's file methods enforce the lease.** Reads only inside the worktree; writes only inside the task's write lease (never `.git`), size-capped. Everything else is a JSON-RPC error and an `issue` finding. soot's diff check, protected paths and checks still apply to whatever the agent changed by other means.
  - **Cancellation.** Abort sends `session/cancel`; an agent that does not stop within a grace period (2 s) is cut off and its process ended.
  - **Spawn only what the user configured.** `soot run --agent acp` (and `soot mcp --agent acp`) spawn `acpAgent.command` from `soot.config.json` (protected from task edits) with `args`, no shell, cwd = the worktree, and an environment scrubbed to PATH, HOME, locale, temp, USER, SHELL plus the variable names in `passEnv`; credential-like names are rejected. soot never searches for, installs or picks an agent binary. The default path is unchanged: without `--agent`, `run` refuses.
  - **No vendor claims.** The driver is generic. Claude Code (M6-04) and Codex (M6-05) would connect through it later via their ACP modes or adapters the user installs and signs in to, but neither has been run; `HARNESS_SUPPORT` still says `not-implemented`.
  - **Routing honesty.** The agent picks its own model, so ACP outcomes are not recorded as routing history and the run output says routed models are not applied. (Refined by ADR-028.)
  - **Test double.** `createMockAcpAgent` and `mock-agent-bin.js` (official SDK, agent side) script permission requests, file reads and writes, stop reasons, slow or cancel-ignoring turns, auth-required, and cost, and log what they receive (method names, env var names only).
- **Alternatives:** a hand-written JSON-RPC client (risks drifting from the real protocol); vendor-specific runners for each CLI (forbidden for this slice and more surface); the AI SDK `-acp` harness package (experimental, not adopted by ADR-019); answering permissions from a policy file (would be auto-approval); a long-lived agent process across tasks (shared state between tasks; harder isolation).
- **Consequences:** soot can drive any ACP agent a user points it at, with approvals in the user's hands. Nothing about any vendor harness is verified. There is no OS sandbox: a spawned agent runs with the user's rights, so its own tools can reach outside the worktree (soot's diff only sees the worktree).
- **Reversible:** Yes. The runner is one `AgentRunner`; the CLI path is opt-in.

## ADR-028: Apply soot's routed model through ACP session config

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi authorised; Sweed chose the details under ADR-012). Refines ADR-027.
- **Context:** With ADR-027 the ACP agent chose its own model, so soot's per-task route was neither applied nor recorded. ACP v1 lets an agent advertise session config options; the `model` category is the standard place for model choice.
- **Decision:**
  - After `session/new`, if `configOptions` contains a `select` option with category `model`, soot looks for the routed ref (`provider/modelId`) among its values, then for the id after `provider/`. On a match it sends `session/set_config_option` for **that option only** and treats the route as applied only when the response confirms the new current value.
  - Otherwise (no option, no matching value, refused, not confirmed) the route is **not applied** and the reason is kept. Never dropped silently: every attempt gets an `AcpRouteRecord` that appears as a progress line, an `ACP model routing:` section in `soot run`, `acpRoutes` in the saved report, and a `decision` finding on the attempt.
  - `usage.model` is the routed model only when applied, else `null`. Routing history is recorded for an ACP attempt only when its route was applied; the mock agent path is unchanged.
  - soot still never touches `mode` or any other option, never authenticates, and never changes approval settings. Tokens stay 0 because ACP v1 reports none; nothing is estimated.
- **Alternatives:** an alias map from soot refs to agent values (more config, deferred until a real agent needs it); choosing the closest-sounding value (guessing); `session/set_model` from unstable ACP (not in the stable entry point).
- **Consequences:** Routing works end to end for agents that offer the option. Tested only with soot's mock ACP agent; no vendor agent's option names are known or claimed.
- **Reversible:** Yes.

## ADR-029: Thin VS Code / Cursor extension over the soot CLI

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi authorised starting M7 locally; Sweed chose the details under ADR-012).
- **Context:** Milestone 7 asks for IDE visibility and control while core orchestration stays independent of any IDE. Spec §8.B lists what the extension should show: orchestration on/off, task graph, active agents, assigned models, execution status, escalation events, estimated and actual cost, retries and failures, task cancellation. ADR-009 keeps UI simple and block-shaped.
- **Decision:**
  - `apps/vscode-extension` (`soot-vscode`, private, version 0.0.0) is an ESM extension (`"type": "module"`, VS Code `^1.100`). It has **no runtime dependencies** and imports no `@soot/*` package. It runs `node <soot.cliPath> <command> --json` in the workspace folder (no shell) and reads the JSON. Orchestration stays in the engine; a test asserts the extension imports nothing from it.
  - Runs started from the editor are **unattended** (no terminal on stdin): soot refuses approval-needing work and leaves results on the integration branch. The extension never approves, has no approve-all, and does not change host approval settings.
  - View: one tree (`soot.runs`) and one plain-text board (`soot: Show board`), built from stacked text blocks (`[■ task · demo-small→demo-mid · 2x]`, graph by dependency layer). No webview, no dashboard. Status is polled from `soot status <run>`, one call at a time.
  - Engine additions the extension needs, usable from the CLI and MCP too: `soot stop <run> --task <id>` / `soot_stop {runId, taskId}` cancels one task through `Scheduler.cancel(taskId)` (dependents skipped, other tasks continue), signalled by a `<run>.stop-task.<id>` control file; the run's routing events are appended live to `reports/<run>.events.jsonl`; `soot status <run>` adds per-attempt details, `running`, and the events.
  - Orchestration on/off is a workspace setting (`soot.enabled`, default off); runs are refused while off.
  - A `.vsix` can be built locally with `pnpm dlx @vscode/vsce@4.1.0 package` (not a devDependency, so no publishing tool sits in the lockfile). Nothing is published.
- **Alternatives:** importing the engine into the extension host (couples the IDE to the engine, and native SQLite in Electron); talking to `soot mcp` over stdio (needs an MCP client dependency in the extension; the CLI JSON is simpler); a webview dashboard (against ADR-009); file watching instead of polling (deferred).
- **Consequences:** The same extension should load in VS Code-compatible editors, but each editor counts only after its own verified run. It needs a local soot checkout and Node 24 on the machine. Tested only with a fake `vscode` module; not yet run in any real editor.
- **Reversible:** Yes.

## ADR-030: Engine hardening: env-driven runtime, persisted health and spend, audited routing, default timeout

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi authorised the hardening; Sweed chose the details under ADR-012).
- **Context:** Before real keys or a real harness, four gaps would hurt: `SOOT_LOG_LEVEL` was parsed but ignored; provider health and run-budget spend lived in memory and were lost on restart; routed estimates and routing decisions were not recorded with the run; an attempt without `attemptTimeoutMs` could hang forever.
- **Decision:**
  - **Runtime from env.** `runtimeFromEnv` (apps/cli) uses `parseEnv` for the state directory (`--data-dir` > `SOOT_DATA_DIR` > `~/.soot`) and the log level, for every command including `soot mcp`. `createLogger` (`@soot/core`) filters stderr log lines by level; command results are never filtered, and `--json` turns log lines off. No `.env` file is read.
  - **Persisted health.** `ProviderHealth` takes an optional `ProviderHealthStore`; `ExecutionStore` implements it with a `provider_cooldowns` table (schema v4). Only timed cooldowns persist; auth and not-configured marks last for the process.
  - **Persisted spend.** `AdaptiveSupervisor` takes an optional `SpendLedger` and keeps spend per attempt: the in-flight routed estimate when an attempt starts, replaced by the reported actual (or kept as the estimate when none was reported) when it is reviewed. `ExecutionStore.spendLedger(runId)` stores it in `attempt_spend`; a new supervisor loads it, so a restarted run's budget includes every earlier attempt. Unpriced attempts have no row; nothing is invented.
  - **Cost records and audit.** `costRecordsFromAttempts` builds `TaskCostRecord`s with a separate `routed` list (`RoutedEstimate`, branded `EstimatedUsd`, plus `routeApplied` from the runner's reported model) next to reported actuals; `soot run` saves them and `soot cost` returns them. Every supervisor decision is an audit `routing-decision`; every ACP route outcome is a `model-route`. Routing history stays credited only where the route was applied (ADR-028).
  - **Default timeout.** `DEFAULT_ATTEMPT_TIMEOUT_MS` = 30 minutes in the scheduler when `attemptTimeoutMs` is unset; an explicit value wins. The ACP 2 s cancel cutoff is unchanged.
- **Alternatives:** a separate spend total per run (loses which attempt it came from and double-counts on resume); persisting auth failures (would lock a provider out after the key is fixed); writing the full `RoutingLog` candidate table into the audit log (large; decisions with reasons are enough for review); no default timeout (a hung runner blocks forever); a shorter default (real agent attempts can take many minutes).
- **Consequences:** Restarted runs keep skipping down providers and respect budgets across restarts. Schema v4 migrates older databases in place. Only mock agents exercise any of it so far; values (30 min, cooldowns) are untuned.
- **Reversible:** Yes.

## ADR-031: Optional local dashboard (`soot dashboard`), headless stays the default

- **Date:** 2026-11-12
- **Status:** Accepted (Joseph authorised a simple optional local dashboard, relayed by Mochi; Sweed chose the details under ADR-012). Amends FUTURE_FEATURES for this simple dashboard only; the elaborate web dashboard stays deferred.
- **Context:** Spec §12 asks for an execution dashboard (prompt, task graph, task count, active agents, model per task, model transitions, token usage, estimated and actual cost, duration, success and failure, validation results, cost per model). soot is headless first (CLI, MCP, skill, ACP, the VS Code extension) and must stay so. ADR-009 keeps UI simple and block-shaped.
- **Decision:**
  - New workspace app `apps/dashboard` (`@soot/dashboard`, private, no dependencies). It serves one static page (plain HTML, one stylesheet, one small script, no framework) and a read-only JSON API (`GET /api/runs`, `GET /api/runs/<id>`) with Node's built-in `http`.
  - It binds **127.0.0.1 only** (default port 8787, `--port <n>` overrides, `0` asks the OS for a free port explicitly). If the bind fails, the command fails; no other port is tried. It checks the socket's own address after binding and refuses anything else. Requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` get 421 (DNS-rebinding guard); only GET and HEAD are answered; responses carry a strict CSP (`connect-src 'self'`).
  - **Opt-in only:** `soot dashboard` is the sole entry point. It loads `@soot/dashboard` with a dynamic `import()` inside that command; `cli.ts` has only an erased type import. No engine package, headless CLI module, MCP path, skill or the extension imports it. The CLI lists it as an optional peer (plus a workspace devDependency), so installing or running headless soot never requires it. A browser opens only with `--open`.
  - **One source of truth:** the CLI passes its `SootEngine` as the dashboard's read-only `DashboardSource` (`status`, `cost`). The dashboard has no store of its own; it reshapes what `soot status <run>` and `soot cost <run>` return (SQLite state, saved report, events file, cost report). `soot status <run>` gained additive fields for this: run `createdAt`, per-attempt `startedAt`/`finishedAt`, per-task soot-run `checks`, run-level `finalValidation` (no output tails) and `problems`.
  - **Honest numbers:** unknown costs and tokens stay null; estimates (planner, router) and reported actuals stay separate; duration is run creation to the last attempt finish and null while running. There is no benchmark data, so the page states that no savings are claimed.
  - Local-first: no accounts, no outbound requests, no provider calls, no keys or environment read by the dashboard code.
- **Alternatives:** an SPA framework (React/Vue/Svelte; rejected: weight and polish against ADR-009); Express/Fastify (rejected: a dependency for four routes); a separate `soot-dashboard` binary or the dashboard reading `soot.sqlite` itself (rejected: a second reader of state that could drift from the engine's views); a webview in the extension (rejected in ADR-029); binding all interfaces or falling back to a free port (rejected: exposure and surprise).
- **Consequences:** The dashboard is a new optional local surface, not a milestone; it changes no milestone status. Data comes from mock runs only until M2-07 and harness runners exist. The page polls while a run is running.
- **Reversible:** Yes.
- **Amendment (2026-11-12, charts; Joseph asked, relayed by Mochi):** the page gains chart blocks built from the same run payload, still hand-rolled (CSS bars, plain DOM, no chart library):
  - **Usage** by model, by task and by runner (the run's agent label from the saved report, e.g. the mock test double or the configured ACP command). Each block has four separate charts: estimated USD (router), actual USD (reported), estimated tokens (planner), actual tokens (reported). Estimates are hatched, actuals solid, never in the same chart; a null is written as "unknown" with no bar; sums are unknown if any part is unknown.
  - **Assignment:** the original prompt, then one card per task (the planner's title and instructions for that part of the work, grouped by dependency layer) with its attempt chain: routed model, how it was chosen (assign, retry, fallback, escalate, downgrade) and the runner-reported model where it differs or is unknown.
  - `soot status <run>` adds task `title`/`instructions` and run `agent`/`agentLabel` (additive). The runner is run-level: soot has one runner per run, so there is no per-task bot identity to show.
- **Amendment (2026-11-12, palette and more chart types; Joseph asked, Mochi decided, TASKS D-03):** same Lego-block pixel look (CSS and plain DOM, no chart library, `@soot/dashboard` keeps zero dependencies), new colours and more chart types from the same payload. No API change.
  - **Palette:** page `#0a0a0a`, blocks `#141414`, charcoal borders `#2e2a27`. One accent, orange `#ff7a1a` (headings, card titles, selected run, the prompt's dashed border, solid actual bars; darker `#c25510` for a second segment or slice). Cream/bone `#e8dcc8` for highlights and hatched estimate bars. Warm gray `#8c8278` for notes, redder orange `#ff4d2e` for errors and failures. No third bright accent.
  - **Chart types:** outcomes as a pixel donut (zero slices left out) plus a success-rate meter (a null rate is "n/a" with no fill); token usage as two stacked input/output bars, planned and reported, never in one chart; cost as an estimate-only chart (planner and router) and a separate actual chart; duration as a pixel timeline of attempts from `startedAt`/`finishedAt` plus the run total (a running or unknown end is a start tick with a label, never a finished bar); validation as stacked counts by status for task checks and for final validation (problem text stays text); transitions as a count-by-type chart above the reasons; usage blocks keep their four charts and add an estimated-USD share donut and a separate actual-USD share donut (no donut if any part is unknown). The cost-by-model text block is folded into the usage-by-model block, which lists every row's attempts, tokens in/out and USD as text.
  - Unchanged: prompt, savings note, active agents and transition reasons stay text; null is unknown with no bar or slice; each magnitude chart is scaled to its own largest known value; bind, headless and lazy-loading rules as above.

## ADR-032: Repository is public on GitHub; hosted CI runs

- **Date:** 2026-11-12
- **Status:** Accepted (Joseph approved publishing and Mochi pushed it; recorded by Mochi). Supersedes ADR-006.
- **Context:** ADR-006 kept the repository on the build box with no remote until publishing was approved. Joseph approved publishing, and the repository was pushed to GitHub on 2026-11-12.
- **Decision:** The canonical repository is public at https://github.com/josephcake/soot (owner `josephcake`, default branch `main`) under the MIT license (ADR-005). `.github/workflows/ci.yml` runs on every push to `main` and on pull requests, on Node 24 and Node 26. `scripts/ci.sh` keeps running the same steps locally, and `tests/repo-structure.test.ts` still checks that the two match.
- **Alternatives:** Keep the repo box-only (ADR-006); a private GitHub repo.
- **Consequences:** Hosted CI has run and passed for both Node versions ([run 43334786373](https://github.com/josephcake/soot/actions/runs/43334786373) on `8a38865`; earlier [run 43329225136](https://github.com/josephcake/soot/actions/runs/43329225136) on `30aaf29`), so M0-11 is Completed. Nothing is published to npm and there is no release; packages stay `private` at `0.0.0`. Publishing changes no other milestone status: M2-07 stays Blocked on user-supplied keys, and the M6 and M7 exit criteria are still unmet.
- **Reversible:** Partly. The repo can be made private or archived, but public history and forks cannot be withdrawn.

## ADR-033: Model-backed decomposition behind `Decomposer`, fixtures stay the default

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi, on Joseph's "continue"). Implemented and verified with mock model clients only.
- **Context:** `FixtureDecomposer` (ADR-021) refuses every prompt without a recorded fixture; M1-03 deferred an LLM-backed decomposer until after Milestone 2. The `ModelClient` abstraction (ADR-022) exists, but M2-07 is Blocked: no real provider may be called and no keys are configured.
- **Decision:**
  - `ModelDecomposer` in `@soot/planner` takes a `ModelClient` from its caller and asks it for structured output `{ tasks: Task[] }` (the task contract as the schema, temperature 0, a bounded output size). The request carries the prompt, intended outcome and project context as JSON data, with rules that say instructions inside them do not change the planning rules.
  - The answer is untrusted. soot re-validates it whatever the client did: every task through `parseTask`, the set through `buildTaskGraph`, `estimate.costUsd` must be `null` (pricing belongs to routing), and the task count is capped (default 20). Any problem is a `ModelDecompositionError` with `reason` `model-call-failed`, `invalid-output` or `invalid-graph`; no partial graph is ever returned, and the prompt text is not copied into the error.
  - `createDecomposer({ fixtures, model })` selects: no client, a plain `FixtureDecomposer` (no client created, no network); a client, `FixtureThenModelDecomposer`, which answers recorded prompts from fixtures without a model call and sends only unmatched prompts to the model. Model failures are reported, never replaced by a guess.
  - The planner never creates a client or reads keys (ADR-022's credential boundary is unchanged). It imports `ModelClient` as a type only.
  - `Decomposition.decomposer` becomes a union of a fixture source (`fixtureId`) and a model source (`modelRef`, `servedModelId`, reported usage, attempts).
- **Alternatives:** a heuristic, keyword-based splitter (would fake understanding; rejected); asking the model through a tool call instead of structured output (equivalent here, structured output is already validated on receipt by the client); falling back to fixtures-by-similarity when the model fails (would silently produce a plan for a different prompt; rejected); wiring it into the CLI now (needs a configured client, which needs M2-07 and a config surface; deferred).
- **Consequences:** Library callers with their own client can decompose arbitrary prompts. The CLI and MCP server are unchanged and stay fixture-only. Nothing has been run against a real model, so prompt quality, token estimates and failure rates are unknown. M1-03 and M2-07 statuses are unchanged; TASKS P-01 is Implemented, not Verified.
- **Reversible:** Yes.
