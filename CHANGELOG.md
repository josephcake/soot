# Changelog

All notable changes are recorded here by milestone. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No versions have been released.

## [Unreleased] — Milestone 6 (partial): CLI, MCP server, universal skill (2026-11-12, fixtures, mock agent)

### Verified (local endpoint live with LM Studio, M2-03)

- The live local-endpoint test passed against LM Studio (`qwen/qwen3.8-27b`) on macOS. Its
  output cap went from 16 to 1024 tokens: reasoning models spend their first tokens on hidden
  reasoning, so 16 returned empty text. With no keys set, soot found the runtime (ADR-045) and
  `soot run --agent api --apply` verified and merged the spec Test 1 button task on it at $0.
  Ollama has not been run.

### Added (`soot init`, ADR-055)

- `soot init` writes `soot.config.json` from package.json scripts (`test`, `lint`,
  `typecheck` / `type-check`) invoked through the project's package manager, or from
  `cargo test`, `go test ./...`, or `python3 -m pytest` when those markers are present and
  there is no test script. `allowedExecutables` is set from the discovered commands.
- A decomposer model is **opt-in**: `--decomposer auto` or `--decomposer <provider/modelId>`,
  or a prompt on a terminal. Without that, the file has no `decomposer` field (fixtures
  only). soot never writes a vendor default. `--force` overwrites an existing file.

### Added (planner repository sketch, ADR-056)

- Model-backed planning now receives a bounded sketch of the target repository: a file list
  (at most 200 paths, git-tracked files when the folder is a repo), the package name and
  scripts, and a README excerpt. The sketch is fenced as untrusted data; fence tags inside
  it are neutralised. The planner system prompt's example no longer uses `src/login.ts`,
  and tells the model to take paths from the sketch.

### Changed (generic project checks, ADR-057)

- `acceptance["*"]` is used when a task id has no specific acceptance list, so a model-planned
  task can still be verified and landed. Per-id entries still win over `"*"`. Project `checks`
  were already run on every write that changed files; this does not change that.
- A write task with no soot-run checks is still `unverified`, but the reason no longer claims
  the task was read-only.

### Added (`soot resume`, ADR-054)

- `soot resume <run-id>` / `soot resume --latest` continues an interrupted, stopped, crashed or
  blocked run from `soot.sqlite` and its branches instead of starting over. Done and verified
  tasks are kept at their verified commit. Pending and interrupted tasks run again as new
  attempts on fresh worktrees. Tasks blocked on sign-in, approval, budget or exhausted
  escalation stay blocked unless `--retry-blocked` is passed, and a pending approval is asked
  again (never auto-approved). A task cancelled with `soot stop --task` stays cancelled.
- A crash-safe run lock in `soot.sqlite` (owner pid, host, heartbeat; taken in `BEGIN
IMMEDIATE`). A live run and a second concurrent resume are refused. A dead or expired owner's
  lock is reclaimed and audited. A run that loses its lock stops.
- Config drift (config, models, fixtures, routes, agent, mock script) is refused unless
  `--allow-config-change` is passed, which records what changed. Resuming a complete run is a
  no-op (exit 0).
- Spend from earlier sessions counts against the run budget. Each attempt is listed once in
  `soot cost` and the dashboard.
- `soot status <run>` and the report show sessions (run, resume #n), kept / re-run / held
  counts, config changes and each attempt's session. New audit events: `run-resumed`,
  `run-lock-reclaimed`, `worktree-reclaimed`, `branch-reset`. Audit `seq` continues across
  sessions.
- Schema v7: `run_sessions`, `run_locks`, `task_verifications`, `task_cancellations`,
  `task_attempts.session`, migrated from v6 (the sandbox's `command_runs`) and older.
- Tested with the scripted mock agent and built-binary subprocesses only (SIGKILL mid-task,
  refusals, drift, held blocks, budget). No MCP tool and no dashboard button yet.

### Changed (retries build on the rejected change)

- A retry or escalation now also sees what the previous attempt changed. The worktree is reset
  between attempts, so before this the next attempt redid the task from the base and often
  lost the half it had got right. soot stores the changed files and the start of the rejected
  attempt's diff (`retryDiffBytes`, default 8192, at most 32768, 0 = off; ANSI-stripped,
  key-redacted). The next attempt is told the change is not in its files and gets the diff in
  an untrusted fence. Only the latest rejected diff is shown. Agent results gain an optional,
  soot-set `rejectedChange` field (JSON Schema updated); an agent cannot supply one.

### Changed (retries see why a check failed)

- When soot's own check rejects an attempt, the retry or escalation now gets the end of that
  check's output in its own field (for `node --test`, the test name, the failing line and the
  assertion with actual and expected values), instead of the last 600 characters inside a
  finding that could be crowded out. The output is ANSI-stripped, key-redacted, capped
  at `retryCheckOutputBytes` (default 4096, at most 16384, 0 = off) and fenced as untrusted
  data in the prompt. Agent results gain an optional, soot-set `failedCheck` field (JSON Schema
  updated); an agent cannot supply one.

### Verified (live acceptance runs and the first savings benchmark, ADR-050)

