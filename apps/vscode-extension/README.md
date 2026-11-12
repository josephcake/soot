# soot for VS Code / Cursor (local build, unpublished)

A thin editor view onto a local soot engine. It runs the `soot` CLI and shows what the engine reports, as stacked text blocks:

- **Orchestration: on/off** (`soot: Enable orchestration` / `soot: Disable orchestration`, workspace setting `soot.enabled`, off by default)
- **Task graph**: tasks by dependency layer (`L0 [■ task · demo-small→demo-mid · 2x]`, `└▶ task ← deps`)
- **Tasks**: per-task state, verdict, and each attempt's model, escalation level and failure
- **Active agents**: what is running now, on which model
- **Escalations and retries**: escalate, fallback, retry, downgrade, fail and stop events from the run's event log
- **Failures**: failed and cancelled attempts with the engine's reason
- **Cost**: the estimate and the actual cost that runners reported (mock runs report fictional amounts)
- **Cancel task** (right-click a running task) and **Stop run** (right-click a running run)

`soot: Show board` opens the same information as one plain-text document.

## Status: honest version

- **Not run in VS Code or Cursor yet.** It is tested against a fake `vscode` module and the real soot CLI with `--agent mock`. Until someone loads it in a real editor, do not treat it as a working editor integration.
- **Not published** to the VS Code Marketplace or Open VSX. You can build a `.vsix` locally (`pnpm --filter soot-vscode package:vsix`) and install it with `code --install-extension`.
- Windsurf, Kilo Code and GitHub Copilot compatibility is **not claimed** and has not been tested.

## Sideloading the local build (unverified)

> **Not verified.** This `.vsix` has not been run in a real editor: nobody has installed or run it in VS Code or Cursor yet. The steps
> below are the editors' standard ways to install a local `.vsix`; they are written from the
> editors' documentation, not from a recorded run. Expect problems, and treat a first try as the
> verification run (M7-01 for VS Code, M7-02 for Cursor), not as something already known to work.

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

| Setting           | Default           | Meaning                                                        |
| ----------------- | ----------------- | -------------------------------------------------------------- |
| `soot.enabled`    | `false`           | Allow `soot: Run a prompt` in this workspace                   |
| `soot.cliPath`    | (empty)           | Absolute path to your soot checkout's `apps/cli/dist/bin.js`   |
| `soot.nodePath`   | `node`            | Node.js 24+ used to run the CLI                                |
| `soot.agent`      | `none`            | `none` (recorded results only), `mock` (test double), or `acp` |
| `soot.mockScript` | `mock-agent.json` | Mock script, relative to the workspace, for `soot.agent: mock` |
| `soot.dataDir`    | (empty)           | `SOOT_DATA_DIR` for the CLI; empty uses soot's default         |

`acp` runs the ACP agent command configured in `soot.config.json`. Like the rest of soot, it has only been tested with soot's scripted mock ACP agent.
