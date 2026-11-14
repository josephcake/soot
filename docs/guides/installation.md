# Installation and quick start

> soot has **no npm package or release** yet. The source is public at
> [github.com/josephcake/soot](https://github.com/josephcake/soot); clone it
> (`git clone https://github.com/josephcake/soot.git`) and build from the checkout. Everything
> below runs locally, without network access to model providers and without API keys.

## Requirements

- Node.js 24.11 or newer (`.nvmrc` pins 26) and pnpm 10
- git 2.38 or newer (soot uses `git merge-tree --write-tree`)
- Linux or macOS with a POSIX shell (the steps below use bash)

## Build

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build
```

The CLI is `apps/cli/dist/bin.js`. To call it as `soot` in this shell:

```sh
SOOT_HOME="$PWD"   # run this from the repository root
soot() { node "$SOOT_HOME/apps/cli/dist/bin.js" "$@"; }
soot --help
```

## Quick start with the demo app (no keys)

`examples/demo-app` is a tiny project whose files match the build spec's example prompts. Its
`mock-agent.json` scripts what the **mock agent** writes for each task: no model is called.
soot still does everything else for real: worktrees, routing, the project's checks, merging,
and the report.

```sh
WORK="$(mktemp -d)"
cp -r examples/demo-app "$WORK/demo-app"
cd "$WORK/demo-app"
git init -q -b main
git add -A
git -c user.name=You -c user.email=you@example.invalid commit -qm "demo app"
export SOOT_DATA_DIR="$WORK/soot-state"

soot run "Change the page title to HELLO WORLD and update the primary button to purple." \
  --agent mock --mock-script mock-agent.json
```

What to expect:

- Two tasks run at the same time in separate worktrees, each routed to the cheapest demo model
  that clears the reliability threshold. The demo registry names real models (Claude Haiku 5.5,
  GPT-6.1 Terra, Claude Opus 5.5) with their real list prices, so routed estimates are
  realistic. No model is called: the mock agent is a test double and its usage is fictional.
- soot runs `node --test`, the lint script, and each task's acceptance test on the task's own
  commit. Both tasks are verified and merged on branch `soot/<run-id>/integration`.
- The run is reported **INCOMPLETE** (exit code 2) only because nobody approved updating your
  working tree: without a terminal, soot runs unattended and never approves for you.

Approve the update yourself by running interactively (here the `y` comes from you via the pipe):

```sh
echo y | soot run "Change the page title to HELLO WORLD and update the primary button to purple." \
  --agent mock --mock-script mock-agent.json --interactive
git log --oneline
```

Then look around:

```sh
soot status            # all runs
soot status <run-id>   # one run: tasks, models, verdicts, decisions
soot cost              # latest run: estimates and reported (fictional, mock) actuals
soot models            # the demo registry (real model ids and sourced prices; fictional priors)
soot config            # resolved config; key variable names only
```

Other recorded prompts the demo understands (build spec §17 Tests 2 and 4, and §3):

```sh
soot run "Change the button color to purple, add a reusable dropdown component, and investigate the previous authentication bug." --agent mock --mock-script mock-agent.json
soot run "Implement a new feature, add tests, and review the implementation for security issues." --agent mock --mock-script mock-agent.json
```

The second one ends incomplete on purpose: the security review is read-only and has no
command soot could run to verify it, so soot does not mark it complete.

## Using soot in your own repository

1. Commit a `soot.config.json` (see [configuration](configuration.md#project-config-sootconfigjson))
   and a model registry file. Keep the state directory (`SOOT_DATA_DIR`, default `~/.soot`)
   outside the repository.
2. Today soot decomposes **recorded** prompts (the build spec examples, plus your own under
   `fixtures`). Other prompts need an optional `decomposer` model in `soot.config.json`
   ([configuration](configuration.md#decomposer-model-optional-adr-034)). Pick a runner:
   `--agent api` sends each task to its routed model with your keys (see below),
   `--agent mock` is the scripted test double, `--agent acp` is an ACP agent you configure.
   `soot run` with no `--agent` refuses.

## Run tasks on real models (`--agent api`, ADR-039)

Configure your providers and models (with your own `reliability` priors) in the models file and
put the keys in the variables they name, then:

```sh
soot run "<prompt>" --agent api            # result left on soot/<run>/integration unless approved
soot run "<prompt>" --agent api --apply    # also fast-forward your branch once everything verified
```

Each task's routed model receives the task and its files and returns whole-file contents; soot
validates the paths, commits in the task's worktree, runs your checks, merges, and reports the
provider's reported tokens and the cost at list price. `--apply` approves only landing a fully
verified result on a clean working tree; nothing else is approved for you.

## Install the agent skill

The universal skill (`skills/universal-orchestrator/SKILL.md`, Agent Skills format) tells a host
agent to hand multi-part requests to soot instead of splitting them itself.

```sh
soot install-skill --target /path/to/your/project              # .agents, .claude and .grok skill paths
soot install-skill --target /path/to/your/project --harness claude
```

It writes only `<target>/.agents/skills/universal-orchestrator/`,
`<target>/.claude/skills/universal-orchestrator/` and
`<target>/.grok/skills/universal-orchestrator/`, and never replaces a locally changed copy
without `--force`. For a user-level install, pass your home directory as `--target`
explicitly; soot never picks it for you.

Whether a given harness loads the skill is **not verified** yet (Claude Code: M6-04, Codex:
M6-05).

## MCP server

`soot mcp` serves the tools `soot_run`, `soot_status`, `soot_cost`, `soot_models` and
`soot_stop` over stdio (official MCP TypeScript SDK). A generic client entry looks like:

```json
{
  "mcpServers": {
    "soot": {
      "command": "node",
      "args": [
        "/absolute/path/to/soot/apps/cli/dist/bin.js",
        "mcp",
        "--agent",
        "mock",
        "--mock-script",
        "mock-agent.json"
      ],
      "cwd": "/absolute/path/to/your/repo"
    }
  }
}
```

Over MCP soot runs **unattended**: anything that needs approval is refused, and your working
tree is left untouched (results wait on `soot/<run-id>/integration`). This is tested with the
MCP SDK's own client; it is not verified inside any specific product.

## Run tasks through an ACP agent

soot has one generic ACP (Agent Client Protocol) driver: for each task attempt it starts the
agent command **you** configure, opens an ACP session in the task's worktree, sends the task,
and reads the result. soot never searches for, installs, or signs in to an agent; it runs only
what you put in `soot.config.json`:

```json
{
  "acpAgent": {
    "command": "/absolute/path/to/your-acp-agent",
    "args": ["--some-flag"],
    "passEnv": []
  }
}
```

```sh
soot run "<recorded prompt>" --agent acp --interactive
```

- The agent may read files in the task's worktree and write only inside the task's write lease,
  through ACP. soot still diffs and checks everything.
- When the agent asks permission for a tool call, **you** answer (`--interactive`); soot picks
  "allow once" only if you approve. Unattended, the request is rejected and that task is
  refused; independent tasks continue.
- If the agent advertises a `model` session option, soot sets it to the routed model for each
  attempt. If not, the run output and report say "route not applied" and the agent picks its
  own model; such attempts are not counted as routing history.
- Verified only with soot's own mock ACP agent
  (`packages/harness-adapters/dist/acp/mock-agent-bin.js <script.json>`). Whether any vendor
  harness works this way is untested.

## Run tasks through Claude Code or Codex (simulated only, not yet run for real)

> **Status:** implemented and tested against **simulated adapters only** (scripted fakes in this
> repository, ADR-047). Nobody has run these runners with the real Claude Code or Codex yet,
> so neither harness is listed as supported (M6-04 / M6-05 are "Implemented (simulated
> only)"). Treat the setup below as untested until a recorded real run exists.

`--agent claude-code` and `--agent codex` are small profiles over the generic ACP driver above.
Each runs the ACP adapter for that harness that **you** installed and signed in to yourself
(for example the community ACP adapters for Claude Code and for Codex). soot never installs,
downloads, searches for, or signs in to anything, and never bundles a vendor SDK:

```json
{
  "harnesses": {
    "claude-code": {
      "command": "/absolute/path/to/your-claude-code-acp-adapter",
      "args": [],
      "passEnv": [],
      "models": { "anthropic/claude-sonnet-x": "sonnet" },
      "allowedModes": ["default"]
    },
    "codex": {
      "command": "/absolute/path/to/your-codex-acp-adapter",
      "allowedModes": ["read-only"]
    }
  }
}
```

```sh
soot run "<recorded prompt>" --agent claude-code --interactive
soot run "<recorded prompt>" --agent codex --interactive
```

- `command` must be an **absolute path** (soot does not search `PATH`), run without a shell, in
  the task's worktree, with the same scrubbed environment as `acpAgent`. `passEnv` takes
  variable names only; credential-like names (`*KEY*`, `*TOKEN*`, ...) are refused. Sign-in
  stays in the harness's own config location (for example its config directory under `HOME`).
- **Approvals stay with you**, exactly as for `--agent acp`: soot picks the adapter's "allow
  once" option only when you approve; a denial, or any request in an unattended run, is
  rejected and the task is refused. soot never picks "always allow".
- **Modes.** soot never changes the harness's mode. It reads the mode the adapter reports and
  refuses the task when that mode turns the harness's own approvals off (Claude Code
  `bypassPermissions`; Codex `agent-full-access`), or when you set `allowedModes` and the mode
  is not in it. In modes where the harness approves some actions itself by your own setting
  (Claude Code `auto` / `acceptEdits`, Codex `agent` / `workspace-write`), the task runs and the
  result notes it; soot still diffs the worktree and runs its checks. To be asked for every
  action, set the harness's own mode to an asking one and list it in `allowedModes`.
- Arguments that skip approvals or the sandbox (`--dangerously-*`, `--yolo`, `--full-auto`,
  `bypassPermissions`, `danger-full-access`, `-a never`, `approval_policy="never"`) are refused
  in the config, for `acpAgent` too.
- **Sign-in.** If the adapter reports that nobody is signed in, the task is blocked with "sign in
  to Claude Code / Codex yourself"; soot never calls `authenticate`. An adapter that does not
  start a session within `startupTimeoutMs` (default 60 s; it may be waiting for a login) fails
  the attempt and is stopped.
- **Model routing.** If the adapter offers a `model` option, soot sets it to the routed model,
  via your `models` map (soot ref → adapter value) or an exact / bare-id match; otherwise the run
  says "route not applied". Token counts are not reported over ACP and are never invented.
- **Cancel and timeouts.** Stopping a run or task, or the attempt timeout, sends
  `session/cancel`; after `cancelGraceMs` (default 2 s) the adapter process is ended.
- The skill and MCP server are separate: they let the harness call soot. These runners let soot
  call the harness. Do not point a harness runner at a harness session that is itself running
  `soot mcp` for the same repository.

## VS Code / Cursor extension (local build; run in VS Code, not in Cursor)

> Sideloading steps for VS Code and Cursor are in
> [`apps/vscode-extension/README.md`](../../apps/vscode-extension/README.md#sideloading-the-local-build).
> They were followed in VS Code 1.144.0 on macOS (M7-01, 2026-11-14); Cursor is **unverified**.

`apps/vscode-extension` is a thin view onto the CLI (ADR-029). It is unpublished and has been
run in one real editor (VS Code, mock agent only), so treat it as experimental.

```sh
pnpm build
pnpm --filter soot-vscode package:vsix    # vsce package via pnpm dlx; nothing is published
code --install-extension apps/vscode-extension/dist/soot-vscode-0.0.0.vsix
```

Then set `soot.cliPath` to `<checkout>/apps/cli/dist/bin.js`, run **soot: Enable
orchestration**, and **soot: Run a prompt**. Runs from the editor are unattended: anything that
needs approval is refused and left on `soot/<run>/integration`. Right-click a running task to
cancel it (`soot stop <run> --task <id>` does the same from a terminal). Settings are listed in
[`apps/vscode-extension/README.md`](../../apps/vscode-extension/README.md).

## Verify the checkout

```sh
pnpm run ci   # install, typecheck, lint, format check, tests, build
```
