# @soot/cli

> **Status: partial (Milestone 6).** The `soot` binary. Runs the full workflow on recorded
> prompts with the scripted mock agent, or through a configured ACP agent (`--agent acp`,
> generic driver tested only with soot's mock ACP agent). ADR-026, ADR-027.

```
soot run "<prompt>" --agent mock --mock-script <file> [--interactive] [--json]
soot run "<prompt>" --agent acp [--interactive]     # spawns acpAgent from soot.config.json
soot status [run-id] | cost [run-id] | models | config | stop <run-id> [--task <task-id>]
soot resume <run-id> | --latest [--allow-config-change] [--retry-blocked] [--interactive] [--apply]   # ADR-054
soot init [--repo <dir>] [--force] [--decomposer auto|<provider/modelId>]
soot install-skill --target <dir> [--harness agents|claude|grok] [--force]
soot mcp --agent mock --mock-script <file>
soot dashboard [--port <n>] [--open]   # optional, 127.0.0.1 only (default 8787), ADR-031
```

`soot dashboard` is the only command that loads `@soot/dashboard` (a lazy `import()`; the CLI
lists it as an optional peer). It prints the URL, opens a browser only with `--open`, fails if
the port is taken, and stops on Ctrl-C. Every other command is headless.

`soot resume` continues an interrupted, stopped or blocked run from `soot.sqlite`. It keeps
done tasks and refuses live runs and config drift (ADR-054). Resuming a complete run exits 0
and changes nothing.

`soot init` writes `soot.config.json` from discovered project checks (ADR-055). A decomposer
model is written only when you pass `--decomposer`.

Exit codes: 0 complete, 1 error, 2 incomplete, 3 cancelled. Quick start:
[`docs/guides/installation.md`](../../docs/guides/installation.md). Config reference:
[`docs/guides/configuration.md`](../../docs/guides/configuration.md#project-config-sootconfigjson).
