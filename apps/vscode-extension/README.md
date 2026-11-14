# soot for VS Code, Cursor and Windsurf (local build, unpublished)

A thin editor view onto a local soot engine. It runs the `soot` CLI and shows what the engine reports, as stacked text blocks:

- **Orchestration: on/off** (`soot: Enable orchestration` / `soot: Disable orchestration`, off by default). The commands keep on/off in VS Code's own workspace storage, never in `.vscode/settings.json`, so switching it never dirties your repository (soot refuses to run on a dirty working tree). A committed `soot.enabled` setting is the default until you use the commands (ADR-041).
- **Task graph**: tasks by dependency layer (`L0 [■ task · claude-haiku-5-5→gpt-6.1-terra · 2x]`, `└▶ task ← deps`)
- **Tasks**: per-task state, verdict, and each attempt's model, escalation level and failure
- **Active agents**: what is running now, on which model
- **Escalations (N)** (M7-06, ADR-044): one node per escalation, marked with an orange `▲`. The label names the task, the new attempt and the model step: `update-button-color #2 · claude-haiku-5-5 ──▶ gpt-6.1-terra · L1` (L = escalation level). Its children say **from** (the model of the attempt before), **to** (the new attempt and level), **why** (the engine's reason) and each **trigger** (`repeated-failure`, `unmet-criteria`, `low-confidence`, …). All of it comes from the run's event log; values the engine did not report are shown as unknown, not guessed.
- **Retries and other events**: fallback, retry, downgrade, fail and stop events
- **Failures**: failed and cancelled attempts with the engine's reason
- **Cost**: the estimate and the actual cost that runners reported (mock runs report fictional amounts)
- **Cancel task** (right-click a running task) and **Stop run** (right-click a running run)

`soot: Show task board` opens the same information as one plain-text document.

## Status: honest version

- **Run in VS Code only.** Loaded and used in VS Code 1.144.0 on macOS on 2026-11-14 (M7-01) with `--agent mock` against `examples/demo-app`: enable, run a prompt, the tree, the task board, cancel task and stop run all worked, and the tree, board and cost matched `soot status` and `soot cost`. That run found that `soot: Enable orchestration` dirtied the repository and blocked the next run; fixed by ADR-041 and re-run in the editor the same day (Disable and Enable left `git status` clean). Escalation and retry events were not exercised in the editor (the mock runs had none). The escalation view added later (ADR-044) is unit-tested against a real `soot status --json` of an escalated mock run, but has not been looked at in an editor. Unit tests use a fake `vscode` module and the real soot CLI with `--agent mock`.
- **No `api` agent yet.** `soot.agent` offers `none`, `mock` and `acp`, so runs from the editor cannot use real models (`--agent api`, ADR-039) yet.
- **Not published** to the VS Code Marketplace or Open VSX. You can build a `.vsix` locally (`pnpm --filter soot-vscode package:vsix`) and install it from the file.
- **Cursor and Windsurf: built to be compatible, not run.** The extension needs VS Code API 1.100 (see [Editor compatibility](#editor-compatibility)), uses only stable APIs, has no dependencies and installs from a `.vsix`. Nobody has installed it in Cursor or Windsurf yet (M7-02, M7-03 are not verified). Kilo Code and GitHub Copilot are AI-agent extensions, not editors; using soot next to them is not tested (M7-04).

## Editor compatibility

| Editor    | Its VS Code API base                        | Source                                                                                                                                                                                       | soot status                     |
| --------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| VS Code   | 1.100 or newer needed                       | [1.100 release notes](https://code.visualstudio.com/updates/v1_100): "ESM support for extensions" (the extension is `"type": "module"`)                                                      | **Verified** in 1.144.0 (M7-01) |
| Cursor    | 1.128.0 (Cursor 3.29, Nov 2026)             | [Cursor forum](https://forum.cursor.com/t/166421): users' About panels and a Cursor staff reply ("The Extension API target was bumped to 1.128 in mid-July"). Not in Cursor's own changelog. | Not run (M7-02)                 |
| Windsurf  | 1.141.2                                     | [Windsurf changelog](https://windsurf.com/changelog) (now served from docs.devin.ai): "The editor now uses VS Code 1.141.2"                                                                  | Not run (M7-03)                 |
| Kilo Code | n/a: an extension for VS Code and JetBrains | [kilo.ai docs](https://kilo.ai/docs)                                                                                                                                                         | Coexistence not run (M7-04)     |

Sources read on 2026-11-14. Both forks are above the floor of 1.100, so the manifest allows
installing; that is not the same as having run it there.

Why the floor is 1.100, and why it stays there:

- `"type": "module"` (ESM) extensions load from VS Code 1.100 on. Every other API the extension
  uses is older (tree view, commands, output channel, input box, quick pick, theme icons and
  colors).
- `@types/vscode` is pinned to exactly 1.100.0, so the type check rejects any newer API.
  `src/editor-compat.test.ts` keeps the pin equal to `engines.vscode`, lists every VS Code API
  the code calls, and fails if `enabledApiProposals`, extension dependencies or runtime packages
  appear.

### Install the local build

Nothing is published to the Visual Studio Marketplace or Open VSX, so every editor installs the
same file:

1. Build it in your soot checkout: `pnpm build && pnpm --filter soot-vscode package:vsix`. This
   writes `apps/vscode-extension/dist/soot-vscode-0.0.0.vsix` (vsce is fetched with `pnpm dlx`,
   so this step needs a network connection).
2. Install it in your editor:

   | Editor                              | Command line                                                                   | In the editor                                                               | Verified?                                 |
   | ----------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------- |
   | VS Code                             | `code --install-extension apps/vscode-extension/dist/soot-vscode-0.0.0.vsix`   | Extensions view → `…` → **Install from VSIX…**                              | Yes, 2026-11-14 (1.144.0, macOS)          |
   | Cursor                              | `cursor --install-extension <same file>` (if the shell command is installed)   | Command Palette → **Extensions: Install from VSIX…**                        | No                                        |
   | Windsurf                            | `windsurf --install-extension <same file>` (if the shell command is installed) | Extensions view → `…` → **Install from VSIX…**                              | No (path from third-party extension docs) |
   | Kilo Code (inside one of the above) | Install soot in that editor; Kilo Code is a separate extension                 | Both appear in the Extensions view; soot's view is **soot** in the Explorer | No                                        |

3. Set `soot.cliPath` to `<checkout>/apps/cli/dist/bin.js`, run **soot: Enable orchestration**,
   then **soot: Run a prompt** (with `soot.agent: mock` for a keyless try on examples/demo-app).
4. Remove it: `code --uninstall-extension soot-local.soot-vscode` (use `cursor` or `windsurf`
   in those editors), or uninstall from the Extensions view.

A first try in Cursor or Windsurf is that editor's verification run (M7-02, M7-03). Record the
editor and its About-panel "VS Code version", then check the tree, the board and an escalation
against `soot status`.

### Open VSX

Cursor and Windsurf install extensions from [Open VSX](https://open-vsx.org) (Windsurf through
its own mirror), not from the Visual Studio Marketplace. soot is on neither. The manifest
already has what Open VSX reads (`publisher`, `name`, `version`, `license`, `repository`,
`displayName`, `description`, a 128×128 `icon`, `engines.vscode`), and the tests keep it that way.
Publishing would still need a decision from Joseph: a real publisher namespace instead of
`soot-local`, a version other than `0.0.0`, and removing `"private": true`.

### Colors

The run view tints its icons with two contributed theme colors, so it follows soot's palette
(ADR-009) without overriding the editor's own background: `soot.escalation` (orange `#ff7a1a`
on dark themes, `#a84300` on light) and `soot.secondary` (cream `#e8dcc8` on dark themes,
`#6b5a3e` on light). Light-theme shades are darker so they stay readable (at least 4.5:1 on
white). You can override both under `workbench.colorCustomizations`.

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
