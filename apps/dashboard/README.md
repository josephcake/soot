# @soot/dashboard

> **Status: optional local surface (ADR-031, ADR-038, ADR-039).** Not a milestone. Tested
> against mock runs and a fake provider; run live once with `--agent api` (DeepSeek and xAI).

A local dashboard for soot on this machine: a prompt box (the landing page) plus views of every
run. It is **off unless you run `soot dashboard`**; soot is headless by default, and no other
command (`run`, `status`, `cost`, `mcp`, the skill, ACP, the VS Code extension) starts it or
loads this package.

```
soot dashboard allow ~/code/my-app            # once: folders the prompt box may work in
soot dashboard list                           # what is allowed (disallow <dir> removes one)
soot dashboard --agent api                    # prompt box on, each task runs on its routed model
soot dashboard --agent api --apply            # ...and lands fully verified results on the branch
soot dashboard --agent mock --mock-script mock-agent.json   # prompt box on, scripted test double
soot dashboard --agent acp                    # prompt box on, each project's "acpAgent"
soot dashboard                                # read-only: runs only, the prompt box is off
soot dashboard --port 9000                    # another port; fails if it is taken (no fallback)
soot dashboard --open                         # also open a browser (off by default)
```

On a terminal it prints `http://127.0.0.1:<port>/?token=…`. **Open that link**: it signs the
browser in with a session cookie and drops the token from the address bar. Without it you get
an access gate. Every start makes a new token. When output is redirected (a log file), the
link is not printed; it is in `<dataDir>/dashboard-link-<port>.txt` (0600, removed on stop),
and `--open` still opens it (ADR-039).

## Prompt box (ADR-038)

- **Landing view** (`#/`). A centered prompt box, a project picker (allowed folders only), and
  a quiet line with the runner (`mock (test double)` or `acp (<command>)`) and the planner
  with a rough per-plan cost (`planner: deepseek-flash · ~$0.0016 per plan`; recorded prompts
  cost nothing). A small `setup` toggle lists the folder, models, and each provider's key
  variable as `set` / `missing` (names only).
- **Like a chat prompt.** Enter (or Run) submits; Shift+Enter is a new line. There is no
  approve or confirm step: the prompt is planned and then run right away.
- **Focus mode.** While you type, and while a prompt works, the tabs and header meta fade out.
  The page shows the submitted prompt, an 8-block progress strip, one line per task (model,
  state, cost) with a planning line first, the cost so far (`~$0.0049 est.`), the worst case
  (`worst case ≤ $0.03`: planning plus every allowed attempt on the priciest acceptable model),
  **Stop**, and a `stop` per unfinished task. `details` opens the full prompt page.
