# @soot/harness-adapters

> **Status: partial (Milestone 6).** The surfaces harnesses use to reach soot, and one generic ACP
> driver soot uses to reach them (ADR-026, ADR-027). No vendor harness is verified.

- `OrchestrationService`: run, status, cost, models, stop (text plus JSON results).
- `createSootMcpServer(service)`: MCP tools `soot_run`, `soot_status`, `soot_cost`,
  `soot_models`, `soot_stop` (official MCP TypeScript SDK v2). Runs are unattended: approvals
  are refused. Tested with the SDK's own client only.
- `HARNESS_SUPPORT`: Claude Code and Codex are `acp-profile-simulated` (a runner exists,
  tested against simulated adapters only), Grok is `not-implemented`; all are
  `verifiedEndToEnd: false`. Nothing is claimed until verified end to end.
- `createHarnessRunner('claude-code' | 'codex', config)` (ADR-047): a profile over
  `AcpAgentRunner` for the user's own ACP adapter: absolute command, approval-bypass arguments
  refused, bypass session modes refused (soot never changes modes), sign-in → blocked, optional
  `models` map and `allowedModes`, startup limit. `simulatedHarnessScript(id)` is the **test
  double** adapter shape used by the tests.
- `AcpAgentRunner`: generic ACP client (official `@agentclientprotocol/sdk`, stable v1). One
  session per attempt in the task's worktree; fs reads in the worktree, writes in the write
  lease; permission requests go to soot's approval gate (never auto-approved, never
  "allow always").
- `spawnAcpAgent(command)`: runs a user-configured agent command over stdio, no shell, scrubbed
  environment.
- `createMockAcpAgent`, `dist/acp/mock-agent-bin.js`: **test double** ACP agent used by the tests.