- `scripts/benchmark.mjs` and `examples/bench-app`: a reproducible savings benchmark (issue #3,
  spec Test 5) that runs six fixed prompts through soot's routing and through the single most
  expensive available model, with real keys. It needs `--live`, refuses in CI and never runs in
  tests. First results with xAI and DeepSeek, three repetitions:
  [docs/benchmarks/2026-11-14.md](docs/benchmarks/2026-11-14.md). On the prompts both arms
  passed, routing cost $0.0190 against $0.1288; routed passed 15/18 runs, the baseline 14/18.
  The high-complexity prompt failed in both arms, and the sample is small. The title + button
  prompt was re-run after its task was corrected to ask for both `<title>` and `<h1>` (the
  recorded spec fixture said "No other page text changes", contradicting the acceptance test).
- Spec Tests 1 to 6 ran live with `--agent api`
  ([docs/benchmarks/2026-11-14-acceptance.md](docs/benchmarks/2026-11-14-acceptance.md)):
  Tests 1, 2 and 4 passed (Test 4's review is unverified by design), Test 3 in part, and Test 6
  for provider outage and model timeout.
- Status: M2-07 (two real providers), M6-07 (acceptance runs) and M6-08 (benchmark) are
  Verified. Status docs no longer say that no live model has run.

### Added (process sandbox for agent commands, ADR-051)

- soot-run checks and the ACP agent process (`--agent acp`, and the Claude Code and Codex
  runners of ADR-047) now run under a process sandbox picked
  per OS from what is already installed: `bwrap` on Linux (when it is on PATH and works),
  `sandbox-exec` on macOS, otherwise the `none` fallback. Default policy: writes only in the
  task worktree and a private temp dir; home and soot's state directory hidden; git internals
  read-only; no network.
- The fallback is labelled as **not isolation** everywhere. It still strips credential-like
  environment variables, pins the cwd to the worktree, uses no shell, times out, kills the whole
  process group, and caps output at 16 MiB.
- New `sandbox` block in `soot.config.json`: `mode` (`auto` | `bwrap` | `sandbox-exec` |
  `none`), `network`, `readPaths`, `writePaths`, `required`, `bwrapPath`. `required: true`,
  or a named backend that is unavailable, blocks tasks instead of running them unsandboxed.
- The backend is recorded per check (report, `soot status`, and a new `command_runs` table in
  `soot.sqlite`, schema v6) and per run; `soot config` shows the effective sandbox. The
  dashboard shows it, with `unknown` for runs that did not record one.
- Exercised for real with bwrap 0.12.0 on Linux. `sandbox-exec` is unit-tested only (never run
  on a Mac). Windows has no backend.

### Added (Gemini and OpenRouter, opt-in, ADR-049)

- Provider kind `google` for the Gemini API (via `@ai-sdk/google` 4.0.118). Thinking tokens
  count as output, cached input as cache reads, and existing Gemini catalog prices apply
  automatically. Uses `GEMINI_API_KEY` only when a `google` provider is declared in your
  models file.
- Provider kind `openrouter` (OpenAI-compatible, default base `https://openrouter.ai/api/v1`)
  with optional `routing` preferences (`dataCollection`, `zdr`, `order`, `only`, `ignore`,
  `allowFallbacks`, `requireParameters`, `sort`) and optional attribution headers. Uses
  `OPENROUTER_API_KEY` only when declared.
- Neither is auto-detected: setting the key alone does nothing; `soot config` notes a
  set-but-unused key.

### Fixed

- HTTP 402 (credits exhausted) now falls back to another provider instead of being retried
  as a crash.
- OpenRouter errors delivered as HTTP 200 with an `error` body are now classified by their
  real status (rate limit, unavailable, …).

### Docs

- `.env.example`, `docs/guides/providers.md`, `docs/guides/configuration.md`: Gemini/OpenRouter
  setup, plus the plain `openai-compatible` alternative.

Verified with fake HTTP and fake keys only; no live Gemini or OpenRouter calls (ADR-011).

### Added (targeted edits for `--agent api`, ADR-048, issue #4)

- `--agent api` models can now return targeted edits instead of whole files:
  `{"op": "replace", "path", "old", "new"}` replaces exactly one occurrence of `old`, and
  `{"op": "create", "path", "content"}` makes a new file. The ADR-039 whole-file form still
  works. Files a task may change are sent up to 256 KiB (was 64 KiB), so larger source files
  can be edited.
- Edits are checked before anything is written: the path rules from ADR-039, the task's write
  lease, an exact single match for `old` (CRLF files, a BOM and trailing spaces handled; no
  other fuzzy matching), no overlapping edits, and size limits on the edit payload. Then all
  files are written together, and if one write fails every file is put back.
- An edit that does not apply gets one repair round that names the problem ("matches 3 places;
  include more surrounding lines") and may fall back to a whole file. After that the attempt
  fails with those findings and soot retries or escalates as for any failed attempt.
- `"apiEditFormat": "whole"` in soot.config.json keeps the ADR-039 whole-file replies only;
  `soot config` shows the setting.

### Fixed (`--agent api`, ADR-048)

- A failed file write no longer leaves earlier files of the same reply written (and no longer
  throws out of the runner); the try ends `failed` with the files restored.
- A whole-file reply can no longer overwrite a file the model was not shown in full.
- An edit outside the task's write lease is refused before writing, with a clear message,
  instead of only being caught by the post-commit scope check.

### Added (Claude Code and Codex runners, simulated only, ADR-047)

- `soot run --agent claude-code` and `--agent codex` (the flag is also accepted by `soot mcp`
  and `soot dashboard`; only `soot run` is tested end to end) run
  each task through the ACP adapter for that harness that you installed and signed in to,
  named by absolute path under `harnesses` in soot.config.json. They are small profiles over the
  generic ACP driver: approvals still go through soot (allow once; deny or unattended rejects),
  sign-in needed blocks the task, routed models apply through the adapter's `model` option
  (optional `models` map). **Tested against simulated adapters only; not run with the real
  Claude Code or Codex** (M6-04 / M6-05 Implemented, simulated only; issues #1, #2 stay open).
- Every ACP agent: soot refuses a session whose reported mode turns the harness's approvals off
  (`bypassPermissions`, `agent-full-access`), before the prompt or when the agent switches to it
  mid-turn, and never changes the mode itself; `allowedModes` can require specific modes.
  Startup (`initialize` + `session/new`) has a 60 s limit, and stopping during startup ends the
  agent process. `auth_required` at the first prompt now blocks like at `session/new`.
- Config: `acpAgent` and `harnesses` refuse approval-bypass arguments (`--dangerously-*`,
  `--yolo`, `--full-auto`, `-a never`, `danger-full-access`, ...).

### Added (planning cost in the report and the run budget, ADR-046, issue #5)

- The planning (decomposer) call is its own line in `soot cost` and the run report
  ("Planning (decomposition, not a task)"), saved in `soot.sqlite` (`run_planning`), and the run
  total with planning is `cost.totals.run`. Unpriced planning stays unknown.
- Priced planning counts against `escalation.runBudgetUsd`: planning alone over the budget stops
  the run before any task starts (`decompositionFailure: "run-budget"`); otherwise tasks share
  the rest.
- The plan preview's worst case is capped at the run budget minus the planning already spent.
- The dashboard overview's reported Cost tile and "actual (reported)" chart include each run's
  planning call (`totals.run.usd`).
- The planner call skips a provider in cooldown and records a cooldown on an outage, rate
  limit, timeout or auth failure, like task attempts.

### Added (keyless local models, ADR-045)

- soot probes Ollama (`127.0.0.1:11434`) and LM Studio (`127.0.0.1:1234`) with a 500 ms
  `GET /v1/models` and adds their chat models as keyless `local: true` providers, $0
  (`source: "local runtime"`), tier `low`, assumed 4096-token context, so light work goes to
  them first. `"localModels": false` or `SOOT_LOCAL_MODELS=off` turns this off;
  `"localModels": { "urls": [...], "contextWindow": N }` or `SOOT_LOCAL_MODEL_URLS` changes
  where to probe and the window. Your models file wins for a runtime it configures.
  `soot config` and `soot models` list each runtime.

### Added (editor support and an Escalations view, ADR-044; M7-02…M7-04 prepared, M7-06)

- The VS Code extension's tree and board have an **Escalations (N)** section: one entry per
  escalation naming the task, the new attempt, `from ──▶ to` model, the escalation level, the
  engine's reason and each trigger (e.g. `repeated-failure`), marked with an orange `▲`. Other
  routing events are under **Retries and other events**.
- Two contributed theme colors, `soot.escalation` (orange `#ff7a1a`, darker on light themes)
  and `soot.secondary` (cream `#e8dcc8`), tint the tree icons in soot's palette (ADR-009)
  while the editor keeps its own background.
- Per-editor install steps (VS Code, Cursor, Windsurf, and Kilo Code alongside) from one
  `.vsix`, with each fork's VS Code base cited. Only VS Code is verified; Cursor and Windsurf
  are not run.
- Open VSX-ready manifest metadata (repository, homepage, keywords, a 128×128 pixel icon).
  Nothing is published.
- `src/editor-compat.test.ts`: the engines floor (`^1.100.0`, needed for ESM extensions)
  equals the pinned `@types/vscode`; every VS Code API the code calls is listed; no proposed
  APIs, extension dependencies or runtime packages.

### Added (auto models from your keys, ADR-043)

- Several keys, one pool: when `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` or
  `DEEPSEEK_API_KEY` is set, soot adds that vendor's models from its sourced price catalog
  (presence check only; no key value is read outside the adapter layer or printed). Your
  models file wins for any vendor it configures; `"autoModels": false` turns this off. The
  `models` file in soot.config.json is now optional.
- Model `tier` (`low` / `medium` / `high`): the hardest work a model gets while its
  reliability is unmeasured. Auto models are tiered by list output price (under $2.50/MTok
  low, from $15 high). The router sends light tasks to the cheapest low-tier model and hard
  ones to a high-tier model; with no high-tier model it uses the strongest available and says
  so. Measured history takes over once it exists. Custom policies can set
  `tierFallback: false`.
- `"decomposer": { "model": "auto" }` picks the cheapest priced structured-output model whose
  key is set, skipping low-tier models when another exists.
- `soot config` lists each known vendor (added, no key, configured by you, off); `soot models`
  shows `origin` and `tier`, in text and `--json`.

### Changed (dashboard History tab, ADR-042)

- The tab that listed past runs is now **History** (`#/history`), so it is not confused with
  the **Prompt** box. The list heading is "History · N", and the back link from a run is
  "← History". Old `#/prompts` and `#/prompts/<runId>` links still open the same views.
  Overview tiles and "Prompts over time" are unchanged.

### Verified (VS Code extension in a real editor, M7-01)

- The extension was installed from the local `.vsix` and used in VS Code 1.144.0 on macOS
  with `--agent mock`: run a prompt, the tree, the task board, cancel task and stop run worked.
  The tree, board and cost matched `soot status` and `soot cost` (M7-01, M7-05 and M7-07
  Verified). After the ADR-041 fix, Disable then Enable left the repository clean, so M7-08
  (cancel task, stop run, on/off) is Verified too. Escalation events were not exercised in
  the editor. Cursor is still not run.

### Fixed (VS Code extension on/off, ADR-041)

- `soot: Enable orchestration` no longer writes `.vscode/settings.json`. Where that file is
  tracked, the write dirtied the repository and soot refused the next run. On/off now lives in
  VS Code's workspace storage; a committed `soot.enabled` setting is still the default.
- The extension README now names the command `soot: Show task board`, as the editor shows it.

### Added (model call limit, Anthropic and OpenAI verified, ADR-040)

- `modelCallTimeoutMs` in soot.config.json (default 120 s): a wall-clock limit for one
  `--agent api` try (both rounds and the adapter's retries) and for the planner call. On expiry
  soot aborts the request and the try is a retryable `timeout` ("timed out after 120s waiting
  for xai/grok-4.7" in `soot status` and the dashboard timeline). Escalation then retries the
  same model and falls back to another provider. `soot config` shows the limit.
- Anthropic (native Messages API) and OpenAI (Chat Completions) covered end to end with fake
  servers: planner and api tasks, headers, usage and catalog prices. A live script for real keys
  is kept outside the repo.

### Fixed (ADR-040)

- Reasoning tokens that a provider reports outside `completion_tokens` (xAI, checked live) are
  now counted as output tokens, so Grok's cost is no longer under-counted.
- One api try could last up to 30 minutes: the per-request limit restarted on each of the
  adapter's internal retries. The 538 s Grok try in the recorded run was most likely two
  requests of about 270 s each, the first dropped by xAI.
- The scheduler's attempt timeout reads "30 min" or "5s" instead of milliseconds; `soot config`
  without `--agent` names `--agent api` too.
- A hung call sometimes surfaced as the adapter's generic "operation was aborted" timeout
  instead of "timed out after … waiting for <model>" (or, for the planner, not as a
  `TimeLimitError`): the adapter's per-request timer and the limit came due in the same
  millisecond. The per-request timeout is now the time left plus 1 s
  (`REQUEST_TIMEOUT_MARGIN_MS`), so the limit always fires first. This made the ADR-040 tests
  flaky on Node 26 in CI.

### Added (docs: recording of a real run)

- `docs/media/soot-real-run.mp4` (67 s, sped-up waits labeled), a real-time-only GIF and a
  poster, linked near the top of the README: one prompt in the dashboard, 3 of 3 tasks verified
  with DeepSeek and Grok, $0.0092 counted (Grok's reasoning tokens weren't recorded then, so the
  true cost is somewhat higher), Grok retried once after failing soot's check.

### Added (real model execution: `--agent api`, `--apply`, ADR-039)

- `soot run --agent api` and `soot dashboard --agent api`: each task goes to its routed model
  through soot's provider adapters, which returns whole-file edits as JSON. soot validates
  every path (inside the worktree, no `..`, `.git` or symlinks), writes the files, then
  commits, checks, merges and reports as usual. Usage is the provider's reported tokens; cost
  is that times the list price. One repair round for a reply that is not the JSON object;
  empty edits count as no change; timeouts, 429s and missing keys go to the supervisor.
- `--apply` (`soot run`, `soot dashboard`): pre-approves only fast-forwarding your branch to a
  fully verified, validated result on a clean tree. Without it the result stays on
  `soot/<run>/integration`, as before.
- First live runs (2026-11-13, user's keys, throwaway demo repo): planner
  `deepseek/deepseek-flash`, tasks on `deepseek/deepseek-flash` and `xai/grok-4.7`, all verified
  by the project's tests and landed, from `soot run` and from the dashboard.

### Changed (ADR-039)

- Routing history records the runner (state schema v5). Real runners (`api`, `acp`) ignore
  mock outcomes, so test-double failures no longer make real models unroutable.
- A hosted model with no `contextWindow` is assumed to take 32,000 tokens
  (`HOSTED_CONTEXT_FLOOR`); local endpoints still need the window configured.
- An `openai-compatible` provider whose named `apiKeyEnv` is unset is refused (`auth`) instead
  of being called without a key.
- `soot dashboard` prints its token link only to a terminal. It always writes it to
  `<dataDir>/dashboard-link-<port>.txt` (0600), removed on stop; SIGTERM now stops as cleanly
  as Ctrl-C. JSON output has `linkFile`, and `url` has no token when not on a terminal.

### Added (dashboard prompt box, ADR-038; mock runner only)

- `soot dashboard --agent mock|acp` adds a prompt box, now the dashboard's landing page: pick
  an allowed folder, type a prompt, press Enter. It plans and runs at once (no approve step),
  with a focus mode that shows only the prompt, live tasks with model, state and cost so far,
  a worst case, Stop and per-task stop. Overview moved to `#/overview`.
- `soot dashboard allow <dir>` / `disallow <dir>` / `list`: the folder allowlist in
  `<dataDir>/dashboard.json`, written by the CLI only.
- Every dashboard start prints a new access link; the dashboard now needs that session
  (cookie or bearer) for every page and API call. Writes also need CSRF + exact Origin.
- `SootEngine.plan()` / `runPlan()` / `previewPlan()`; `run()` is plan + runPlan (no change to
  `soot run`).

### Added (sourced price catalog, pricing prompt, priced planning call, ADR-037)

- `PRICE_CATALOG` in `@soot/model-registry`: official list prices (checked 2026-11-13, source
  URL on each) for OpenAI, Anthropic, Google Gemini API, xAI, DeepSeek and Mistral models. It
  fills in `pricing` only for configured models with none, matched on API host and model id.
  Prices only: no model list, no default. Optional `longContext` tiers and dated entries.
- [update-model-pricing](skills/update-model-pricing/SKILL.md) prompt for AI agents: run it
  when a provider, key, or new model id is added. `soot run`, `soot config` and `soot models`
  warn about callable models with no price and point to it. No network calls.
- The planning call is priced: the saved `decomposition` has `costUsd` and `priceBasis`, and
  `soot status <run> --json` now includes `decomposition`.
- The demo registry uses real model ids with real sourced prices (Claude Haiku 5.5, GPT-6.1
  Terra, Claude Opus 5.5). The mock agent stays a labeled test double with fictional usage.

### Added (structured-output wire mode `json_object`, ADR-036; mocks only)

- Optional `structuredOutputMode` on a model or provider in the registry: `"json_schema"`
  (default) or `"json_object"`. The model setting wins. In `json_object` mode the client
  sends `response_format: { "type": "json_object" }`, mentions JSON in the prompt if needed,
  then parses and validates the JSON against the existing schema. Failures stay
  `invalid-output`; there is no partial graph and no prompt text in errors. No vendor-id
  checks in code.
- Docs: [providers](docs/guides/providers.md) (optional DeepSeek example uses `json_object`),
  [configuration](docs/guides/configuration.md), ADR-036. Tests: mocked HTTP / fake `fetch`
  only (request body, valid JSON, invalid JSON, schema mismatch).

### Fixed (decomposition prompt names the exact task contract)

- The planner system prompt now lists every required task field (including `instructions`
  and `requiredCapabilities`), the `complexity` enum, and one complete example with
  `estimate.costUsd` set to `null`. A live DeepSeek `json_object` answer failed
  validation because it used `description` in place of `instructions` and omitted
  `requiredCapabilities`. Schema validation is unchanged; the captured shape is
  replayed in a mock test and still rejected.

### Changed (documentation layout)

- Project tracking and design docs moved from the repository root into `docs/project/` and
  `docs/decisions/`. Guides (`architecture`, `configuration`, `development`, `installation`,
  `model-routing`, `providers`, `security`) moved into `docs/guides/`. `docs/README.md` is the
  index. The repository root keeps README, LICENSE, CHANGELOG, CONTRIBUTING, SECURITY, and
  CODE_OF_CONDUCT.
- Relative links across the repo were updated. `scripts/check-doc-links.mjs` checks relative
  markdown and image links (historical research notes under `docs/research/` are excluded).

### Added (dashboard centerpiece and previous prompts, ADR-031, TASKS D-04; no milestone status change)

- The optional local dashboard now leads with a hand-drawn `<canvas>` (2D context, no chart
  library) showing where tasks went across every recorded prompt: pixel pipes from prompts to
  models, sized by unique tasks that had an attempt on that model. The largest share is orange.
  An empty state is a pixel "no data" block. Prompt text is drawn with `fillText` only.
- A Previous prompts list (newest first) shows each recorded prompt as soot stored it, with
  date, status, and total tokens/cost when the cost report recorded them. Clicking a prompt
  opens its detail: each task with the run's runner (soot records one agent/harness per run,
  not per task), the model(s) that took it, in/out/total tokens per task when every attempt
  reported usage, otherwise an explicit "not reported" reason, plus totals.
- `GET /api/runs` includes an `overview` built by reading each run's status and cost (the same
  engine data as before). `DashboardRun` gains `taskBreakdown`.
- Tests: `apps/dashboard/src/overview.test.ts`, more cases in `view.test.ts`, `ui.test.ts`
  (canvas and task breakdown against a fake DOM) and `server.test.ts`. Mock runs only.

### Changed (DeepSeek data-residency hold lifted, ADR-035 supersedes ADR-016; no milestone status change)

- Joseph reviewed data residency and lifted the hold. `@soot/model-registry` no longer
  restricts providers whose id or base URL is DeepSeek: `providerRestriction`,
  `ProviderRestriction`, `ModelRegistry.restriction` and the `restricted` exclusion reason are
  removed, and `isCallable` refuses only `listed-only` providers. `@soot/provider-adapters` no
  longer refuses DeepSeek in `createModelClient`; `soot models --json` drops the `restriction`
  field.
- DeepSeek is optional and user-configured (`openai-compatible`, `baseURL`
  `https://api.deepseek.com/v1`, `apiKeyEnv` `DEEPSEEK_API_KEY`); it is not a default, and the
  demo config is unchanged. It can be routed to and named as `decomposer.model`.
- Tests: DeepSeek is now shown selectable, routable and callable when configured (fake `fetch`
  and fake key values only); listed-only providers are still never selected or called. No live
  DeepSeek or other provider call was made; live use is unverified.
- Docs: providers, configuration, README, package READMEs, routing and architecture docs.

### Changed (dashboard page order, ADR-031; no milestone status change)

- The run view leads with a compact ident, the assignment graph, usage-by-model charts and a
  short chart legend, then the remaining insight charts; text details (task graph, agents, full
  prompt, savings) come after. Same blocks and data; no new chart types or API change.

### Added (decomposer model in soot.config.json, ADR-034, TASKS P-02; mocks only, no milestone status change)

- Optional `"decomposer": { "model": "<provider/modelId>" }` in `soot.config.json` (strict; the
  reference must be a model in the user's registry file). Absent: unchanged, fixture-only.
- The CLI/MCP engine builds the decomposer from it: `createDecomposer({ fixtures, model })` when
  a client can be built (registry model, callable provider, key variable set in the environment
  soot started with), otherwise fixture-only with no client. Recorded prompts never call the
  model. An unknown prompt with an unusable model fails naming the setting and the reason (for
  example `ANTHROPIC_API_KEY is not set`) and says no model was called; a model failure or
  invalid answer fails the run with `ModelDecompositionError`'s reason, never a guess.
- Run output: `decomposition` (fixture or model source, with model usage) in the run JSON and
  saved report; `fixtureId` is `null` for model plans; the text plan line names the model.
- `soot config` shows `Decomposition: ...` and `--json` has `decomposer` (`model`, `status`
  `not-configured` | `usable` | `unusable`, `reason`). No key value is printed.
- `@soot/cli` depends on `@soot/provider-adapters` (client creation through
  `createModelClient`; keys are still read only inside the adapter layer). `EngineOptions` has
  `modelEnv` and a `modelClientFactory` test seam.
- Docs: configuration, installation, skill, README, architecture. Tests:
  `tests/p02-decomposer-config.test.ts` (mock clients, `fetch` stubbed to fail) and the config
  schema test. No real model has decomposed a prompt; M2-07 stays Blocked.

### Added (model-backed decomposition, ADR-033, TASKS P-01; mocks only, no milestone status change)

- `ModelDecomposer` in `@soot/planner`: asks a caller-supplied `ModelClient` for structured
  output shaped like the task contract and validates the answer like a fixture (`parseTask`,
  `buildTaskGraph`, unpriced estimates, a task limit). Invalid answers fail with
  `ModelDecompositionError` (`model-call-failed`, `invalid-output`, `invalid-graph`).
- `createDecomposer({ fixtures, model })`: fixture-only without a client (no network);
  fixtures first, then the model, with one. `FixtureThenModelDecomposer` implements the latter.
- `Decomposition.decomposer` is now a union: `{ kind: 'fixture', fixtureId }` or
  `{ kind: 'model', modelRef, servedModelId, usage, attempts }`. `FixtureDecomposer` still
  returns the fixture form; `Decomposer.decompose` takes an optional `AbortSignal`.
- `@soot/planner` depends on `@soot/provider-adapters` for the `ModelClient` type (type-only
  import in production code; tests use its mock client).
- Verified with mock model clients only. No real model has decomposed a prompt (M2-07 is
  Blocked) and the CLI still decomposes from fixtures only.

### Changed (repository published, ADR-032; M0-11 Completed)

- The repository is public at https://github.com/josephcake/soot (MIT). ADR-006 (box-only) is
  superseded by ADR-032.
- Hosted GitHub Actions CI passed for Node 24 and Node 26
  ([run 43334786373](https://github.com/josephcake/soot/actions/runs/43334786373) on `8a38865`),
  so M0-11 is Completed. The workflow's stale "never run" header comment is gone and the README
  shows the CI badge. Tracking files and docs no longer say the repo is unpublished; there is
  still no npm package or release.

### Added (project logo; no milestone status change)

- Pixel soot logo (black / orange / cream, Lego-block cubes and a wordmark with an ember in
  the second O) in `docs/brand/`. The optional local dashboard header and favicon use it
  (`/logo.png`, `/mark.png`); the root README shows the lockup.

### Changed (dashboard palette and chart types, ADR-031 amendment, TASKS D-03; no milestone status change)

- Palette: near-black page and blocks, orange `#ff7a1a` accent, cream `#e8dcc8` highlights and
  hatched estimates, warm-gray notes, redder-orange errors. Yellow and blue are gone.
- New chart types from the existing payload: outcome pixel donut and success-rate meter, stacked
  input/output token bars (planned and reported apart), estimate-only and actual-only cost
  charts, an attempt timeline, validation counts by status, a transition count chart, and
  estimated/actual USD share donuts in each usage block. Cost by model is folded into the usage
  by model block with its numbers as text. No API or dependency change.
- Tests: more `apps/dashboard/src/ui.test.ts` cases (zero slices left out, null rate n/a with no
  fill, estimates and actuals apart, no finished bar for a running or unknown end).

### Added (dashboard charts, ADR-031 amendment; no milestone status change)

- Usage charts by model, task and runner (estimated USD, actual USD, planner tokens, reported
  tokens as separate CSS bar charts; unknown written as "unknown", never a bar) and an
  assignment view (prompt → tasks → model chain with retry/fallback/escalate/downgrade). Same
  run API, no chart library, no new dependencies.
- `DashboardRun` adds `agent`, `usage` and `assignment`; `soot status <run>` adds task
  `title`/`instructions` and run `agent`/`agentLabel`.
- Tests: `apps/dashboard/src/charts.test.ts`, `ui.test.ts` (page blocks against a fake DOM),
  more cases in `view.test.ts`, and an escalation run in `tests/dashboard.test.ts`.

### Added (optional local dashboard, ADR-031; no milestone status change)

- `@soot/dashboard` (`apps/dashboard`): a static block page and a read-only JSON API
  (`/api/runs`, `/api/runs/<id>`) on Node's `http`, bound to 127.0.0.1 only, showing the spec
  §12 fields from the engine's own status and cost data. No framework, no dependencies, no
  outbound requests, no savings claimed.
- `soot dashboard [--port <n>] [--open]`: default port 8787, fails if the port is taken, opens a
  browser only with `--open`, stops on Ctrl-C. Loaded lazily by that command only; headless
  commands never load it.
- `soot status <run>` data adds run `createdAt`, attempt `startedAt`/`finishedAt`, per-task
  `checks`, `finalValidation` and `problems` (additive).
- Tests: `apps/dashboard/src/{view,server}.test.ts`, `tests/dashboard.test.ts` (built binary:
  127.0.0.1-only listen checked on the socket and in `/proc/net/tcp`; taken port fails; headless
  commands and `soot mcp` run with the dashboard made unloadable and never listen).

### Fixed (docs)

- Stale tracking claims after ADR-030: attempt timeouts are no longer described as opt-in,
  `parseEnv` as unused, schema v4 is documented, the ACP runner is listed next to the mock, and
  the already-written docs (`installation`, `providers`, `model-routing`, `security`) and the
  existing `skills/` and `examples/demo-app/` are no longer listed as missing. The vsix sideload
  note now says plainly that the build has not been run in a real editor.

### Added

- `@soot/cli` (was a stub): the `soot` binary with `run`, `models`, `status`, `config`, `cost`,
  `stop`, `install-skill`, `mcp`; `SootEngine`; `soot.config.json` schema; mock scripts;
  terminal approvals (no approve-all); cross-process stop; saved reports.
- `@soot/harness-adapters` (was a stub): `OrchestrationService`, `createSootMcpServer` (official
  MCP SDK v2, tools `soot_run|status|cost|models|stop`), `HARNESS_SUPPORT` (Claude Code, Codex,
  Grok: not implemented, not claimed).
- `skills/universal-orchestrator/SKILL.md` and `soot install-skill`.
- `examples/demo-app` with config, fictional registry and mock script; fixture-backed CLI tests
  for spec §17 Tests 1 and 2 and the Test 4 graph shape, `soot stop` and `soot mcp` over stdio.
- Docs: installation and quick start, providers, model routing, security; config file reference.
- Generic ACP driver (ADR-027): `AcpAgentRunner`, `spawnAcpAgent` and a scripted mock ACP agent
  (test double) in `@soot/harness-adapters`, on the official `@agentclientprotocol/sdk` (stable
  v1). `soot run --agent acp` / `soot mcp --agent acp` spawn the user's configured `acpAgent`
  command. New approval action `harness-permission`. Tested only with the mock ACP agent.
- ACP routed model (ADR-028): soot sets the agent's `model` session option to the routed model
  when offered; otherwise every attempt reports "route not applied". `acpRoutes` in run reports.
- Milestone 7 (partial, ADR-029): `apps/vscode-extension` (`soot-vscode`, private, unpublished),
  a thin VS Code / Cursor extension over the soot CLI: orchestration on/off, task graph by
  layer, active agents, per-attempt models, escalation and retry events, failures, estimate vs
  actual cost, cancel task, stop run. Tested with a fake `vscode` module and the real CLI with
  `--agent mock`; not run in a real editor.
- Engine hardening (ADR-030): `SOOT_LOG_LEVEL` and `SOOT_DATA_DIR` honoured by the CLI and
  `soot mcp` (`runtimeFromEnv`, `createLogger`); provider cooldowns and per-attempt run-budget
  spend persisted in `soot.sqlite` (schema v4) and reloaded on restart; routed estimates written
  into cost records automatically (`costRecordsFromAttempts`, `soot cost` / run report
  `costRecords`); routing decisions in the audit log (`routing-decision`, `model-route`); a
  default 30-minute attempt timeout (`DEFAULT_ATTEMPT_TIMEOUT_MS`); `soot config` shows it.
- Unverified sideload note for the unpublished `.vsix` (VS Code, Cursor).
- `soot stop <run> --task <id>` and MCP `soot_stop` `taskId`: cancel one task (dependents
  skipped, other tasks continue). Live routing events in `reports/<run>.events.jsonl`;
  `soot status <run>` adds per-attempt details, `running` and events.

### Changed

- `@soot/integrations`: protected paths. A task that changes a protected file fails as
  out-of-scope even inside its write lease.

## [Unreleased] — Milestone 5: Codebase integration and safety (verified locally 2026-11-12, fixture repos, mocks)

### Added

- `@soot/integrations` (was a stub): `runCodebaseWorkflow` and its parts:
  - `Repository`: refuses a dirty tree, pins the base, one worktree and branch per task
    (`soot/<run>/<task>`) outside the repo, reset on retry, cleanup of this run's worktrees
  - `WriteLeases`, `withinScope`, `findDiffOverlaps`; out-of-scope edits caught from the real diff
  - `runCheck` / `checkCommand`: argv without a shell, executable allowlist, destructive
    programs and git subcommands refused, scrubbed environment, timeouts, redacted output
  - `IsolatedTaskRunner`: soot commits, diffs and validates each attempt; only soot-run
    evidence verifies a task; failed verification feeds the M4 supervisor
  - `integrateSerially`: merge-tree dry run per task onto the current HEAD; conflicts recorded
    and branches kept; final validation of the merged result
  - fast-forward of the user's working tree only after final validation and explicit approval
  - `buildConsolidatedReport` / `renderConsolidatedReport`: incomplete work listed first
  - `applyStructuredEdits`: the scoped, all-or-nothing write primitive for ADR-020
- `@soot/agent-runtime`: `ApprovalGate` (`UNATTENDED_APPROVALS`, `InteractiveApprovalGate`; no
  auto-approve), `TaskWorkspace` and `TaskPermissions` for runners; `MockAgentRunner` can write
  files, request approval and report fictional `costUsd`; assignments carry their tier.
- `@soot/observability`: `AuditLog` (redacted JSON Lines, mode 0600), `buildCostReport` /
  `renderCostReport` (estimate vs actual per task, per attempt and by model).
- `@soot/context-manager`: schema v3 (`model_outcomes`, migrated in place) with
  `recordModelOutcome` / `modelOutcomes`; `buildAgentContext`, `fenceUntrusted`,
  `scanForInjection` for untrusted content.
- `tests/m5-codebase-end-to-end.test.ts` checks exit criteria EC1–EC4 and M5-05…M5-09. ADR-025.

## [Unreleased] — Milestone 4: Adaptive execution (verified locally 2026-11-12, mocks)

### Added

- `@soot/escalation`: `AdaptiveSupervisor` and pure decision helpers:
  - trigger detection: repeated failure, unexpected complexity, unmet criteria, low confidence,
    tool errors, token blowup, invalid output, crash
  - escalation to an untried, more reliable model via `@soot/model-router`, one tier up
  - provider fallback on outage, auth failure, and persistent rate limits, with health marking
  - bounded retries with retry-after/exponential backoff, attempt and escalation limits, task
    and run budgets
  - downgrade of dependents after a plan or investigation, only when the saving is worth a
    switch, never for high-risk work
  - an explainable event for every decision
- `@soot/agent-runtime`: `AttemptSupervisor` hook, per-attempt records, per-attempt timeouts,
  retry timers that hold no concurrency slot, assignment and `priorAttempts` (context
  transfer) passed to runners, failure classification, cancellation of waiting retries.
  `MockAgentRunner` gains `provider-error`, scripted `signals` and `findings`, and `scriptFor`.
- `@soot/task-graph`: optional `signals` on `AgentResult` (JSON Schema regenerated).
- `@soot/context-manager`: schema v2 (`attempt_details`, migrated in place from v1);
  `loadRun` returns `attemptRecords` for resuming with history.
- `@soot/planner`: spec §17 Test 3 fixture.
- `tests/m4-adaptive-end-to-end.test.ts` checks exit criteria EC1–EC6. ADR-024.

## [Unreleased] — Milestone 3: Intelligent model routing (verified locally 2026-11-12, fixtures)

### Added

- `@soot/model-router`: per-task routing with these parts:
  - heuristic complexity and capability evaluation that records its reasons
  - a capability filter
  - cost estimates from registry list prices
  - reliability estimates from configured priors blended with recorded history
  - selection of the best model above the policy threshold
  - Economy, Balanced, Quality and Custom policies
  - a full explanation for every decision
- `@soot/observability`: `RoutingLog` with readable text and JSON Lines output.
- `@soot/model-registry`: optional `reliability` priors per complexity tier. They are unknown by
  default and need a source when set.
- `tests/m3-routing-end-to-end.test.ts` checks exit criteria EC1–EC4 on the spec's fixture
  prompts.
- ADR-023.

## [Unreleased] — Milestone 2: Multi-provider connectivity (in progress; mocks only)

### Added

- `@soot/model-registry`: user model config (no built-in models or prices), strict validation
  (key fields must name environment variables), provider health with cooldowns, discovery
  overlay, requirement-based selection with exclusion reasons, sourced and dated pricing,
  and cost estimates kept separate from actuals. DeepSeek endpoints are restricted (ADR-016; lifted by ADR-035).
- `@soot/provider-adapters`: the `ModelClient` interface (chat, streaming, tool calls,
  validated structured output, usage) over the Vercel AI SDK in-process. Adapters for Anthropic,
  OpenAI (Chat Completions) and generic OpenAI-compatible endpoints. soot-owned retries with
  rate-limit handling, a sanitized error taxonomy, outage fallback, `GET /models` discovery,
  credential isolation, and a scripted mock test double.
- Tests: one provider contract suite run against the mock and each adapter over mocked HTTP;
  credential-leak tests; outage and fallback tests; a repo-level credential boundary guard; and a
  live local-endpoint test that is skipped when no local runtime is running.
- `docs/research/2026-11-12-soot.md` (copy of Lumen's research) and ADR-022.

### Not done

- M2-07, real calls with user-supplied keys, is Blocked (ADR-011). No real provider has been
  called.

## [Unreleased] — Milestone 1: Core orchestration (verified locally 2026-11-12, mock agents)

### Added

- `@soot/task-graph`: strict task and agent-result contracts (zod) with generated, committed
  JSON Schema; dependency graph with cycle detection, topological layers, file-conflict
  serialization, and revision that keeps completed tasks.
- `@soot/planner`: immutable, byte-exact prompt intake with project context and intended
  outcome; `Decomposer` interface and deterministic `FixtureDecomposer` with fixtures for build
  spec §3 and §17 Tests 1, 2, 4. No model-backed decomposition.
- `@soot/agent-runtime`: `Scheduler` (bounded concurrency, dependency ordering, cancellation,
  result validation, resume) and `MockAgentRunner` test double.
- `@soot/context-manager`: SQLite execution state (`node:sqlite`) in `SOOT_DATA_DIR`, resume
  after the process is killed.
- `@soot/observability`: per-task cost records with estimates and actuals kept separate.
- End-to-end exit-criteria test and SIGKILL resume test.
- ADR-014…ADR-021 (Mochi's binding calls on Lumen's research; Milestone 1 implementation choices).

### Changed

- Provider plan is the Vercel AI SDK in-process, not LiteLLM (ADR-019); docs updated.

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
