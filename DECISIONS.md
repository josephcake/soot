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
