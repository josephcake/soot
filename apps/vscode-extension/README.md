# soot for VS Code / Cursor (local build, unpublished)

A thin editor view onto a local soot engine. It runs the `soot` CLI and shows what the engine reports, as stacked text blocks:

- **Orchestration: on/off** (`soot: Enable orchestration` / `soot: Disable orchestration`, off by default). The commands keep on/off in VS Code's own workspace storage, never in `.vscode/settings.json`, so switching it never dirties your repository (soot refuses to run on a dirty working tree). A committed `soot.enabled` setting is the default until you use the commands (ADR-041).
- **Task graph**: tasks by dependency layer (`L0 [■ task · claude-haiku-5-5→gpt-6.1-terra · 2x]`, `└▶ task ← deps`)
- **Tasks**: per-task state, verdict, and each attempt's model, escalation level and failure
- **Active agents**: what is running now, on which model
- **Escalations and retries**: escalate, fallback, retry, downgrade, fail and stop events from the run's event log
- **Failures**: failed and cancelled attempts with the engine's reason
- **Cost**: the estimate and the actual cost that runners reported (mock runs report fictional amounts)
- **Cancel task** (right-click a running task) and **Stop run** (right-click a running run)

`soot: Show task board` opens the same information as one plain-text document.

## Status: honest version

- **Run in VS Code, not in Cursor.** Loaded and used in VS Code 1.144.0 on macOS on 2026-11-14 (M7-01) with `--agent mock` against `examples/demo-app`: enable, run a prompt, the tree, the task board, cancel task and stop run all worked, and the tree, board and cost matched `soot status` and `soot cost`. That run found that `soot: Enable orchestration` dirtied the repository and blocked the next run; fixed by ADR-041 (unit-tested; not yet re-run in the editor). Escalation and retry events were not exercised (the mock runs had none). Unit tests use a fake `vscode` module and the real soot CLI with `--agent mock`.
- **No `api` agent yet.** `soot.agent` offers `none`, `mock` and `acp`, so runs from the editor cannot use real models (`--agent api`, ADR-039) yet.
- **Not published** to the VS Code Marketplace or Open VSX. You can build a `.vsix` locally (`pnpm --filter soot-vscode package:vsix`) and install it with `code --install-extension`.
- Windsurf, Kilo Code and GitHub Copilot compatibility is **not claimed** and has not been tested.

## Sideloading the local build

> **VS Code: verified** on 2026-11-14 (VS Code 1.144.0, macOS): steps 1–3 below, with
> `code --install-extension`, were followed as written.
> **Cursor: not verified.** Nobody has installed or run it in Cursor yet; its steps come from
> Cursor's documentation, not from a recorded run. Treat a first try in Cursor as the
> verification run (M7-02), not as something already known to work.

1. Build it in your soot checkout: `pnpm build && pnpm --filter soot-vscode package:vsix`. This
   writes `apps/vscode-extension/dist/soot-vscode-0.0.0.vsix`. Nothing is published.
2. Install it:
   - **VS Code:** `code --install-extension apps/vscode-extension/dist/soot-vscode-0.0.0.vsix`,
     or Extensions view → `…` menu → **Install from VSIX…**.
   - **Cursor:** Command Palette → **Extensions: Install from VSIX…** and pick the same file
     (or the `cursor` shell command with `--install-extension`, if you installed it).
3. Set `soot.cliPath` to `<checkout>/apps/cli/dist/bin.js`, run **soot: Enable orchestration**,
   then **soot: Run a prompt** (with `soot.agent: mock` for a keyless try on examples/demo-app).
4. Remove it: `code --uninstall-extension soot-local.soot-vscode` (or uninstall from the
   Extensions view).

## How it works

- No orchestration happens in the extension. It runs `node <soot.cliPath> <command> --json` in the workspace folder and reads the JSON (`run`, `status <run>`, `cost <run>`, `stop <run> [--task <id>]`). It has no runtime dependencies and imports no soot package.
- Runs started here are **unattended**. The CLI gets no terminal, so soot refuses anything that needs approval and leaves the result on `soot/<run>/integration`. The extension never approves anything and has no "approve all" option. To approve, run `soot run` in a terminal.
- While a run is going, the view polls `soot status <run>` (one call at a time).

## Settings

| Setting           | Default           | Meaning                                                         |
| ----------------- | ----------------- | --------------------------------------------------------------- |
| `soot.enabled`    | `false`           | Default on/off; the Enable/Disable commands override it locally |
| `soot.cliPath`    | (empty)           | Absolute path to your soot checkout's `apps/cli/dist/bin.js`    |
| `soot.nodePath`   | `node`            | Node.js 24+ used to run the CLI                                 |
| `soot.agent`      | `none`            | `none` (recorded results only), `mock` (test double), or `acp`  |
| `soot.mockScript` | `mock-agent.json` | Mock script, relative to the workspace, for `soot.agent: mock`  |
| `soot.dataDir`    | (empty)           | `SOOT_DATA_DIR` for the CLI; empty uses soot's default          |

`acp` runs the ACP agent command configured in `soot.config.json`. Like the rest of soot, it has only been tested with soot's scripted mock ACP agent.
