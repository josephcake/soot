# Project Status

Last Updated: 2026-11-14

## Current Phase

Milestone 6 — Universal Skill and CLI (in progress, partial: CLI, MCP server, skill and docs against fixtures and a scripted mock agent; exit criteria not met); Milestone 7 — IDE Extensions (started, partial: a thin VS Code extension, run in a real VS Code with the mock agent (M7-01 Verified); Cursor and other editors not run); Milestone 2 In Progress (partial; M2-07 Blocked)

## Overall Progress

5 / 8 milestones completed (M0, M1, M3, M4, M5 verified locally; M2, M6 and M7 in progress, partial)

## Current Status

Milestone 6 is In Progress (partial, ADR-026). The `soot` CLI (`run`, `models`, `status`,
`config`, `cost`, `stop`, `install-skill`, `mcp`) runs the full workflow on a real git
repository from one prompt, but only for **recorded prompts** and with the **scripted mock
agent** (`--agent mock`); every run says so. The MCP server exposes the same service and is
tested with the official MCP SDK client (in process and over stdio). The universal skill
installs into `.agents`, `.claude` and `.grok` skill folders. Installation, provider, routing and
security docs exist; the keyless quick start was reproduced from a fresh clone on the build box.
A generic ACP driver (ADR-027) lets `soot run --agent acp` run each task through the
ACP agent command the user configures, with permission requests answered only by a person
(unattended: rejected, the task refused, independent tasks continue). When the agent advertises a `model` session option, soot applies the routed model per attempt;
otherwise it reports "route not applied" (ADR-028). It is tested only against soot's own mock
ACP agent. Not done: no vendor harness has been run (Claude Code
M6-04, Codex M6-05: not claimed), no real provider (M2-07 Blocked), so M6-07 (real recorded acceptance runs) is Blocked and M6-08 not started. M5
gained protected paths: a task that edits a protected file (such as its acceptance test) fails
even inside its lease.

Milestone 7 is In Progress (partial, ADR-029). `apps/vscode-extension` is a thin VS Code /
Cursor extension with no runtime dependencies that runs the soot CLI and shows the run as text
blocks: orchestration on/off, task graph by layer, active agents, per-attempt models, escalation
and retry events, failures, estimate vs actual cost, cancel task and stop run. The engine gained
`soot stop <run> --task <id>` (also MCP), a live events file and per-attempt status. A `.vsix`
builds locally and is not published. On 2026-11-14 it was **loaded and used in VS Code 1.144.0**
on macOS (M7-01 Verified) with `--agent mock` on `examples/demo-app`: run a prompt, the tree,
the task board, cancel task and stop run worked, and the tree, board and cost matched `soot
status` and `soot cost` (M7-05, M7-07 Verified). That run found that `soot: Enable
orchestration` wrote `.vscode/settings.json`, which dirtied the repository so soot refused the
next run; ADR-041 moves on/off to VS Code's workspace storage, and a re-run in the editor the
same day left the repository clean (M7-08 Verified: cancel task, stop run, on/off). Escalation events were not exercised in the editor
(M7-06 Implemented). Cursor, Windsurf, Kilo Code and Copilot are not run or claimed, so M7 stays
In Progress.

Engine hardening (ADR-030, mocks only, no milestone status change): `SOOT_DATA_DIR` and
`SOOT_LOG_LEVEL` are honoured by the real CLI and `soot mcp`; provider cooldowns and
per-attempt run-budget spend persist in `soot.sqlite`, so a restarted process keeps skipping a
provider that was down and rebuilds its budget; routed estimates go into cost records
automatically and every routing decision is in the run's audit log; attempts default to a
30-minute timeout. The unpublished `.vsix` has an unverified sideload note.

Optional local dashboard (ADR-031, TASKS D-01, no milestone status change): `soot dashboard`
serves a simple block page and a read-only JSON API on 127.0.0.1 only (default port 8787,
`--port`, fails if the port is taken, browser only with `--open`). It shows the spec §12 fields
from the engine's own status and cost data, keeps unknown costs unknown, and claims no savings
(no benchmark data). Headless soot never loads it. Data so far comes from mock runs only.
Chart blocks (D-02) show usage by model, task and runner, with estimates and actuals in
separate charts, and an assignment view from the prompt to each task's model chain.
D-03 restyles it black/orange/cream and adds an outcome donut, success-rate meter, stacked token
bars, an attempt timeline and validation counts.
D-04 adds a top-center canvas of task counts per model across every recorded prompt, a previous
prompts list (newest first, with tokens and cost when recorded), and a per-task breakdown
(runner, models, in/out/total tokens) when a prompt is opened.

