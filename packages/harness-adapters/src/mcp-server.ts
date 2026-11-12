import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CommandOutput, OrchestrationService } from './service.js';

/*
 * MCP server exposing soot's orchestration as tools (M6-03). The host agent calls `soot_run`
 * with the user's prompt instead of decomposing the work itself. Approvals are never
 * collected or granted over MCP: the engine runs unattended here, so anything needing a
 * person's approval is refused and reported (ADR-018), and the user's working tree is left
 * untouched (the result stays on soot's integration branch).
 */

export const MCP_TOOL_NAMES = [
  'soot_run',
  'soot_status',
  'soot_cost',
  'soot_models',
  'soot_stop',
] as const;

export interface SootMcpServerOptions {
  readonly name?: string;
  readonly version?: string;
}

const result = (out: CommandOutput) => ({
  content: [{ type: 'text' as const, text: out.text }],
  structuredContent: out.data as Record<string, unknown>,
  isError: !out.ok,
});

const runId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export function createSootMcpServer(
  service: OrchestrationService,
  options: SootMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: options.name ?? 'soot', version: options.version ?? '0.0.0' },
    {
      instructions:
        'soot orchestrates multi-part coding requests: it splits the prompt into tasks, routes each to a ' +
        'model, runs them in isolated git worktrees, runs the project checks itself, integrates verified ' +
        'work, and returns a consolidated report. Pass the user prompt verbatim to soot_run. soot never ' +
        'approves anything on the user\u2019s behalf; over MCP it runs unattended.',
    },
  );

  server.registerTool(
    'soot_run',
    {
      title: 'Run soot orchestration',
      description:
        'Run the full soot workflow for one prompt in a git repository and return the consolidated ' +
        'report (incomplete work listed first). Unattended: actions that need approval are refused, ' +
        'and the user\u2019s working tree is not changed; verified work is left on soot/<run>/integration.',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('The user prompt, verbatim.'),
        repo: z.string().min(1).optional().describe('Repository path (default: server cwd).'),
        runId: runId.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args, ctx) =>
      result(
        await service.run(
          {
            prompt: args.prompt,
            ...(args.repo === undefined ? {} : { repo: args.repo }),
            ...(args.runId === undefined ? {} : { runId: args.runId }),
          },
          ctx.mcpReq.signal,
        ),
      ),
  );
  server.registerTool(
    'soot_status',
    {
      title: 'soot run status',
      description: 'List soot runs, or show one run\u2019s tasks, models, and verdicts.',
      inputSchema: z.object({ runId: runId.optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => result(await service.status(args.runId)),
  );
  server.registerTool(
    'soot_cost',
    {
      title: 'soot run cost',
      description:
        'Per-task and total cost of a run: estimates and reported actuals, never mixed (default: latest run).',
      inputSchema: z.object({ runId: runId.optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => result(await service.cost(args.runId)),
  );
  server.registerTool(
    'soot_models',
    {
      title: 'soot models',
      description: 'Configured models with pricing, reliability priors, and exclusions.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => result(await service.models()),
  );
  server.registerTool(
    'soot_stop',
    {
      title: 'Stop a soot run',
      description:
        'Ask a running soot run to cancel. Running agents are aborted; nothing is merged.',
      inputSchema: z.object({ runId }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => result(await service.stop(args.runId)),
  );
  return server;
}
