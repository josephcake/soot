# @soot/dashboard

> **Status: optional local surface (ADR-031).** Not a milestone. Tested against mock runs only.

A simple read-only dashboard for soot runs on this machine. It is **off unless you run
`soot dashboard`**; soot is headless by default, and no other command (`run`, `status`, `cost`,
`mcp`, the skill, ACP, the VS Code extension) starts it or loads this package.

```
soot dashboard                 # http://127.0.0.1:8787
soot dashboard --port 9000     # another port; fails if it is taken (no fallback)
soot dashboard --open          # also open a browser (off by default)
```

- **Bind:** 127.0.0.1 only, never 0.0.0.0 or another interface. The bound address is checked
  after listening. `--port 0` asks the OS for a free port explicitly; the URL is printed.
- **Data:** the CLI passes its engine as a read-only `DashboardSource` (`status`, `cost`); the
  dashboard has no store of its own. State comes from the same `--data-dir` / `SOOT_DATA_DIR` /
  `~/.soot` as every command. No `.env` file is read.
- **API:** `GET /api/runs` (run list) and `GET /api/runs/<id>` (`DashboardRun`: prompt, task
  graph by layer, task count, active agents, models per task, model transitions, token usage,
  planner/router estimates and reported actual cost, cost per model, duration, success and
  failure counts and rates, soot-run checks, final validation, problems, and a fixed
  "no savings claimed" note). Unknown values are `null`, never zero-filled.
- **Charts (D-02):** usage by model, by task and by runner (`usage`: estimated USD, actual USD,
  planner tokens, reported tokens, each its own CSS bar chart; hatched cream = estimate, solid
  orange = actual; null is written "unknown", never a bar), and an assignment view (`assignment`: the
  prompt, one card per task with the planner's title and instructions, and its attempt chain
  with assign/retry/fallback/escalate/downgrade and the runner-reported model).
- **More chart types (D-03):** outcome pixel donut (zero slices left out) and success-rate meter
  ("n/a" with no fill when unknown), stacked input/output token bars for planned and for
  reported, estimate-only and actual-only cost charts, an attempt timeline (a running or unknown
  end is a start tick with a label), validation counts by status, a transition count chart, and
  separate estimated and actual USD share donuts per usage block.
- **Palette:** page `#0a0a0a`, blocks `#141414`, orange `#ff7a1a` accent, cream `#e8dcc8`
  highlights and estimates, warm-gray notes, redder-orange `#ff4d2e` errors.
- **Logo:** the page header and favicon use the pixel soot mark from `docs/brand/`
  (`GET /logo.png`, `GET /mark.png`).
- **Page:** plain HTML, one stylesheet, one script, no framework (ADR-009): each section is a
  text block. All text is set with `textContent`. It polls while a run is running.
- **Safety:** GET/HEAD only, `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, strict
  CSP, no outbound requests, no provider calls, no keys. See `docs/security.md`.

Programmatic use: `startDashboard({ source, port })` returns `{ url, address, close() }`.