Milestone 5 is Completed and verified locally on real temporary git repositories, with real
`node --test`, `tsc` and lint commands run by soot itself and mock agents that write files (no
model is called). Each writing task runs in its own worktree under a write lease; soot reads the
real diff, runs the checks, and marks a task Verified only from that evidence. Verified work is
integrated serially with a merge-tree dry run; conflicts are surfaced with their branch kept;
the user's working tree moves only by fast-forward after final validation and explicit
approval. The consolidated report lists incomplete work first and shows cost estimates and
actuals separately. Approvals are never automatic; everything is audited (ADR-025). This is
not a finished product: harness runners are Milestone 6 and real providers wait on M2-07.

Milestone 4 is Completed and verified locally with mock agents, the fictional routing registry
and the spec's fixture prompts (§17 Tests 3 and 6). Failed or doubtful work escalates mid-flight
to a stronger model with its findings; unrelated tasks are not restarted; retries, escalations
and spend are bounded; dependents of a finished investigation are downgraded when it saves
enough; timeouts, rate limits, outages, crashes and invalid output recover with state preserved
in SQLite; a task or a whole run cancels cleanly (ADR-024). Triggers rely on agents' structured
self-report until Milestone 5 checks evidence.

Model-backed decomposition (ADR-033, TASKS P-01, no milestone status change): `@soot/planner`
has a `ModelDecomposer` that asks a caller-supplied `ModelClient` for tasks and validates the
answer like a fixture (task contract, unique ids, known dependencies, no cycles, path rules,
unpriced estimates); invalid answers fail with `ModelDecompositionError`. `createDecomposer`
stays fixture-only when no client is given, and with a client still answers recorded prompts
from fixtures. **Implemented, verified with mocks only:** no real model has decomposed a prompt
(M2-07 Blocked).

Decomposer model config (ADR-034, TASKS P-02, no milestone status change): an optional
`decomposer: { model }` in `soot.config.json` names a registry model. The CLI/MCP engine uses
it for prompts with no fixture only when a client can be built (registry model, callable
provider, key variable set); otherwise it stays fixture-only, builds no client and fails
unknown prompts naming the setting and the reason. `soot config` shows whether it is usable.
**Implemented, verified with mock clients only.**

DeepSeek hold lifted (ADR-035 supersedes ADR-016, no milestone status change): Joseph reviewed
data residency on 2026-11-12. DeepSeek is no longer restricted; configured as an
OpenAI-compatible provider with `DEEPSEEK_API_KEY`, it is selectable, routable and usable as the
decomposer model. It is optional and not a default. **No live DeepSeek call has been made;**
live decomposition remains unverified and M2-07 stays Blocked.

Milestone 3 (per-task routing, heuristic evaluation, ADR-023) is Completed.

Milestone 2 stays In Progress (partial). Its mockable scope is verified with mocked HTTP.
Real-model execution (ADR-039, 2026-11-13): `--agent api` runs each task on its routed model.
With the user's keys, DeepSeek (`deepseek-flash`, planner and tasks) and xAI (`grok-4.7`) were
called live on a throwaway demo repo; every task was verified by the project's tests and the
result landed with `--apply`. Anthropic and OpenAI have not been called live. Whether this
completes M2-07 is Mochi's call; its status is not changed here. Project name `soot` (ADR-013).

The repository is public at https://github.com/josephcake/soot under MIT (ADR-032, published
2026-11-12). Hosted GitHub Actions CI runs on every push to `main` and passed for Node 24 and
Node 26 (M0-11 Completed).

## Completed