- **When it ends** the card stays with the result (for example "working tree not updated:
  approval unavailable; result left on soot/<run>/integration") and `dismiss`; the prompt box
  comes back.
- **Runs live in the dashboard process.** Ctrl-C on `soot dashboard` stops them (work merged
  before the stop stays merged). Closing the tab does not. One live prompt per project.
- **Approvals** inside a run are refused in v1, including soot's own "update the working tree"
  step, so results stay on the run's integration branch for you to merge.
- **Read-only mode** (no `--agent`): the box is disabled and shows the restart command.
  No allowed folders: it shows `soot dashboard allow <dir>`.

- **Bind:** 127.0.0.1 only, never 0.0.0.0 or another interface. The bound address is checked
  after listening. `--port 0` asks the OS for a free port explicitly; the URL is printed.
- **Data:** the CLI passes its engine as a read-only `DashboardSource` (`status`, `cost`); the
  dashboard has no store of its own. State comes from the same `--data-dir` / `SOOT_DATA_DIR` /
  `~/.soot` as every command. No `.env` file is read.
- **API:** `GET /api/runs` returns the run list plus an `overview` (every recorded prompt,
  newest first, with date, status, reported tokens and cost when the cost report exists, and
  task counts per model; plus `flows` / `byModel` for the aggregate graph). `GET /api/runs/<id>`
  returns `DashboardRun`: prompt, task graph by layer, task count, active agents, models per
  task, a `taskBreakdown` (runner, models, reported in/out/total tokens and cost per task, or
  a reason when those were not reported), model transitions, token usage, planner/router
  estimates and reported actual cost, cost per model, duration, success and failure counts and
  rates, soot-run checks, final validation, problems, and a fixed "no savings claimed" note.
  Unknown values are `null`, never zero-filled. soot records one agent/harness per run, not
  per task; `taskBreakdown.runner` is that run-level label. Per-task tokens come from the cost
  report's attempt usage, when every attempt on the task reported them. The `overview` also
  carries an `aggregate` across every run (usage by model and by runner, tokens, cost, outcomes,
  validation and transition counts); a partial sum says how many runs it covers
  (`{ value, runs }`) and is `null` when no run reported it.
- **Centerpiece: prompts over time.** A GitHub-contribution-style grid of square pixel cells
  (plain DOM links, 1px gaps, a 5-step orange ramp from near-black to `#ff7a1a`; faint cells
  are empty slots). A pixel segmented toggle picks the zoom, kept in the hash (`#/overview`,
  `#/overview?zoom=hour`, `#/overview?zoom=day`; old `#/?zoom=` links still work):
  - **Prompt** (default): a column per local day (at least 28, at most 42, ending today), one
    square per prompt stacked oldest-first, up to 7; more shows a `+N` chip that opens that
    day's filtered list. The shade is the prompt's **complexity level** (fixed scale).
  - **Hour**: a column per local day, a row per local hour. **Day**: a column per week (Sunday
    first), a row per weekday (at least 12, at most 26 weeks). The shade is the bucket's
    **activity**, scaled to that view on its own.

  Hover or focus shows a tooltip (prompt, local date/time, tasks, tokens, complexity; or the
  window, prompts, tasks, tokens, activity). Each square has an `aria-label`. Enter or a click
  opens `#/history/<runId>` (prompt) or `#/history?from=<iso>&to=<iso>` (bucket: the list
  filtered to that window, with a filter chip and a "clear" link). Old `#/prompts` links
  still open the same views. No runs: an empty frame
  and "No prompts yet". Prompts without a date are left off and counted in a note.

  **Prompt complexity** (`complexityOf` in `overview.ts`), from recorded fields only. Each
  input is normalized to 0..1:

  | input   | from                                     | normalized                        |
  | ------- | ---------------------------------------- | --------------------------------- |
  | tasks   | planned task count                       | (tasks − 1) / 5, capped (6+ → 1)  |
  | planner | planner complexity per task              | mean of low 0, medium 0.5, high 1 |
  | depth   | layers in the task dependency graph      | (layers − 1) / 3, capped (4+ → 1) |
  | tokens  | reported runner tokens (in + out)        | log10(tokens / 1000) / 2, 0..1    |
  | retries | retry/fallback/escalate/downgrade events | transitions / tasks, capped at 1  |

  `score` = the mean of the inputs that are present (3 decimals); `level` = min(4,
  floor(score × 5)). Tasks, depth and retries need at least one task; planner needs a known
  task complexity; tokens need reported usage. A missing input is left out of the mean (never
  read as 0), and the grid notes which fields were missing for how many prompts. No score →
  level 0.

  **Bucket activity** (hour and day views): the sum of the scores of the prompts created in
  that local window (a missing score adds 0). Level within one view: no prompts → faint empty
  cell; activity 0 → level 0; otherwise ceil(4 × activity / the view's largest activity), so
  each zoom has its own scale.

- **Where tasks went (secondary, D-04):** a smaller hand-drawn `<canvas>` (2D context, no chart
  library) below the grid for the latest 8 prompts: pixel pipes from prompts to models, sized
  by unique tasks that had an attempt on that model (a task that escalated counts under each).
  Each pipe and model bar wears that model's colour and pattern; the largest share is
  bracketed in cream. The legend under it counts every prompt. Empty state is a pixel "no
  data" block. Prompt text is drawn with `fillText` only.
- **Views (hash routes, no router library):** a pixel tab bar switches between **Prompt**
  (`#/`, the prompt box above), **Overview**
  (`#/overview`: summary tiles for prompts, tasks, tokens and cost, the prompt grid, the canvas, a shared model legend,
  and aggregate charts across every prompt; nothing specific to one prompt) and **History**
  (`#/history`; old `#/prompts` links still open it). The browser back and forward buttons work (`hashchange`).
- **History (D-04):** `#/history` lists every recorded run, newest first, with the
  prompt text as soot stored it, local date (ISO in the title), status, models used, the runner
  as a short tag, and total tokens/cost when recorded. Each row links to `#/history/<runId>`:
  each task with the run's runner and the model(s) that took it, in/out/total tokens per task
  (or an explicit "not reported" reason), totals, and the per-run charts below, with a back
  link to History. An unknown run id shows "not found" and the back link.
- **Model identity:** one deterministic model → style map (names sorted by code point; 8
  colours × 6 pixel patterns: solid, hatch, dots, checker, horizontal and vertical stripes) is
  used by the canvas, every chart, the legend and the prompt detail, so models stay apart
  without colour too.
- **Charts (D-02):** usage by model, by task and by runner (`usage`: estimated USD, actual USD,
  planner tokens, reported tokens, each its own CSS bar chart; hatched cream = estimate, solid
  orange = actual; null is written "unknown", never a bar), and an assignment view (`assignment`: the
  prompt, one card per task with the planner's title and instructions, and its attempt chain
  with assign/retry/fallback/escalate/downgrade and the runner-reported model).
- **More chart types (D-03):** outcome pixel donut (zero slices left out) and success-rate meter
  ("n/a" with no fill when unknown), stacked input/output token bars for planned and for
  reported (and per-model reported in/out when those tokens are known), estimate-only and
  actual-only cost charts, an attempt timeline (a running or unknown end is a start tick with a
  label), validation counts by status, a transition count chart, and separate estimated and
  actual USD share donuts per usage block.
- **Palette:** page `#0a0a0a`, blocks `#141414`, orange `#ff7a1a` accent, cream `#e8dcc8`
  highlights and estimates, warm-gray notes, redder-orange `#ff4d2e` errors; extra per-model
  series colours only for model identity. One 8px spacing scale, a 12-column grid in a 1280px
  container (charts 2-up, one column under 760px), square 1px-hairline panels.
- **Logo:** the page header and favicon use the pixel soot mark from `docs/brand/`
  (`GET /logo.png`, `GET /mark.png`).
- **Prompt detail:** a selected prompt shows a summary (total cost, tokens in / out, task count,
  status, duration such as `2m 14s`, the prompt with its full text one click away), then one
  table: a Planning row, one row per task (task, who took it: model swatch + name and the
  runner tag, tokens in, tokens out, cost) and a Totals row. Each task's cost is, per attempt:
  the runner-reported actual; else, when the model is priced, the router's estimate (planned
  tokens × official price, the same `estimatedUsd` the Overview charts) shown muted as
  `~$0.0001 est.`, with that row's tokens reading `not reported` instead of 0; else
  `price not set`, only when the model has no registry price (the router estimates every
  priced model, so no estimate means no price), never `$0`. A priced model with neither reads
  `not reported`. The Totals row and the summary tile add actuals and estimates, adding `est.`
  when an estimate is included and `partial` when some rows have no amount; the tooltip
  counts actual, estimated and unpriced rows. The planning row uses `status.decomposition`
  (its `costUsd`, and `priceBasis` to tell priced from unpriced) and says `not recorded` when
  absent.
  The per-run charts sit under a closed "More charts" toggle, and every caveat is in one
  "About these numbers" footnote at the bottom.
- **Page:** plain HTML, one stylesheet, one script, no framework (ADR-009): each section is a
  text block. All text is set with `textContent`. It polls while a run is running.
- **Safety:** `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (421 otherwise, checked
  first); a session (cookie from the printed link, or bearer) for every page and API call;
  writes (POST) need JSON, the exact loopback `Origin`, `Sec-Fetch-Site: same-origin` when
  sent, and `X-Soot-CSRF`; no CORS headers; strict CSP; no outbound requests; key names only.
  See `docs/guides/security.md`.

### Write API (only with `--agent`)

| Endpoint                                     | Does                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/session`                           | `{ writes, runner, csrf, auth, readOnlyHint, port }`                                       |
| `GET /api/projects`                          | allowed folders: `{ id, label, path, config, planner, runnerLabel }`                       |
| `GET /api/keys/status?project=<id>`          | models, unpriced models, planner, providers with key `set` / `missing`                     |
| `POST /api/prompts` `{ project, prompt }`    | plan and run; `202 { job }`; optional `Idempotency-Key`                                    |
| `GET /api/prompts`, `GET /api/prompts/<job>` | jobs: `planning` → `running` → `done` / `failed` / `cancelled`, with `preview` and `runId` |
| `POST /api/prompts/<job>/cancel`             | stop planning, or stop the run                                                             |
| `POST /api/runs/<run>/cancel` `{ task? }`    | stop a run started here, or one task                                                       |

Errors are `{ error, message, retryable }`: 401 `auth_required`, 403 `csrf` / `read_only` /
`not_owned`, 404 `unknown_project` / `unknown_job`, 409 `project_busy` / `not_running`, 413
`prompt_too_long`, 415 `content_type`, 422 `prompt_invalid` / `config_invalid`.

Programmatic use: `startDashboard({ source, port, agent?, token? })` returns
`{ url, baseUrl, address, close() }`; `url` holds the token. `close()` stops live runs first.
