/*
 * The orchestration surface every harness adapter exposes (MCP today; ACP-launched harness
 * runners later). One implementation (the soot engine in `@soot/cli`) serves the CLI and the
 * MCP server, so both return the same text and the same structured data.
 */

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Result of one orchestration command: readable text plus the same facts as JSON. */
export interface CommandOutput {
  /** `false` when the command could not do what was asked (unknown run, refused, ...). */
  readonly ok: boolean;
  readonly text: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

export interface RunRequest {
  /** The user's prompt, passed through verbatim. */
  readonly prompt: string;
  /** Repository to work in (absolute, or relative to the engine's working directory). */
  readonly repo?: string;
  readonly runId?: string;
}

export interface OrchestrationService {
  /** Plan, route, execute, verify, integrate, and report one prompt. */
  run(request: RunRequest, signal?: AbortSignal): Promise<CommandOutput>;
  /** All runs, or one run's tasks. */
  status(runId?: string): Promise<CommandOutput>;
  /** Estimated vs actual cost of one run (default: the latest). */
  cost(runId?: string): Promise<CommandOutput>;
  /** Configured models, their eligibility and exclusions. */
  models(): Promise<CommandOutput>;
  /** Ask a running run to stop. */
  stop(runId: string): Promise<CommandOutput>;
}