- [x] Milestone 0 — Repository Foundation (M0-01…M0-10)
- [x] M0-11 First hosted GitHub Actions run: [run 43334786373](https://github.com/josephcake/soot/actions/runs/43334786373) on `8a38865` passed for Node 24 and 26
- [x] M1-01 Task schema + JSON Schema contract (`@soot/task-graph`)
- [x] M1-02 Prompt intake, byte-for-byte prompt preservation (`@soot/planner`)
- [x] M1-03 Decomposer interface + deterministic fixture decomposer (spec §3, §17 Tests 1, 2, 4)
- [x] M1-04 Dependency graph: DAG, cycles, layers, file-conflict serialization, revision
- [x] M1-05 Scheduler: bounded concurrency, dependency ordering, cancellation (`@soot/agent-runtime`)
- [x] M1-06 Structured agent result schema, validated by the scheduler
- [x] M1-07 SQLite execution state under `SOOT_DATA_DIR`; resume after SIGKILL (`@soot/context-manager`)
- [x] M1-08 Mock agent runner (labeled test double)
- [x] M1-09 Per-task cost records, estimates vs actuals separated (`@soot/observability`)

- [x] M2-01 `ModelClient` provider abstraction + mock test double, with a contract suite (`@soot/provider-adapters`)
- [x] M2-02 Anthropic + OpenAI adapters via the AI SDK; mocked HTTP; retries and rate limits tested
- [x] M2-04 Thin model registry from user config, custom endpoints (`@soot/model-registry`)
- [x] M2-05 Discovery, unavailable-provider handling, fallback (simulated outages)
- [x] M2-06 Sourced and dated pricing; capability metadata; unknown stays unknown
- [x] M2-08 Credential isolation, asserted by leak tests and a repo boundary guard
- [x] Milestone 3 — Intelligent Model Routing (M3-01…M3-06), `@soot/model-router`:
  - M3-01 heuristic complexity and capability evaluation, with reasons
  - M3-02 capability filter, tested per dimension (tools, structured output, vision, reasoning, streaming, context window, max output, availability, listed-only providers)
  - M3-03 per-candidate cost estimates from registry pricing (`EstimatedUsd`, `kind: 'estimate'`)
  - M3-04 best model above the reliability threshold, from priors blended with history
  - M3-05 routing explanation log (`RoutingLog` in `@soot/observability`)
  - M3-06 Economy / Balanced / Quality / Custom policies
- [x] Milestone 4 — Adaptive Execution (M4-01…M4-06), `@soot/escalation` + `@soot/agent-runtime` + `@soot/context-manager`:
  - M4-01 trigger detection (repeated failure, unexpected complexity, unmet criteria, low confidence, tool errors, token blowup, invalid output, crash)
  - M4-02 reassignment one tier up with context transfer (`priorAttempts`: summaries and findings)
  - M4-03 attempt and escalation limits, retry backoff, task and run budgets
  - M4-04 downgrade after a `planReady` prerequisite, gated on a 30% saving; never high-risk work
  - M4-05 recovery from timeout, rate limit, outage, auth, crash, invalid output; attempt history in SQLite (schema v2); resume replays the same decisions
  - M4-06 cancellation of one task or the whole run, including pending retries
- [x] Milestone 5 — Codebase Integration and Safety (M5-01…M5-09), `@soot/integrations` + `observability` + `context-manager` + `agent-runtime`:
  - M5-01 worktree per writing task from a pinned base, reset on retry, cleanup verified
  - M5-02 out-of-scope edits and overlapping diffs detected from real diffs
  - M5-03 serial merge-tree integration; conflicts surfaced with branches kept
  - M5-04 soot-run test/typecheck/lint/acceptance checks; failure marks the task incomplete
  - M5-05 consolidated report listing incomplete and failed work first
  - M5-06 per-task, per-attempt and total cost, estimates and actuals separate
  - M5-07 soot verdicts stored per model and tier (schema v3) and fed back into routing
  - M5-08 approval gates (interactive waits, unattended refuses), command controls, audit log
  - M5-09 untrusted content fenced and scanned; injection grants no permissions

## In Progress

- [ ] Milestone 2. M2-03 (local endpoint) is Implemented: covered by mocked HTTP, but the live test skipped because no Ollama or LM Studio was running. M2-07 is Blocked.
- [ ] Milestone 6. M6-01, M6-03 and M6-09 (generic ACP driver, mock ACP agent only) Completed; M6-02 and M6-06 Implemented; M6-04, M6-05, M6-08 Not Started; M6-07 Blocked on M2-07. Exit criteria not met.

- [ ] Milestone 7. M7-01 (VS Code extension), M7-05 (graph), M7-07 (cost) and M7-08 (cancellation, on/off after the ADR-041 fix) Verified in a real VS Code (2026-11-14, mock agent); M7-06 (models, escalation events) Implemented; M7-02…M7-04 (Cursor, Windsurf, Kilo Code) Not Started. Exit criteria not met.

## Not Started

- (none; M7-02…M7-04 have not started)

## Blockers

- **Milestone 6 exit criteria** need a supported harness: running the generic ACP driver against a real harness the user already installed and signed in to (M6-04/05), which this box must not do, plus real providers (M2-07). Mochi decides next steps.
- **Milestone 7 exit criteria** need the extension loaded and used in a real VS Code (and, separately, each other editor). This box has no editor; Mochi decides where and when.
- **M2-07 Blocked:** Milestone 2's real-provider exit criterion needs user-supplied (BYOK) keys for at least two providers (ADR-011, ADR-017). soot will not mint, request, or spend.

## Known Issues

- The CLI and MCP server decompose from fixtures unless `decomposer.model` is configured with a usable key (ADR-034); without it, prompts without a recorded fixture are refused. The model path is verified with mock model clients only: no real model has decomposed a prompt, and decomposition tokens are not yet counted in the cost report or run budget.
- Agents are mocks. Since M5, "complete" means soot ran the checks on the task's real diff, but no real model has produced a diff yet.
- No OS sandbox: worktrees isolate git state, not processes (`docs/project/TECHNICAL_DEBT.md`).
- Provider adapters are verified against mocked HTTP only. Real wire behaviour is unverified until M2-07.
- Escalation triggers still use agent signals, plus soot's own verification since M5. Provider cooldowns, run spend and model outcomes are persisted (ADR-030); the CLI has no resume command yet.
- See `docs/project/TECHNICAL_DEBT.md`.

## Next Actions

1. Mochi: review the generic ACP driver (ADR-027). Verifying it with a real harness (M6-04/05) needs a machine where the user has installed and signed in to that harness and agrees to a run; Mochi decides when and where.
2. Mochi: arrange a run of the unpublished `.vsix` in a real VS Code (then Cursor) to verify M7-01/M7-02.
3. Mochi: decide when and whether to run M2-07 with user-supplied keys. Real routing outcomes, model-backed evaluation and calibrated thresholds depend on it.
4. Optional: run `pnpm vitest run packages/provider-adapters/src/local-endpoint.test.ts` with Ollama or LM Studio running to verify M2-03 live.

## MVP Readiness

Not Ready (MVP-01, MVP-02, MVP-05 core in place with fixtures/mocks; MVP-03 partial (mocks only, real providers blocked); MVP-04 routing in place with heuristic evaluation; MVP-06 in place with mocks; MVP-07, -08 in place, verified on fixture repos with mock agents; CLI and MCP surfaces exist (fixture prompts, mock agent only); no supported harness yet)

## Latest Validation

Recorded 2026-11-12 ~12:42 PST from a real run of `bash scripts/ci.sh` in `/workspace/soot`, Node 24.22.1, git 2.47.3. The run covers install --frozen-lockfile, typecheck, lint, format:check, test and a clean build.

- **Build:** pass. `tsc -b` built all 15 workspace packages (12 under `packages/`, plus `apps/cli`, `apps/vscode-extension` and `apps/dashboard`).
- **Tests:** pass. 69 test files (68 passed, 1 skipped) and 492 tests (491 passed, 1 skipped, 0 failures), Vitest 5.1.0. The skipped test is the live local-endpoint test: no runtime was listening on 127.0.0.1:11434 or :1234.
- **Typecheck / lint / format:** pass.
- **Network audit:** the in-process suite was re-run with a global `fetch` guard; the only real requests were the two localhost probes and the dashboard tests' requests to their own 127.0.0.1 server. Subprocess tests (`soot stop`, `soot mcp`, the env/log-level/health/audit/cost CLI tests in `tests/hardening-cli.test.ts`, and the mock ACP agent processes spawned by `soot run --agent acp`) run built soot code that does not depend on the provider adapters. The only ACP agent ever spawned is soot's own mock (`node .../mock-agent-bin.js`); no vendor binary was run. No key-like environment variables were set.
- **Re-run after ADR-033 (2026-11-12 ~4:33 PM PST):** `bash scripts/ci.sh` passed again (Node 24.22.1): 70 test files (69 passed, 1 skipped), 508 tests (507 passed, 1 skipped, the same live local-endpoint test). The global `fetch` audit above was not repeated for this run; the new planner tests replace `fetch` with a spy that fails on any call.
- **Re-run after ADR-034 (2026-11-12 ~5:16 PM PST):** `bash scripts/ci.sh` passed (Node 24.22.1, pnpm 10.34.6): 71 test files (70 passed, 1 skipped), 520 tests (519 passed, 1 skipped, the same live local-endpoint test). The global `fetch` audit was not repeated; the new P-02 tests replace `fetch` with a spy that fails on any call. Since ADR-034 the built CLI imports `@soot/provider-adapters`, but it builds a client only when `decomposer.model` is configured, which no subprocess test does.
- **Hosted CI:** GitHub Actions [run 43334786373](https://github.com/josephcake/soot/actions/runs/43334786373) on `8a38865` passed for Node 24 and Node 26 (started 2026-11-12 4:09 PM PT, finished 4:11 PM PT); the earlier [run 43329225136](https://github.com/josephcake/soot/actions/runs/43329225136) on `30aaf29` also passed.
- **Quick start:** `docs/guides/installation.md` reproduced step by step from a fresh `git clone` of this repo in `/tmp` (demo runs: unattended INCOMPLETE exit 2, interactive `y` COMPLETE exit 0 with fast-forward, Test 4 shape INCOMPLETE with the review unverified, skill installed into a temp dir).
