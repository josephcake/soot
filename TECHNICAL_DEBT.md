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

- **[Intentional] No workspace package is a stub any more;** `cli` and `harness-adapters` are
  partial (M6). Package boundaries are kept (ADR-019).
- **[Intentional] Decomposition is fixture-only.** `FixtureDecomposer` matches recorded
  prompts and refuses others; there is no prompt analysis. Model-backed decomposition comes
  after Milestone 2. Fixture token estimates are placeholders, not measurements.
- **[Intentional] Agents are mocks.** `MockAgentRunner` is the only runner; in Milestone 5 it
  writes scripted files into the worktree it is given. Since M5, "complete" means soot ran the
  configured checks on the task's real diff (ADR-025), but no real model has produced a diff.
  Harness runners are Milestone 6; real providers depend on M2-07.
- **[Intentional] Timeouts are opt-in.** Without `attemptTimeoutMs` a hung runner blocks its
  task until cancelled. Without a supervisor the scheduler runs one attempt per task.
- **[Resolved in M6] Orchestrator wiring.** `SootEngine` (`apps/cli`) is the reusable entry
  point used by the CLI and the MCP server (ADR-026).
- **[Intentional] Write conflicts are still planned from declared file sets.** Since M5 actual
  writes are checked from the real diff (out-of-scope edits fail the task) and overlapping
  diffs are reported, but scheduling itself uses only declared sets.
- **[Intentional] JSON Schema omits cross-field rules** (no self-dependency, unique items,
  path segment rules). Only the TypeScript validators enforce them.
- **[Intentional] Timing-based concurrency tests** use 150 ms mock delays and bounds of
  roughly 2× the delay. Very slow CI machines could make them flaky; widen bounds before
  weakening the overlap assertions.
- **[Intentional] Subprocess tests build all packages** (`tsc -b`) in `beforeAll` because the
  child process runs the built output (kill/restart, `soot stop`, `soot mcp`). The build is
  serialised by a lock directory under `node_modules/.cache` so parallel test files do not race.
- **[Intentional] SQLite migrations are hand-written** (v1→v2 in place; unknown versions are
  refused). There is no migration framework. Scheduler timestamps in `RunReport` are process-monotonic; persisted times are
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
  Milestone 4 marks health from attempt failures, but still in memory: a restarted run can
  retry a provider that was down. Persist health in `soot.sqlite` when runs get long.
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
- **[Intentional] Outcome history is wired in `soot run`.** Soot-verified outcomes in
  `soot.sqlite` (`model_outcomes`) are loaded before routing (ADR-026). Only mock agents have
  produced outcomes so far, so no history reflects a real model.
- **[Intentional] The routing log is in memory** (text and JSON Lines export). It is not yet
  written into the M5 audit log.
- **[Intentional] Latency is not part of routing** (spec §5 step 6). Availability is, through
  `ProviderHealth`.
- **[Intentional] Routing is re-done per attempt** (Milestone 4), but never inside an attempt.
- **[Intentional] Routed estimates are not yet written back automatically** into cost records.
  `tests/m3-routing-end-to-end.test.ts` shows the wiring by hand. The runtime will do it when
  real execution lands.
- **[Intentional] The router tests use a fictional registry.** Its prices and reliability priors
  describe no real model.

## Adaptive execution (Milestone 4)

- **[Intentional] Triggers rely on agent self-report** (`AgentResult.signals`: confidence,
  complexity, unmet criteria, tool errors). A dishonest or miscalibrated agent can avoid or
  cause escalation. Milestone 5 checks acceptance criteria against evidence.
- **[Intentional] Downgrade happens only at task start**, for dependents of `planReady` work.
  Switching models in the middle of an attempt needs a streaming agent loop.
- **[Intentional] Escalation and budget thresholds are untuned defaults** (ADR-024). Calibrate
  them from real runs after M2-07.
- **[Intentional] Spend uses routed estimates** when the runner reports no actual cost (mocks
  always do). Real costs depend on M2-07.
- **[Intentional] Run-budget spend lives in the supervisor's memory**; on resume it is rebuilt
  per task from persisted attempt history only as each task is planned again.
- **[Intentional] Latency is not a trigger.** Slow attempts are handled only by
  `attemptTimeoutMs`.
- **[Intentional] Backoff timing tests use real timers** with short delays (tens of ms) and
  lower-bound assertions.

## Codebase integration (Milestone 5)

- **[Intentional] No OS sandbox.** Worktrees isolate git state, not processes. A runner that
  writes outside its worktree is not visible in the diff. Real runners must be confined by the
  host harness's permissions or a sandbox (M6+). Check commands also run unsandboxed.
