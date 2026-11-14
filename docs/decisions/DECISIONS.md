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
- **Consequences:** Every package builds and is typechecked independently; upgrading to TS 7 is tracked in `docs/project/TECHNICAL_DEBT.md`.
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
- **Consequences:** Hosted CI has never run; local CI results are the only evidence (see `docs/project/TECHNICAL_DEBT.md`).
- **Reversible:** Yes — add a remote and push once Mochi approves.

## ADR-007: Intended MVP stack (intent, not built)

- **Date:** 2026-11-12
- **Status:** Superseded in part by ADR-019 (provider layer: Vercel AI SDK in-process instead of LiteLLM; SQLite driver: `node:sqlite`). Remaining direction stands; **nothing below is implemented yet**
- **Context:** Spec §14 and §20 suggest: TypeScript orchestration engine + LiteLLM + SQLite + git worktrees + universal agent skill, before IDE extensions.
- **Decision:** Plan the MVP around that stack: TypeScript engine (packages/*); LiteLLM or an equivalent OpenAI-compatible gateway for provider connectivity rather than hand-written clients for every provider; SQLite for local state; git worktrees for isolation; a universal agent skill (plus CLI/MCP) as the first integration surface. IDE extensions come after (Milestone 7). Exact library choices (e.g. SQLite driver, LiteLLM proxy vs. SDK) will be confirmed against Lumen's pre-implementation research and recorded as new ADRs.
- **Alternatives:** LangGraph or similar workflow engine (only if it adds value; avoid framework stacking), Postgres (contradicts local-first), building IDE extensions first (spec says not to).
- **Consequences:** Milestone sequencing in `docs/project/ROADMAP.md` follows this order.
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
- **Consequences:** Cloud hosting, accounts, and subscription billing are out of scope (`docs/project/FUTURE_FEATURES.md`). The task graph, execution state, and file-conflict management are first-class engine concerns. Milestone 0 reflects this only in config (`SOOT_DATA_DIR` local default, no key handling) and docs.
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
- **Status:** Superseded by ADR-035 (Joseph reviewed data residency and lifted the hold, 2026-11-12). Originally Accepted (Mochi).
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
    - _Note (ADR-037, 2026-11-13):_ soot now ships a sourced price catalog (prices only, no model names or defaults) that fills in prices for configured models with none.
  - **DeepSeek (ADR-016):** any provider whose id or base URL host is DeepSeek is `restricted`. Restricted and `listed-only` providers are excluded from selection, and `createModelClient` / `discoverModelIds` refuse them before any network access.
    - _Note (ADR-035, 2026-11-12):_ the hold is lifted. There is no `restricted` reason or `providerRestriction` any more; only `listed-only` providers are excluded and refused. A DeepSeek provider configured like any other is selectable and callable.
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
    - _Note (ADR-035, 2026-11-12):_ the restricted (DeepSeek) check is gone; a configured DeepSeek model is filtered like any other.
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
    - _Note (ADR-035, 2026-11-12):_ DeepSeek is no longer excluded; listed-only providers still are.
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
- **Status:** Accepted (Mochi authorised starting M7 locally; Sweed chose the details under ADR-012). The on/off bullet is superseded by ADR-041.
- **Context:** Milestone 7 asks for IDE visibility and control while core orchestration stays independent of any IDE. Spec §8.B lists what the extension should show: orchestration on/off, task graph, active agents, assigned models, execution status, escalation events, estimated and actual cost, retries and failures, task cancellation. ADR-009 keeps UI simple and block-shaped.
- **Decision:**
  - `apps/vscode-extension` (`soot-vscode`, private, version 0.0.0) is an ESM extension (`"type": "module"`, VS Code `^1.100`). It has **no runtime dependencies** and imports no `@soot/*` package. It runs `node <soot.cliPath> <command> --json` in the workspace folder (no shell) and reads the JSON. Orchestration stays in the engine; a test asserts the extension imports nothing from it.
  - Runs started from the editor are **unattended** (no terminal on stdin): soot refuses approval-needing work and leaves results on the integration branch. The extension never approves, has no approve-all, and does not change host approval settings.
  - View: one tree (`soot.runs`) and one plain-text board (`soot: Show board`), built from stacked text blocks (`[■ task · demo-small→demo-mid · 2x]`, graph by dependency layer). No webview, no dashboard. Status is polled from `soot status <run>`, one call at a time.
  - Engine additions the extension needs, usable from the CLI and MCP too: `soot stop <run> --task <id>` / `soot_stop {runId, taskId}` cancels one task through `Scheduler.cancel(taskId)` (dependents skipped, other tasks continue), signalled by a `<run>.stop-task.<id>` control file; the run's routing events are appended live to `reports/<run>.events.jsonl`; `soot status <run>` adds per-attempt details, `running`, and the events.
  - Orchestration on/off is a workspace setting (`soot.enabled`, default off); runs are refused while off. _(Superseded by ADR-041: the commands keep on/off in VS Code's workspace storage; the setting is only a default.)_
  - A `.vsix` can be built locally with `pnpm dlx @vscode/vsce@4.1.0 package` (not a devDependency, so no publishing tool sits in the lockfile). Nothing is published.
- **Alternatives:** importing the engine into the extension host (couples the IDE to the engine, and native SQLite in Electron); talking to `soot mcp` over stdio (needs an MCP client dependency in the extension; the CLI JSON is simpler); a webview dashboard (against ADR-009); file watching instead of polling (deferred).
- **Consequences:** The same extension should load in VS Code-compatible editors, but each editor counts only after its own verified run. It needs a local soot checkout and Node 24 on the machine. First run in a real editor on 2026-11-14 (VS Code 1.144.0, macOS, M7-01); not run in Cursor or any other editor.
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
  - _Note (2026-11-12, page order; Joseph asked, Mochi):_ the run view leads with a compact ident (id, state, duration), the assignment graph, and the usage/outcome/cost charts (legend just after usage-by-model). Text details (task graph, tasks and models, active agents, full prompt, savings) come after. Same blocks and data; no new chart types or API change.

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

  - _Note (ADR-034, 2026-11-12):_ the deferred CLI part is now done at the config and engine layer: `decomposer.model` in `soot.config.json` selects a registry model, and the engine passes a client to `createDecomposer` only when one can be built. Still verified with mock clients only; no real model has decomposed a prompt.

## ADR-034: Decomposer model is chosen in soot.config.json; fixtures stay the default

- **Date:** 2026-11-12
- **Status:** Accepted (Mochi, on Joseph's "let's add the config surfaces"). Implemented and verified with mock model clients only.
- **Context:** ADR-033 added `ModelDecomposer`/`createDecomposer`, but the CLI and MCP engine hardcoded `FixtureDecomposer`, so there was no way to use it outside the library. M2-07 is still Blocked: no real provider may be called and no keys are configured.
- **Decision:**
  - `soot.config.json` gets an optional, strict `decomposer: { model }`. `model` is a reference `provider/modelId` from the user's own registry file; soot ships no default and names no vendor. The config file stays protected from task edits.
  - The engine resolves it per command: not configured, fixture-only; configured and a client can be built through `createModelClient` (the model is in the registry, the provider is callable, the model is not configured without structured output, the `apiKeyEnv` variable is set in the environment soot was started with), `createDecomposer({ fixtures, model: client })`; otherwise "unusable" with a reason, fixture-only, no client and no request. `.env` files are not read (ADR-030); keys are read only in the adapter layer (ADR-022), and the planner still never builds a client.
  - Recorded prompts are answered from fixtures with no model call. An unknown prompt with an unusable model fails with a message naming the setting, the model and the reason and saying no model was called. Model failures and invalid answers are reported with `ModelDecompositionError`'s reason; there is no fallback to a guess or a similar fixture.
  - `soot config` reports the setting and `not-configured` / `usable` / `unusable` (with reason), checked by building a client without calling it. No key value is printed.
  - The decomposer model is used only for decomposition. Routing and execution are unchanged: `soot run` still needs `--agent mock` or `--agent acp`.
- **Alternatives:** a CLI flag or environment variable naming the model (the project config is already the shared CLI/MCP source and is protected; a flag could follow later); a top-level `decomposerModel` string (a small object leaves room for limits without another breaking shape); silently falling back to fixtures-only when the model is unusable without saying so (hides misconfiguration; rejected); picking a default model from the registry (would spend the user's money without an explicit choice; rejected).
- **Consequences:** Users who configure a model and key can decompose prompts with no fixture, but nothing has run against a real model, so prompt quality, token use and failure rates are unknown. Decomposition tokens appear in the run report but are not yet counted in the cost report or run budget, and the decomposer call does not consult provider cooldowns (TECHNICAL_DEBT). TASKS P-02 is Implemented, not Verified; M2-07 stays Blocked; M6 and M7 statuses are unchanged.
- **Reversible:** Yes. Removing the field restores fixture-only behaviour.

## ADR-035: DeepSeek data-residency hold lifted; DeepSeek is an optional, user-configured provider

- **Date:** 2026-11-12
- **Status:** Accepted (Joseph reviewed data residency and approved lifting the hold, 2026-11-12). Supersedes ADR-016. Implemented and verified with mocks and fake `fetch` only.
- **Context:** ADR-016 kept DeepSeek off the default path until Joseph reviewed data residency. The registry marked any provider whose id contained `deepseek` or whose base URL host was `deepseek.com` as `restricted` (`data-residency-review`): never selected, and `createModelClient` / `discoverModelIds` refused it. Joseph has now reviewed data residency and wants to be able to use DeepSeek, including for decomposition (ADR-034).
- **Decision:**
  - The hold is lifted. `providerRestriction`, the `ProviderRestriction` type, `ModelRegistry.restriction` and the `restricted` exclusion reason are removed; there is no vendor-specific restriction left. `isCallable` refuses only `kind: "listed-only"`, which is still never called.
  - DeepSeek may be configured like any other OpenAI-compatible provider: id `deepseek`, `kind: "openai-compatible"`, `baseURL: "https://api.deepseek.com/v1"`, `apiKeyEnv: "DEEPSEEK_API_KEY"`, with models such as `deepseek/deepseek-chat` described by the user (capabilities, pricing, context window). It is then selectable, routable, callable and usable as `decomposer.model`.
  - soot still ships no default model and names no vendor in its default or demo config; `decomposer.model` is never set to DeepSeek (or any vendor) in committed config. The demo registry keeps its fictional providers. _(ADR-037, 2026-11-13: the demo registry now uses real model ids with real sourced prices; still no default and no `decomposer.model`.)_
  - Demos and automated tests must not make live DeepSeek calls, or live calls to any provider. Tests that show DeepSeek is callable use a fake `fetch` and fake key values.
  - BYOK still applies (ADR-011, ADR-017): the key is the user's own, read only by `@soot/provider-adapters` from the environment soot was started with (ADR-022, ADR-034).
- **Alternatives:** an explicit opt-in flag for DeepSeek (rejected: configuring the provider and its key is already an explicit opt-in, and a vendor flag would keep vendor-specific policy in code); keeping the restriction hook with no values (rejected: dead code).
- **Consequences:** A user who configures DeepSeek and sets `DEEPSEEK_API_KEY` can route to it and use it for decomposition. No live DeepSeek request has been made in this change, so its wire behaviour, structured-output support and decomposition quality are unverified; M2-07 stays Blocked and TASKS P-01/P-02 stay Implemented, not Verified. `soot models --json` no longer has a `restriction` field.
- **Reversible:** Yes, by a new decision restoring a restriction.

## ADR-036: Optional `structuredOutputMode` (`json_schema` or `json_object`)

- **Date:** 2026-11-12
- **Status:** Accepted. Implemented and verified with mocked HTTP / fake `fetch` only.
- **Context:** soot's default structured-output path asks Chat Completions endpoints for
  `response_format: { "type": "json_schema", ... }`. Some OpenAI-compatible endpoints accept
  only JSON mode, `response_format: { "type": "json_object" }`, and reject `json_schema` with
  an invalid-request error. Those endpoints typically also require the word "json" in the
  prompt. soot already parses the model text as JSON and validates it against the request
  schema (`parseTask` / `buildTaskGraph` for decomposition). The missing piece was a way to
  request JSON mode on the wire without vendor-specific branches in code.
- **Decision:**
  - The model registry accepts an optional `structuredOutputMode` of `"json_schema"` (default)
    or `"json_object"` on a model, and the same field on a provider as a default. The model
    setting wins if both are set. The resolver is `structuredOutputMode(provider, model)`.
  - When the effective mode is `json_object`, the Chat Completions client sends
    `response_format: { "type": "json_object" }` (not `json_schema`). The JSON is then parsed
    and validated against the caller's schema. A bad parse or a schema mismatch is
    `invalid-output`. There is no partial graph, and errors do not include prompt text.
  - For `json_object`, if the caller's system and messages do not already contain the word
    "json", the client adds a short system line (`Return a JSON object.`). The decomposer
    system prompt already names JSON and the `{ "tasks": [...] }` shape.
  - The setting is vendor-neutral. There are no provider-id or hostname checks. Users who
    need JSON mode set the field in their registry (for example on an OpenAI-compatible
    model whose endpoint does not implement `json_schema`).
- **Alternatives:** hard-coding a vendor id or hostname to switch modes (rejected: puts
  vendor policy in code, ADR-035 already removed that pattern); sending `json_schema` and
  retrying as `json_object` after a 400 (rejected: an extra live call, and the config should
  describe the endpoint's capability up front); treating `json_object` as unvalidated free
  text (rejected: soot must still validate against the task contract).
- **Consequences:** A user can configure JSON mode for any provider that needs it. Automated
  tests cover the wire body, valid JSON, invalid JSON, and schema mismatch with fake `fetch`
  only. A live `json_object` decomposition is a separate, explicit check and is not implied
  by this change.
- **Reversible:** Yes, by removing the field (the default remains `json_schema`).

## ADR-037: Sourced price catalog, a pricing-refresh prompt, and real model names in the demo

- **Date:** 2026-11-13
- **Status:** Accepted (Mochi, at Joseph's request). Implemented; verified with tests and mock
  clients only. Amends ADR-022 ("soot ships no prices") and the demo-registry sentence of ADR-035.
- **Context:** soot prices every task and the planning call as reported tokens × list price.
  With no prices in the user's registry, live runs showed "price not set" everywhere. Joseph
  asked for real prices for frontier and popular models, a prompt that AI agents run to look
  up a model's current price whenever a new key/provider or model appears, and real model
  names in the demo so the numbers are easy to relate to.
- **Decision:**
  - `@soot/model-registry` ships `PRICE_CATALOG` (`price-catalog.ts`): official list prices for
    popular hosted models, each with the official pricing page URL (`source`) and the date
    checked (`asOf`). It holds **prices only**: it adds no models, picks no default, and sets
    no `decomposer.model`. A configured model with `pricing: null` gets the catalog price when
    its provider's API host (from `baseURL`, else the SDK default for `anthropic` / `openai`)
    and its exact model id match an entry. A configured price always wins. Proxies, resellers
    and local runtimes do not match.
  - Prices can carry a `longContext` tier (`aboveInputTokens` plus rates). A request whose
    input exceeds it is billed at those rates for every token. Catalog entries can carry
    `effectiveFrom` / `effectiveUntil` for announced price changes; the entry in effect on the
    run's day (UTC) is used.
  - No automatic network calls. Prices are updated by the **update-model-pricing** prompt
    (`skills/update-model-pricing/SKILL.md`): official pages only, record source and date,
    never guess, never touch secrets.
  - Trigger: `soot run` (as a warning), `soot config` and `soot models` list callable models
    that still have no price and point to that prompt. `soot config --json` has
    `pricing: { catalogPriced, unpriced }`; `soot models --json` has `priceFrom` per model.
  - The planning (decomposition) call is priced from its reported usage. The saved report's
    `decomposition` gets `costUsd` (`null` when unpriced or usage is not reported) and
    `priceBasis`. `soot status <run> --json` now includes `decomposition`.
  - The demo registry (`examples/demo-app/models.json`) uses real model ids and their real
    sourced prices (Claude Haiku 5.5, GPT-6.1 Terra, Claude Opus 5.5). Reliability priors stay
    fictional and labeled. The mock agent is still a labeled test double with fictional usage;
    no model is called.
- **Alternatives:** scraping prices at runtime (rejected: network calls, fragile, unverifiable);
  a built-in model list (rejected: ADR-019's thin registry, and it would imply defaults);
  matching on model id alone (rejected: a proxy can bill differently); modeling DeepSeek's
  off-peak discount (deferred: soot has no time-of-day pricing, so the catalog uses the peak
  rate, an upper bound, and says so in `notes`).
- **Consequences:** Live runs against priced vendor models show real costs. Catalog prices go
  stale; the prompt, the `asOf` date, and dated entries keep that visible. Batch, flex and
  priority tiers, regional uplifts and per-request tool fees are not modeled.
- **Reversible:** Yes. Remove the catalog call in the CLI and prices come only from config again.

## ADR-038: Dashboard prompt box: plan and run from `soot dashboard --agent`, behind a token, in allowlisted folders

- **Date:** 2026-11-13
- **Status:** Accepted (Joseph: "let's build out the soot local dashboard first", "it should
  auto run", "this prompt input dashboard should be the default", "it's just like a regular
  prompt. no approval needed"; design by Prism; open questions decided by Mochi). Implemented;
  verified with tests and the mock runner only. Amends ADR-031 (the dashboard was read-only
  with no login).
- **Context:** Users could only give soot a prompt from the CLI or an MCP host. The local
  dashboard showed runs but had no input. A page that can start work on the user's code needs
  a real access boundary: a loopback port is reachable by every local process and, through
  DNS rebinding or cross-site requests, by web pages.
- **Decision:**
  - **Engine split.** `SootEngine.run()` is now `plan()` (config, registry, runner check,
    decomposition; no store writes, worktrees or run lock) followed by `runPlan()` (today's run
    from the run lock and `store.createRun` onward; a plan runs at most once; `onRunStarted`
    fires once the run is recorded). `soot run` and `soot_run` call `run()`, so their behaviour
    and output are unchanged. `previewPlan()` routes each task like the supervisor's first
    assignment (stored history and provider cooldowns) and adds a worst case: every attempt the
    escalation config allows (`maxAttemptsPerTask`) on the priciest model the router accepts for
    that task, capped by `taskBudgetUsd` / `runBudgetUsd` when set, plus the planning call.
  - **Auto-run, no approve step.** Submitting a prompt plans it and runs it at once, like a
    chat prompt. The page shows the plan (tasks, first-choice model, estimates) as soon as it
    exists, then live state per task, cost so far and the worst case, with Stop and a per-task
    stop always visible. Stop has no confirm step.
  - **The prompt box is the landing view** (`#/`). Overview moved to `#/overview` (old
    `#/?zoom=` links still open it); the run list is History at `#/history` (old `#/prompts`
    links still open it; ADR-042). While the user types or a
    prompt is working, the page drops to focus mode: the tabs and header meta fade out and only
    the prompt (or the submitted prompt), a compact task list and Stop remain, with a small
    `details` link to the full prompt page.
  - **Writes only with an explicit runner.** Plain `soot dashboard` stays read-only (the box is
    disabled and says how to enable it). `soot dashboard --agent mock --mock-script <file>` or
    `--agent acp` turns it on. The runner is fixed for the life of the process and labeled
    honestly (`mock (test double)`, or `acp (<command>)` per project).
  - **The run lives in the dashboard process** (v1). Stopping the dashboard (Ctrl-C) aborts
    every run it started, through the existing run signal; the page says so. Closing the tab
    does not stop a run.
  - **Approvals are unattended in v1.** Approval-needing actions are refused, never granted.
    This includes soot's own `integrate-into-working-tree` step, so a dashboard run leaves its
    result on `soot/<run>/integration` and reports `incomplete`; the page shows that problem.
    "No approval needed" in the product request is honoured as "no approve step before the
    run", not as auto-approving file deletes or working-tree updates (ADR-018 still holds).
  - **Access token (Jupyter style).** `soot dashboard` prints
    `http://127.0.0.1:<port>/?token=<256-bit base64url>`. Opening it swaps the token (constant
    time compare) for `soot_session_<port>=<random>; HttpOnly; SameSite=Strict; Path=/` and
    `303 → /`, so the token leaves the address bar. The cookie name carries the port because
    cookies are not port-scoped. Scripts may send `Authorization: Bearer <token>`. Every page
    and API request needs a session; without one the page is a static access gate and the API
    is `401 auth_required`. Only CSS, the script and logos (no data) load without one. The
    token is never written to disk and changes with every start.
  - **Writes need more.** Every POST needs `Content-Type: application/json` (else 415). Cookie
    sessions also need `Origin` exactly `http://127.0.0.1:<port>` or `http://localhost:<port>`,
    `Sec-Fetch-Site: same-origin` when the browser sends it, and `X-Soot-CSRF` equal to the
    session's value from `GET /api/session` (else `403 csrf`). Bearer requests are not ambient,
    so they skip the CSRF header, but a foreign `Origin` is still refused. The Host check (421)
    stays first. No `Access-Control-*` header is ever sent. Bodies are capped at 300 KiB and
    prompts at 256 KiB.
  - **Folder allowlist in the user's state dir.** `<dataDir>/dashboard.json` (mode 0600), never
    in the repository (a cloned repo cannot allow itself). Only the CLI writes it:
    `soot dashboard allow <dir>` (the folder must hold a loadable `soot.config.json`; its real
    path is stored), `disallow <dir|id>`, `list`. The browser sends an opaque id
    (`p_` + 16 hex of sha256(realpath)); the server resolves it and refuses a folder whose real
    path changed since it was allowed (e.g. swapped for a symlink). Request bodies with any
    field other than `project` and `prompt` are refused.
  - **Keys:** responses carry provider ids, key variable names and `set` / `missing` /
    `none-needed` only. Presence is checked without keeping the value; the value is read only
    by the provider adapters inside the engine (ADR-022).
  - **Endpoints:** `GET /api/session`, `GET /api/projects`, `GET /api/keys/status?project=<id>`,
    `POST /api/prompts` `{project, prompt}` (optional `Idempotency-Key`; 202 with the job; 409
    `project_busy` when the project already has a live job), `GET /api/prompts`,
    `GET /api/prompts/<job>`, `POST /api/prompts/<job>/cancel` (aborts planning, or writes the
    run's stop file), `POST /api/runs/<run>/cancel` `{task?}` (only runs this dashboard
    started; `soot stop` stays the way to stop others). Live status is polling (1 s); SSE is
    deferred. Jobs are kept in memory (last 50).
- **Alternatives:** an Approve step bound to a plan digest (Prism's design; dropped at Joseph's
  request: it is a prompt box, not a review queue); a spawned `soot run --plan` child that
  survives the dashboard (needs a signed plan file; deferred); browser-side folder adding
  (rejected: the page could then widen its own access); an approval card in the page (v2);
  auto-approving the working-tree step (rejected: ADR-018).
- **Consequences:** The dashboard can now change code in allowlisted folders, but only after
  someone with the printed link opens it on this machine, and only with the runner chosen at
  start. Existing `soot dashboard` users must open the printed link once per start. With
  `--agent mock` every task is the scripted test double; real model execution is still
  M2-07. The plan preview and the run share one decomposition, so what is shown is what runs.
- **Reversible:** Yes. Without `--agent` nothing can be written; removing the token check
  restores ADR-031's read-only page.

## ADR-039: Direct-API task runner (`--agent api`), landing verified results with `--apply`, runner-tagged routing history, link file

- **Date:** 2026-11-13
- **Status:** Accepted (Joseph: "make sure it pass / do a test so we actually send to models /
  let's get some real data").
- **Context:** Until now every task ran on the scripted mock or an ACP agent; no routed model
  ever did a task's work, so soot had no real token or cost data. Two smaller problems showed up
  on the way. (1) A dashboard smoke run left a real task "unroutable": mock outcomes are stored
  against the routed model ref (ADR-030 routing feedback), so failures of the no-op test double
  lowered the reliability of real models. Unknown context windows also excluded hosted models
  that had no `contextWindow` configured. (2) Unattended runs could never land a verified result
  (ADR-018), so every dashboard run ended "incomplete", and `soot dashboard` wrote its token link
  into any file its output was redirected to.
- **Decision:**
  - **`--agent api`** (`ApiAgentRunner`, `apps/cli/src/api-runner.ts`). Per attempt it builds a
    client for the routed model with `createModelClient` (keys stay inside
    `@soot/provider-adapters`, ADR-022), sends the task's instructions, acceptance criteria,
    allowed and readable files with their current contents (per-file 64 KiB, total 256 KiB),
    prerequisite summaries and earlier attempts' findings (never the original prompt), and asks
    for JSON `{summary, edits: [{path, content}], notes?}` with **complete file contents**.
    Whole files over diffs or search/replace: no hunk matching to fail, easy to validate, fine
    for the small files tasks are planned around. Every path must be relative, normalized,
    inside the worktree, not under `.git`, and not through a symlink; one bad path fails the
    attempt and nothing is written. soot then commits, checks, merges and reports exactly as
    for any runner, so scope, no-change and validation rules are unchanged.
  - **Usage and cost** are the provider's reported tokens summed over the attempt's calls,
    priced with `actualCostFromUsage` (configured price, else the ADR-037 catalog). Missing
    usage makes the cost unknown, never 0.
  - **Failures.** A reply that is not the JSON object gets one repair round (the model sees its
    reply and the parse error); a second bad reply, or a reply cut off at the output limit,
    fails the attempt with its usage. Empty `edits` is a success with no change, which soot
    records as `no-changes`. Timeouts, 429s, 5xx and missing keys surface as `ProviderError`s
    so the supervisor retries, falls back or escalates (ADR-024). An `openai-compatible`
    provider that names an `apiKeyEnv` whose variable is unset is now refused (`auth`) instead
    of sending an unauthenticated request; keyless endpoints omit `apiKeyEnv`.
  - **Dashboard** `soot dashboard --agent api` uses the same runner; the label says "api (routed
    models, called directly)".
  - **Routing history is tagged with its runner** (state schema v5:
    `model_outcomes.runner`). `api` and `acp` runs read only `api`/`acp` outcomes; mock runs
    read everything, so the fixture demo of routing feedback still works. Rows from before v5
    are `unknown` and no longer shape real-model routing.
  - **Unknown context window:** a hosted (non-local) model with no `contextWindow` is assumed
    to take `HOSTED_CONTEXT_FLOOR` (32,000) tokens, so ordinary tasks can route to it; larger
    tasks and local endpoints still need the window configured. Reliability priors stay the
    user's: soot ships none and still excludes a model with no prior and too little history.
  - **`--apply`** (`soot run`, `soot dashboard`) pre-approves exactly one action for that
    invocation: fast-forwarding the checked-out branch to the integrated result. The workflow
    asks only after every merged task was verified and final validation passed, and still
    refuses when the working tree is dirty or HEAD moved. Every other approval is unchanged
    (asked interactively or refused). Without `--apply` a verified result stays on
    `soot/<run>/integration` and the run is `incomplete` with that reason, as before.
  - **Token link:** printed only when stdout is a terminal. It is always written to
    `<dataDir>/dashboard-link-<port>.txt` (0600, atomic) and removed when the dashboard stops;
    SIGTERM now stops the CLI as cleanly as Ctrl-C. `--open` opens the link either way. JSON
    output gives `url` without the token when stdout is not a terminal, plus `linkFile`.
- **Verification:** unit tests against a fake OpenAI-compatible server (request content,
  whole-file writes, exact usage and cost, repair round, unusable replies, empty edits, refused
  paths and symlinks, timeout, 429, missing key); an end-to-end `soot run --agent api --apply`
  on the demo app with the fake server (complete, landed) and without `--apply` (left on the
  integration branch). Live on 2026-11-13 with the user's keys on a throwaway demo repo:
  planner deepseek/deepseek-flash, tasks on deepseek/deepseek-flash and xai/grok-4.7, all
  verified by the project's tests and landed with `--apply`, once from `soot run` and twice
  from the dashboard.
- **Alternatives:** unified diffs or search/replace blocks (smaller replies, but models often
  produce hunks that do not apply; can be added for large files later); tool calling with a
  file-edit tool loop (more round trips and spend; not needed for single-shot edits); counting
  `verified` tasks as `complete` when the working tree is not updated (would hide that nothing
  landed); approving integration in every unattended run (contradicts ADR-018); shipping
  default reliability priors for vendor models (would be guesses).
- **Consequences:** soot can now do real work with the user's own keys and records real token
  and cost data per attempt. Model output quality is whatever the routed model produces; soot
  only accepts it when its own checks pass. Large files (over 64 KiB) are not sent, so tasks on
  them fail rather than guess. Stored outcomes from mock runs no longer influence real routing.

## ADR-040: Wall-clock limit per model call, native Anthropic verified, reasoning tokens counted

- **Date:** 2026-11-13
- **Status:** Accepted (Joseph approved a per-try time limit and Claude/GPT support; no
  Anthropic or OpenAI key is available yet, so those two are verified with fake servers only).
- **Context:** In the recorded dashboard run (ADR-039) one `xai/grok-4.7` try took 538 s.
  The audit log shows the time was all inside the model call: the attempt started at
  16:18:05.6 and the runner returned at 16:27:03.5 (UTC), and soot's check then took 108 ms.
  The engine had passed a 600 s per-request limit, and the provider adapter retries
  `timeout` and `unavailable` errors up to 3 times per call, each with a fresh 600 s, so one try
  could last up to 30 minutes (the scheduler's attempt timeout). A live replay of the same task
  on 2026-11-13 (the same request, a single adapter attempt) ran 270 s and then xAI closed the
  connection ("other side closed") without an answer. The most likely account of the 538 s is
  therefore two requests of about 270 s each: the first dropped by xAI and retried inside the
  adapter (invisible in soot's history, with no usage reported), the second answering in about
  268 s. A tiny live probe also showed that xAI reports reasoning tokens outside
  `completion_tokens` (`total_tokens` = prompt + completion + reasoning), which the AI SDK
  assumes are inside, so soot under-counted Grok's output tokens and cost.
- **Decision:**
  - **`modelCallTimeoutMs`** (soot.config.json, default 120,000 ms): a wall-clock limit on one
    model call. For `--agent api` it covers one try: both rounds and the adapter's own retries.
    On expiry the HTTP request is aborted through its AbortSignal (the result also rejects if a
    request ignores the abort), and the try throws a `timeout` `ProviderError`. The existing
    escalation rules handle it: retry the same model up to `transientRetries`, then fall back to
    another provider. The planner call has the same limit; on expiry the run stops before any
    task with "the planner model … timed out after 120s".
  - **Visible:** the message reads "timed out after 120s waiting for <model>" in the attempt
    history (`soot status`) and in the dashboard timeline; the scheduler's own attempt timeout
    now reads "attempt timed out after 30 min" instead of milliseconds. A timeout stays out of
    the routing history (ADR-030), which records whether soot verified a model's work, not
    latency.
  - **Anthropic:** the `anthropic` kind already used the native Messages API through
    `@ai-sdk/anthropic` (`x-api-key`, `anthropic-version`, content blocks,
    `input_tokens`/`output_tokens`). It is now covered end to end for both the planner and the
    api runner against a fake Messages server, with catalog prices. `openai` (Chat Completions)
    is covered the same way. Neither is called without its key.
  - **Reasoning tokens:** when a Chat Completions usage object shows `total_tokens` = prompt +
    completion + reasoning, soot adds the reasoning tokens to the output count (they are billed
    as output). Decided from the numbers only, never from a provider id.
- **Verification:** unit tests with fake slow and hung servers (limit fires, the request is
  aborted, the limit spans adapter retries and the repair round, a slow reply inside the limit
  is used, cancelling is not a timeout); an end-to-end run where the first call of one task
  hangs and is retried (state `retried` then `succeeded`, message in `soot status`, retry in
  the audit log); a hung planner; Anthropic + OpenAI end to end (planner and one task on
  Claude, one task on GPT, wire format and headers checked, catalog-priced cost, result
  landed); a missing key sends no request; reasoning-token accounting both ways. A ready live
  script (`/tmp/soot-live-claude-gpt.sh`, outside the repo) runs the same flow on real
  Anthropic and OpenAI once keys exist.
- **Alternatives:** keep a per-request limit only (an adapter retry restarts the clock, which is
  how one try reached 9 minutes); stream with an idle timeout (more moving parts; the api runner
  does not need tokens as they arrive); count timeouts as failed results in routing history
  (would mix latency into the quality signal); detect "reasoning outside completion" by
  provider id (vendor-specific; the totals already say it).
- **Consequences:** a slow model now costs at most about 120 s per try before soot retries or
  falls back, and the user sees why. Reasoning-heavy models that need more than 120 s on a task
  need a larger `modelCallTimeoutMs`. A timed-out request has no reported usage, so its tokens
  (which the provider may bill) are missing from soot's cost. Grok costs recorded before this
  change are under-counted by their hidden reasoning tokens.

## ADR-041: VS Code extension keeps on/off in workspace storage, not settings files

- **Date:** 2026-11-14
- **Status:** Proposed (skier537, from the first real-editor run of the extension, M7-01;
  awaiting Joseph's review). Supersedes the on/off bullet of ADR-029.
- **Context:** ADR-029 made orchestration on/off a workspace setting, and
  `soot: Enable orchestration` wrote it with `ConfigurationTarget.Workspace`. In VS Code that
  writes `"soot.enabled": true` to `.vscode/settings.json` in the repository. Many projects
  track that file, and so did the demo copy used for M7-01. The repository became dirty, and
  the next `soot: Run a prompt` was refused: "working tree … has uncommitted changes; commit or
  stash them first: M .vscode/settings.json". The unit tests missed it because the fake
  `vscode` module keeps settings in memory and writes no file.
- **Decision:**
  - `soot.enable` / `soot.disable` store on/off in `context.workspaceState` (key
    `soot.enabled`): VS Code's per-workspace storage, kept outside the repository. They never
    call `getConfiguration().update`.
  - The `soot.enabled` setting stays as a default, so a team can still commit "on" on
    purpose. The value in workspace storage wins once Enable or Disable has been used in that
    workspace.
  - The fake `vscode` module records every settings write (`fake.settingWrites`) and provides
    a `workspaceState` Memento (`extensionContext()`). Tests assert that Enable and Disable
    write no settings.
- **Alternatives:** `ConfigurationTarget.Global` (turns soot on in every workspace at once);
  having soot ignore `.vscode/` when checking for a dirty tree (hides real edits and changes the
  engine's safety rule to suit one adapter); removing the setting entirely (breaks teams that
  commit it, and the setting is a useful default).
- **Consequences:** Turning soot on or off never touches the repository. On/off is now per
  machine and per workspace: it is not shared through git unless the team commits the setting.
  Workspaces that already have the setting committed keep working as before. Unit-tested;
  not yet re-run in a real editor.
- **Reversible:** Yes.

## ADR-042: Dashboard run list is History at `#/history`

- **Date:** 2026-11-14
- **Status:** Accepted (Joseph: "change Prompts into History", then "Stick with History").
  Amends the route names in ADR-038.
- **Context:** The landing tab is **Prompt** (the input box). The list of past runs was also
  labelled **Prompts**, at `#/prompts`, which made the two easy to mix up.
- **Decision:** Rename the tab and its page heading to **History**, and move the list to
  `#/history` (and a run's detail to `#/history/<runId>`). Old `#/prompts` and
  `#/prompts/<runId>` links, including `?from=&to=` window filters, still open the same
  views, the same way old `#/?zoom=` links still open Overview. Internal names
  (`renderPrompts`, `view: 'prompts'`, `tab-prompts`) stay. Overview copy such as
  "Prompts / recorded runs" and "Prompts over time" is unchanged.
- **Alternatives:** "Runs" (clear, and soot already uses that word; Joseph chose History);
  keep the `#/prompts` path and only change the label (leaves the URL confusing next to
  the Prompt tab).
- **Consequences:** Bookmarked `#/prompts` links keep working. New links the dashboard
  writes use `#/history`.
- **Reversible:** Yes.
