# Technical Debt and Known Limitations

Each item is tagged **[Intentional]** (a deliberate MVP/milestone shortcut) or **[Defect]**
(something wrong that should be fixed). Last reviewed: 2026-11-12.

## Infrastructure

- **[Resolved 2026-11-12] Hosted CI is running.** The repo is public at
  https://github.com/josephcake/soot (ADR-032, superseding ADR-006). `.github/workflows/ci.yml`
  passed on GitHub for Node 24 and Node 26
  ([run 43334786373](https://github.com/josephcake/soot/actions/runs/43334786373) on `8a38865`;
  earlier [run 43329225136](https://github.com/josephcake/soot/actions/runs/43329225136) on
  `30aaf29`). `scripts/ci.sh` still runs the same steps locally.
- **[Intentional] Node 26 (Active LTS) is pinned in `.nvmrc`; the build box's system Node is 24.** Both are verified locally (Node 26 via a temporary binary in /tmp).
- **[Intentional] TypeScript pinned to 6.0.x**, not 7.x, because typescript-eslint 8 supports
  `typescript <6.1`. Revisit when typescript-eslint supports TS 7.
- **[Intentional] No git hooks.** Contributors run `pnpm run ci` manually.
- **[Intentional] No coverage reporting or thresholds yet.** Still open after Milestone 1.
- **[Intentional] No release/versioning tooling** (e.g. changesets). Packages are `private`, `0.0.0`.

## Code

- **[Intentional] No workspace package is a stub any more;** `cli` and `harness-adapters` are
  partial (M6). Package boundaries are kept (ADR-019).
- **[Intentional] Decomposition is fixture-only in practice.** `FixtureDecomposer` matches
  recorded prompts and refuses others; it is the default. `ModelDecomposer` (ADR-033)
  decomposes other prompts through a `ModelClient` and validates the answer like a fixture, and
  the CLI/MCP engine uses it when `decomposer.model` in `soot.config.json` names a usable
  registry model (ADR-034). It is **verified with mock model clients only** (no real provider,
  M2-07 blocked) and the prompt it sends is untuned.
- **[Deferred] Live DeepSeek unverified (ADR-035).** The data-residency hold is lifted and a
  configured DeepSeek provider is callable through the `openai-compatible` adapter, but no live
  DeepSeek request has been made: wire behaviour, structured output and decomposition quality
  are unknown. Verify together with M2-07.
- **[Resolved, ADR-045] Decomposer model spend and health (ADR-034).** The planning call is a
  labelled line in the cost report, `soot cost` and the run total; priced planning counts
  against the run budget before any task starts; the call honours and records provider
  cooldowns. Still open: an answer that fails validation spent tokens that no report counts
  (the failure carries no usage), and unknown (unpriced) planning is not counted against the
  budget. Fixture token estimates are placeholders, not measurements; model estimates are the
  model's guesses.
- **[Intentional] Agents are mocks.** `MockAgentRunner` and the generic ACP runner
  (`AcpAgentRunner`, ADR-027) are the only runners, and the ACP runner has only driven soot's own
  mock ACP agent. In Milestone 5 the mock writes scripted files into the worktree it is given. Since M5, "complete" means soot ran the
  configured checks on the task's real diff (ADR-025), but no real model has produced a diff.
  Harness runners are Milestone 6; real providers depend on M2-07.
- **[Intentional] Attempt timeouts default to 30 minutes** (`DEFAULT_ATTEMPT_TIMEOUT_MS`,
  ADR-030); an explicit `attemptTimeoutMs` wins. A hung runner ends as `timeout` instead of
  blocking its task; a runner that ignores the abort is abandoned, not killed. The default is
  untuned. Without a supervisor the scheduler runs one attempt per task.
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
- **[Intentional] SQLite migrations are hand-written** (v1, v2 or v3 → v4 in place; unknown
  versions are refused). There is no migration framework. Scheduler timestamps in `RunReport` are process-monotonic; persisted times are
  wall-clock ISO strings.
- **[Intentional] Nothing loads `.env` files.** `parseEnv` is called by the `soot` CLI and
  `soot mcp` (ADR-030), so `SOOT_DATA_DIR` and `SOOT_LOG_LEVEL` must be exported in the shell.
- **[Intentional] Vitest projects are discovered by directory scan** in `vitest.config.ts`,
  and workspace packages are aliased to `src/` for tests. Packages under `apps/` other than
  `cli` need an alias entry when added.

## Provider connectivity (Milestone 2)

- **[Blocked] No real provider has been called (M2-07).** All adapter behaviour is verified
  against mocked HTTP shaped from SDK and provider documentation. Wire-format drift will only
  show up with user-supplied keys (ADR-011).
- **[Resolved, ADR-030] Provider health persists.** Timed cooldowns (outage, rate limit,
  timeout) are stored in `soot.sqlite` (`provider_cooldowns`) through `ProviderHealthStore`;
  `soot run` loads them, so a restarted process skips a provider that was down until its
  cooldown ends. **[Intentional]** Auth and "not configured" marks stay per process (a fixed key
  works on the next run). Cooldowns are global to the state directory, not per project. Only
  mock agents have produced cooldowns so far (M2-07).
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
- **[Partly resolved, ADR-030] Routing decisions are in the audit log.** Every supervisor
  decision (assign, retry, fallback, escalate, downgrade, accept, fail, stop) with its model and
  reason is a `routing-decision` entry in `audit/<run>.jsonl`; ACP route outcomes are
  `model-route` entries. **[Intentional]** The full candidate table (`RoutingLog`) is still in
  memory only.
- **[Intentional] Latency is not part of routing** (spec §5 step 6). Availability is, through
  `ProviderHealth`.
- **[Intentional] Routing is re-done per attempt** (Milestone 4), but never inside an attempt.
- **[Resolved, ADR-030] Routed estimates are written into cost records automatically.**
  `soot run` and `soot cost` build `TaskCostRecord`s from the persisted attempts: a `routed`
  estimate per attempt (with `routeApplied` from what the runner reported), actuals only from
  results the runner returned. Estimates never fill in actuals.
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
- **[Resolved, ADR-030] Run-budget spend persists per attempt** (`attempt_spend`: reported
  actual, else routed estimate) and is reloaded when a supervisor is created, so a restarted run
  counts every earlier attempt, also of finished tasks. **[Intentional]** An attempt that was
  interrupted keeps its routed estimate as its spend (no actual was reported; none is
  invented), which errs on the side of stopping early. The CLI still has no resume command.
- **[Intentional] Latency is not a trigger.** Slow attempts are handled only by
  `attemptTimeoutMs`, which defaults to 30 minutes (`DEFAULT_ATTEMPT_TIMEOUT_MS`, ADR-030). The
  default is a safety net, not a tuned value; calibrate it once real agents run (M2-07, M6-04/05).
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
- **[Resolved, ADR-030] Provider health and run spend persist** in `soot.sqlite` (see above).

## Skill, CLI and MCP (Milestone 6)

- **[Intentional] Few log lines exist per level** (ADR-030). `SOOT_LOG_LEVEL` filters what the
  CLI and `soot mcp` print on stderr (progress at `info`, a handful of `warn` lines, `debug`
  context). There is no structured log file beyond the audit log and the events file.

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
  spawned agent can touch anything its user can (see `docs/guides/security.md`).
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
  `fixtures` file) unless a usable `decomposer.model` is configured (ADR-034, mocks only). The
  config surface exists; real-model use still needs user-supplied keys (M2-07).
- **[Intentional] The quick start needs a clone of the repo.** The source is public on GitHub
  (ADR-032), but there is no npm package or release. The quick start was reproduced from a
  fresh clone on the build box only, not on another machine or OS.
- **[Intentional] `soot models` does not probe providers.** It reports the registry and policy;
  availability comes from configuration.

## Documentation / community

- **[Intentional] No dedicated security or conduct contact address yet.** `SECURITY.md` and
  `CODE_OF_CONDUCT.md` point to private maintainer contact / GitHub private reporting. The
  source is public now (ADR-032); a contact must be set before the first release.
- **[Intentional] Some spec-listed docs are not written yet:** `task-decomposition`,
  `harness-integrations` and `examples`. `installation`, `providers`, `model-routing` and
  `security` exist in `docs/guides/`. The rest will be written with the features they describe, to
  avoid documenting fiction.

## Security

- Provider keys are handled only by `@soot/provider-adapters` (ADR-022). There is no real agent
  execution yet; soot-run checks get a scrubbed environment without keys (ADR-025). Audit logs
  are redacted and written with mode `0600`. The state directory is created
  with mode `0700`; `soot.sqlite` stores the original prompt and structured results in plain
  text (no encryption at rest). Security requirements from
  spec §13 are tracked as tasks in `docs/project/TASKS.md`.

## IDE extension (Milestone 7)

- **[Resolved 2026-11-14] The VS Code extension has been run in a real editor** (M7-01): VS
  Code 1.144.0 on macOS, mock agent only. Cursor, Windsurf, Kilo Code and GitHub Copilot are
  still unverified and not claimed.
- **[Resolved 2026-11-14] Enable dirtied the repository** (ADR-041). `soot: Enable
orchestration` wrote `.vscode/settings.json`; where that file is tracked, soot then refused
  the next run. The commands now use VS Code's workspace storage. Unit-tested, and re-run in VS Code
  the same day: Disable and Enable left the repository clean.
- **[Defect] A run refused before it starts looks interrupted.** When soot refuses a run on a
  dirty working tree, `soot status` (and so the extension's tree) shows it as `interrupted` with
  its tasks `pending` and an actual cost of $0, not as failed with the refusal reason. Only the
  editor's error message gives the reason. Seen as run `ide-20261114-081416-bda4`.
- **[Defect] Cancel and stop are not in the audit log.** `AUDIT_EVENT_TYPES`
  (`packages/observability/src/audit.ts`) has no cancel or stop event, so a stopped run's audit
  log shows `run-started`, `attempt-started` and `run-finished` with no record of who stopped
  what. The reason is only in `soot status` (`cancelled by request` / `run cancelled`).
- **[Defect] The extension cannot use real models.** `soot.agent` offers `none`, `mock` and
  `acp`; `--agent api` (ADR-039) came later and was never added, so editor runs cannot reach a
  model.
- **[Defect] Small editor rough edges.** The `(no run yet: soot: Run a prompt)` hint is not
  clickable, and `soot: Show task board` opens an unsaved Untitled document, so closing it asks
  to save.
- **[Intentional] IDE runs are unattended.** Approval-needing work is refused and results wait
  on `soot/<run>/integration`; approving needs `soot run` in a terminal. No in-editor approval
  UI yet.
- **[Intentional] The extension polls** `soot status <run>` (500 ms, one call at a time) while a
  run is going, spawning a Node process per poll. No file watching or long-lived connection.
- **[Intentional] The extension needs a local soot checkout** (`soot.cliPath`) and Node 24+.
  The `.vsix` is built locally and not published.
- **[Intentional] Task cancellation is cooperative.** `soot stop --task` writes a control file
  that the run polls every 200 ms; a runner that ignores the abort is abandoned, not killed.
- **[Intentional] No OS process sandbox** (unchanged): see Codebase integration and
  `docs/guides/security.md`.

## UI

- **[Intentional] UI is text blocks only** (ADR-009, ADR-029, ADR-031): the extension's tree and
  plain-text board, and the optional local `soot dashboard` page. No webview in the extension, no
  SPA framework, no elaborate dashboard; polish is not debt.

## Local dashboard (ADR-031)

- **[Intentional] No login on the dashboard.** It binds 127.0.0.1 and rejects foreign `Host`
  headers, but any local user or process that can reach 127.0.0.1 can read prompts and results
  while it runs.
- **[Intentional] It polls** (`/api/runs/<id>` every 1.5 s while a run is running); each request
  opens `soot.sqlite` through the engine's `status`/`cost`. No push updates.
- **[Intentional] Duration is wall clock from run creation to the last attempt finish** (from
  saved timestamps). Per-check durations are shown only for final validation.
- **[Intentional] The runner is run-level** (the saved report's agent label): one runner runs
  every task in a run, so "by runner" is one row per run, not a per-task bot identity. It is
  unknown until the run has a saved report.
- **[Intentional] "Estimated tokens" by model or runner repeat the task's planner tokens per
  attempt;** they are planning inputs, not measurements. Charts scale each to its own largest
  known value, so bar lengths are comparable only within one chart.
- **[Intentional] The donuts are an 11×11 pixel grid,** so a slice under about 1% may get no
  cell; the legend always carries the exact value and percent. The attempt timeline uses one
  axis per run (from run creation to the latest known time), so very short attempts in a long
  run get a minimum-width bar.
- **[Intentional] Only mock runs have produced its data.** Costs there are fictional; real
  numbers depend on M2-07 and harness runners. No savings are shown (no benchmark data).
- **[Intentional] Checked only by tests and a headless Chrome screenshot on the build box**, not
  by a person in a desktop browser; no browser matrix.