- **[Intentional] The command allowlist is per executable.** Allowing `node` allows any script
  and arguments from configuration; only configuration (never agents) supplies commands.
- **[Intentional] Injection detection is heuristic** (regex rules). It flags and audits; it does
  not block. Safety comes from permissions never being derived from untrusted text.
- **[Intentional] The audit log is a JSON Lines file per run**, not part of `soot.sqlite`, and is
  not rotated or signed.
- **[Intentional] Integration is all-or-skip per task.** A conflicting task is kept on its
  branch; soot does not attempt automatic conflict resolution or rebase-and-retry.
- **[Intentional] The fixture-repo tests use real git, `node --test` and `tsc`** with real
  timers; they take ~25 s and need git ≥ 2.38 (`merge-tree --write-tree`).
- **[Intentional] Provider health and run spend remain in memory** (unchanged from M4).

## Skill, CLI and MCP (Milestone 6)

- **[Blocked] No vendor harness has been run (M6-04, M6-05).** The generic ACP driver is tested
  only with soot's own mock ACP agent. Claude Code and Codex stay `not-implemented`. Real model
  execution without a harness also needs M2-07.
- **[Resolved in M6 for agents that advertise it] ACP routed model (ADR-028).** When the agent
  offers a `model` session config option, soot sets it to the routed model per attempt and
  records the outcome as routing history. Agents without that option (or that refuse or do not
  confirm the value) pick their own model; the run reports "route not applied" and those
  attempts are not counted. Matching is by exact ref or the id after `provider/`; no alias map.
- **[Intentional] ACP v1 reports no token counts.** Usage shows 0 tokens; cost only if the agent
  sends a USD `usage_update`. soot never estimates tokens to fill the gap.
- **[Intentional] ACP: one agent process and session per attempt.** No session resume or
  reuse; a retry starts fresh with soot's findings in the prompt.
- **[Intentional] ACP: soot offers only `fs/read_text_file` (worktree) and `fs/write_text_file`
  (write lease).** No terminal capability, no MCP servers. An agent that writes through its own
  tools instead of ACP is still caught by soot's diff check, but there is no OS sandbox: a
  spawned agent can touch anything its user can (see docs/security.md).
- **[Intentional] ACP permission details are agent-provided text,** cleaned and truncated before
  they are shown to the person approving. soot never selects "allow always"; when only that
  option is offered, approval becomes a cancel.
- **[Intentional] Read-only tasks also get a worktree as ACP `cwd`** (with no write lease), so
  the agent never runs in the user's checkout.
- **[Intentional] The skill is not verified in any product.** Installation is tested in temp
  directories; whether a host agent loads it and delegates is unverified.
- **[Intentional] MCP runs are unattended.** No elicitation: approvals are refused over MCP and
  results stay on the integration branch. The MCP server is tested with the official SDK client
  only (SDK v2.4.0; compatibility with older clients is untested).
- **[Intentional] Stop and status use files in the state directory** (`control/<run>.lock`,
  `.stop`, polled every 200 ms). A run whose process died shows as `interrupted`; there is no
  daemon and no automatic resume from the CLI yet.
- **[Intentional] Prompts must match a recorded fixture** (spec examples or the project's
  `fixtures` file). Arbitrary prompts are refused until model-backed decomposition exists.
- **[Intentional] The quick start needs a local copy of the repo.** Nothing is published; it was
  reproduced from a fresh clone on the build box only, not on another machine or OS.
- **[Intentional] `soot models` does not probe providers.** It reports the registry and policy;
  availability comes from configuration.

## Documentation / community

- **[Intentional] No dedicated security or conduct contact address yet.** `SECURITY.md` and
  `CODE_OF_CONDUCT.md` point to private maintainer contact / GitHub private reporting after
  publish. Must be set before the first public release.
- **[Intentional] Spec-listed docs not yet written** (`installation`, `providers`,
  `model-routing`, `task-decomposition`, `harness-integrations`, `security`, `examples`).
  They will be written with the features they describe, to avoid documenting fiction.

## Security

- Provider keys are handled only by `@soot/provider-adapters` (ADR-022). There is no real agent
  execution yet; soot-run checks get a scrubbed environment without keys (ADR-025). Audit logs
  are redacted and written with mode `0600`. The state directory is created
  with mode `0700`; `soot.sqlite` stores the original prompt and structured results in plain
  text (no encryption at rest). Security requirements from
  spec §13 are tracked as tasks in `TASKS.md`.

## UI

- **[Intentional] No UI exists.** Future UI follows ADR-009 (simple, pixelated, Lego-block
  modules); polish is not debt.
