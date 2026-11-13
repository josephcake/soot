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
   ([configuration](configuration.md#decomposer-model-optional-adr-034); verified with mock
   clients only, no real model has run it). The only agent is the scripted mock. `soot run` without
   `--agent mock` refuses: real providers need keys (M2-07, blocked) and harness runners are
   not implemented.

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

## VS Code / Cursor extension (local build, not run in an editor yet)

> Sideloading steps for VS Code and Cursor are in
> [`apps/vscode-extension/README.md`](../../apps/vscode-extension/README.md#sideloading-the-local-build-unverified).
> They are **unverified**: the `.vsix` has not been run in a real editor.

`apps/vscode-extension` is a thin view onto the CLI (ADR-029). It is unpublished and has only
been tested with a fake editor API, so treat it as experimental.

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
