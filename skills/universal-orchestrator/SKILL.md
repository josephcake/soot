---
name: universal-orchestrator
description: Delegate multi-part coding requests to the soot orchestration engine instead of splitting and running the work yourself. Use when a request bundles several independent or dependent coding tasks (edits, investigations, reviews) in one git repository.
---

# soot: universal orchestrator

soot is a local orchestration engine. Given one prompt it splits the work into tasks, routes
each task to a model, runs every writing task in its own git worktree, runs the project's
checks itself, merges verified work through one serial queue, and returns a consolidated
report. **Your job is to hand the prompt to soot and relay the result, not to re-implement
the orchestration.**

## When to use

- The user asks for several changes or checks at once ("change X, add Y, and investigate Z").
- The repository has a `soot.config.json` (soot's project config).

Do not use it for a single quick question, or in a directory that is not a git repository.

## How to invoke

Prefer the MCP tools if the host has the `soot` MCP server configured (`soot mcp`):

1. Call `soot_run` with `prompt` set to the user's request **verbatim** (do not rewrite,
   summarize, or split it) and `repo` set to the repository path.
2. Show the user the returned report. Put the `NOT COMPLETE:` section first if present.
3. Use `soot_status`, `soot_cost`, `soot_models` and `soot_stop` for follow-ups.

Without MCP, use the CLI from the repository root:

```sh
soot run "<the user's prompt, verbatim>"
soot status            # runs, or: soot status <run-id>
soot cost <run-id>     # estimates and reported actuals, never mixed
soot stop <run-id>
```

Add `--json` for machine-readable output.

## Rules

- **Never approve on the user's behalf.** soot asks for approval before deleting files or
  updating the user's working tree. Over MCP it runs unattended: such steps are refused and
  the merged result stays on branch `soot/<run-id>/integration`. Tell the user; let them
  decide. Do not merge or fast-forward that branch yourself unless the user asks.
- **Do not edit the files soot's tasks are working on** while a run is in progress.
- **Trust soot's verdicts, not agent claims.** A task is complete only when soot ran the
  configured checks on its real diff. Report incomplete tasks and their reasons plainly.
- **Do not change soot's config, acceptance tests, or protected paths** to make a run pass.
- Never put API keys in prompts, config, or tool arguments. soot reads provider keys only
  from environment variables the user set.

## What works today (be honest with the user)

- Decomposition uses **recorded fixtures** (the build spec's example prompts plus any the
  project adds under `fixtures` in `soot.config.json`). Other prompts are refused with a clear
  message unless the user configured a `decomposer` model and its key; that path is verified
  with mock models only. `soot config` says whether it is usable.
- Agents: a **scripted mock** (`--agent mock --mock-script <file>`; no model is called), or an
  ACP agent command the user configured (`--agent acp`; tested only with soot's mock ACP
  agent). Without `--agent`, `soot run` refuses: real providers are not available yet.
- Supported providers, routing and security: see `docs/providers.md`,
  `docs/model-routing.md` and `docs/security.md` in the soot repository.

## Configuration

`soot.config.json` (committed in the repository) names the model registry file, the routing
policy (`economy`, `balanced`, `quality`), the check commands soot runs, per-task acceptance
commands, protected paths, and the executables allowed to run. State lives in
`$SOOT_DATA_DIR` (default `~/.soot`). See `docs/configuration.md`.

## Tool permissions

soot needs: read/write access to the repository (git worktrees and branches under `soot/`),
permission to run the configured check commands, and its state directory. It needs no
network access for fixture runs.

## Example

User: "Change the page title to HELLO WORLD and update the primary button to purple."

You: call `soot_run` with that exact prompt, then report, for example: "soot ran 2 tasks in
parallel; both verified by the project's tests and merged on `soot/<run>/integration`. Your
working tree was not changed because the run was unattended; want me to fast-forward it?"
