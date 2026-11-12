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
- **[Intentional] No coverage reporting or thresholds yet.** Still open after Milestone 1.
- **[Intentional] No release/versioning tooling** (e.g. changesets). Packages are `private`, `0.0.0`.

## Code

- **[Intentional] 7 of 13 workspace packages are still stubs** (`cli`, `model-registry`,
  `model-router`, `escalation`, `provider-adapters`, `harness-adapters`, `integrations`).
  Package boundaries are kept (ADR-019).
- **[Intentional] Decomposition is fixture-only.** `FixtureDecomposer` matches recorded
  prompts and refuses others; there is no prompt analysis. Model-backed decomposition comes
  after Milestone 2. Fixture token estimates are placeholders, not measurements.
- **[Intentional] Agents are mocks.** `MockAgentRunner` is the only runner. Scheduler
  `succeeded` means agent-reported success with a valid result, not verified evidence; the
  acceptance-criteria and evidence check is Milestone 5.
- **[Intentional] No retries, timeouts, or escalation in the scheduler** (Milestone 4). A hung
  runner blocks its task until cancelled.
- **[Intentional] No orchestrator wiring module.** The intake → decompose → graph → schedule →
  store flow is wired in `tests/m1-end-to-end.test.ts`; a reusable entry point arrives with
  the CLI/skill (Milestone 6) or earlier if Milestone 5 needs it.
- **[Intentional] Write conflicts use declared file sets only.** Conflicting unordered tasks
  are serialized in declaration order; actual writes are not checked until worktrees and
  leases (Milestone 5, ADR-019).
- **[Intentional] JSON Schema omits cross-field rules** (no self-dependency, unique items,
  path segment rules). Only the TypeScript validators enforce them.
- **[Intentional] Timing-based concurrency tests** use 150 ms mock delays and bounds of
  roughly 2× the delay. Very slow CI machines could make them flaky; widen bounds before
  weakening the overlap assertions.
- **[Intentional] The kill/restart test builds all packages** (`tsc -b`) in `beforeAll`
  because the child process runs the built output.
- **[Intentional] SQLite schema has no migrations yet** (version 1; other versions are
  refused). Scheduler timestamps in `RunReport` are process-monotonic; persisted times are
  wall-clock ISO strings.
- **[Intentional] `parseEnv` is not called by any runtime yet** and nothing loads `.env`
  files; it exists to fix the config contract for local-first state (`SOOT_DATA_DIR`).
- **[Intentional] Vitest projects are discovered by directory scan** in `vitest.config.ts`,
  and workspace packages are aliased to `src/` for tests. Packages under `apps/` other than
  `cli` need an alias entry when added.

## Provider connectivity (Milestone 2)

- **[Blocked] No real provider has been called (M2-07).** All adapter behaviour is verified
  against mocked HTTP shaped from SDK and provider documentation. Wire-format drift will only
  show up with user-supplied keys (ADR-011).
- **[Intentional] Provider health is in memory.** Cooldowns reset when the process restarts.
  Persist them in `soot.sqlite` when long-running orchestration needs it (Milestone 4).
- **[Intentional] OpenAI uses Chat Completions, not the Responses API** (ADR-022). Responses-only
  features (built-in tools, reasoning summaries) are unavailable until an adapter is added.
- **[Intentional] Pricing is flat per million tokens.** There are no long-context tiers,
  batch discounts, time-of-day pricing, or separate reasoning-token prices. Such models
  must be priced conservatively by the user or left unpriced (unknown).
- **[Intentional] Discovery results are not persisted** and discovery runs only when called.
  Discovered models stay unselectable until a user configures them.
- **[Intentional] Local endpoint (M2-03) not verified live.** The generic OpenAI-compatible
  adapter is covered by mocked HTTP. The live test skipped because no Ollama or LM Studio was
  running.
- **[Intentional] Messages are text only.** Images, files and multi-turn tool results are not
  in the `ModelClient` interface yet. The agent loop (Milestone 4) will need them.
- **[Intentional] Retry delays are capped at 30 s**, including `retry-after` values. Longer
  server-requested waits turn into a fallback/cooldown instead of a long sleep.

## Model routing (Milestone 3)

- **[Intentional] Complexity evaluation is heuristic** (ADR-023). It uses the planner's declared
  complexity, a capability rule table and token thresholds, and does no language
  understanding. Replace it with a model-backed evaluator once real providers are available
  (after M2-07).
- **[Intentional] Policy thresholds and the prior weight are untuned defaults.** Calibrate them
  from recorded history and benchmark runs (spec §17 Test 5, Milestone 6).
- **[Intentional] Success history is in memory.** Nothing aggregates attempts from `soot.sqlite`
  into `SuccessHistory` yet. Wire this up when real attempts exist (Milestone 4).
- **[Intentional] The routing log is in memory** (text and JSON Lines export). Persisting it with
  the run in `soot.sqlite` is part of the audit log (Milestone 5).
- **[Intentional] Latency is not part of routing** (spec §5 step 6). Availability is, through
  `ProviderHealth`.
- **[Intentional] Routing is done once per task.** Re-evaluation during execution (escalation
  and downgrade) is Milestone 4.
- **[Intentional] Routed estimates are not yet written back automatically** into cost records.
  `tests/m3-routing-end-to-end.test.ts` shows the wiring by hand. The runtime will do it when
  real execution lands.
- **[Intentional] The router tests use a fictional registry.** Its prices and reliability priors
  describe no real model.

## Documentation / community

- **[Intentional] No dedicated security or conduct contact address yet.** `SECURITY.md` and
  `CODE_OF_CONDUCT.md` point to private maintainer contact / GitHub private reporting after
  publish. Must be set before the first public release.
- **[Intentional] Spec-listed docs not yet written** (`installation`, `providers`,
  `model-routing`, `task-decomposition`, `harness-integrations`, `security`, `examples`).
  They will be written with the features they describe, to avoid documenting fiction.

## Security

- Provider keys are handled only by `@soot/provider-adapters` (ADR-022). There is no real agent
  execution yet. The state directory is created
  with mode `0700`; `soot.sqlite` stores the original prompt and structured results in plain
  text (no encryption at rest). Security requirements from
  spec §13 are tracked as tasks in `TASKS.md`.

## UI

- **[Intentional] No UI exists.** Future UI follows ADR-009 (simple, pixelated, Lego-block
  modules); polish is not debt.
