/**
 * @soot/harness-adapters
 *
 * Milestone 6 (partial): the orchestration service interface shared by the CLI and harness
 * adapters, an MCP server exposing it as tools (official MCP TypeScript SDK), one generic ACP
 * driver (official ACP TypeScript SDK) that runs a task through any ACP agent the user
 * configures, and Claude Code / Codex runner profiles over that driver (ADR-047). All of it is
 * tested only with soot's own mock ACP agent and simulated adapters; no vendor harness is
 * claimed.
 */

export const PACKAGE_NAME = '@soot/harness-adapters';

/** `partial`: service, MCP server and a generic ACP driver exist; no harness is verified. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 6;

export type { CommandOutput, JsonValue, OrchestrationService, RunRequest } from './service.js';
export { MCP_TOOL_NAMES, createSootMcpServer, type SootMcpServerOptions } from './mcp-server.js';
export { HARNESS_SUPPORT, type HarnessSupport } from './harnesses.js';
export {
  ACP_CLIENT_INFO,
  AcpAbortError,
  AcpAgentRunner,
  DEFAULT_MODE_POLICY,
  KNOWN_BYPASS_MODES,
  matchModelValue,
  modeRefusal,
  permissionOutcome,
  reportedMode,
  type AcpAgentRunnerOptions,
  type AcpModePolicy,
  type AcpRouteRecord,
  type AcpConnector,
  type AcpEndpoint,
} from './acp/runner.js';
export {
  agentEnvironment,
  describeCommand,
  spawnAcpAgent,
  type AcpAgentCommand,
} from './acp/spawn.js';
export {
  HARNESS_IDS,
  HARNESS_PROFILES,
  createHarnessRunner,
  forbiddenAgentArg,
  harnessModePolicy,
  harnessRunnerLabel,
  type HarnessAgentConfig,
  type HarnessId,
  type HarnessProfile,
  type HarnessRunnerOptions,
} from './acp/harness-profiles.js';
export { simulatedHarnessScript, type SimulatedHarnessOptions } from './acp/simulated-harnesses.js';
export {
  MockAcpScriptSchema,
  MockAcpStepSchema,
  createMockAcpAgent,
  loadMockAcpScript,
  type MockAcpLog,
  type MockAcpScript,
  type MockAcpStep,
} from './acp/mock-agent.js';
