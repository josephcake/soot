import * as acp from '@agentclientprotocol/sdk';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

/*
 * TEST DOUBLE. A scripted ACP agent built with the official ACP SDK's agent side. It calls no
 * model, makes no network request, and touches files only through the client's
 * `fs/*_text_file` methods (soot decides what is allowed). It exists so soot's generic ACP
 * driver can be tested without any vendor harness. Never present its output as real work.
 */

const STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
] as const;

export const MockAcpStepSchema = z
  .object({
    /** Text sent as `agent_message_chunk` updates. */
    message: z.string().max(2000).optional(),
    /** Ask `session/request_permission` before writing; without "allow once" nothing is written. */
    permission: z
      .object({
        title: z.string().min(1).max(200),
        kind: z
          .enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other'])
          .optional(),
      })
      .strict()
      .optional(),
    /** Files to write through `fs/write_text_file`, relative to the session cwd. */
    writes: z.record(z.string().min(1), z.string()).optional(),
    /** Files to read through `fs/read_text_file`, relative to the session cwd (or absolute). */
    reads: z.array(z.string().min(1)).optional(),
    stopReason: z.enum(STOP_REASONS).optional(),
    /** Wait this long before finishing (cancel ends the wait). */
    delayMs: z.int().min(0).max(60_000).optional(),
    /** Ignore `session/cancel` (a misbehaving agent). */
    ignoreCancel: z.boolean().optional(),
    /** Fictional cost reported in a `usage_update`. */
    costUsd: z.number().min(0).optional(),
  })
  .strict();
export type MockAcpStep = z.infer<typeof MockAcpStepSchema>;

export const MockAcpScriptSchema = z
  .object({
    version: z.literal(1),
    label: z.string().max(200).optional(),
    /**
     * Advertise a `model` session config option (select). `refuse` makes
     * `session/set_config_option` fail; `ignore` answers without changing the value.
     */
    models: z
      .object({
        current: z.string().min(1),
        values: z.array(z.string().min(1)).min(1).max(50),
        behaviour: z.enum(['apply', 'refuse', 'ignore']).default('apply'),
      })
      .strict()
      .optional(),
    /** `session/new` fails with ACP `auth_required` (the user is not signed in). */
    requireAuth: z.boolean().optional(),
    /** Step per soot task id (read from the prompt's "Task <id>:" line). */
    tasks: z.record(z.string().min(1), MockAcpStepSchema),
    default: MockAcpStepSchema.optional(),
  })
  .strict();
export type MockAcpScript = z.infer<typeof MockAcpScriptSchema>;

export function loadMockAcpScript(path: string): MockAcpScript {
  try {
    return MockAcpScriptSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new Error(`invalid mock ACP script ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/** What the mock agent saw, for assertions. */
export interface MockAcpLog {
  readonly methods: string[];
  readonly permissionOutcomes: acp.RequestPermissionOutcome[];
  readonly writeErrors: string[];
  readonly prompts: string[];
}

const TASK_LINE = /^Task ([A-Za-z0-9][A-Za-z0-9._-]*):/m;

export function createMockAcpAgent(
  script: MockAcpScript,
  log: MockAcpLog = { methods: [], permissionOutcomes: [], writeErrors: [], prompts: [] },
  onLog?: (entry: Record<string, unknown>) => void,
): { app: acp.AgentApp; log: MockAcpLog } {
  const sessions = new Map<
    string,
    { cwd: string; cancelled: boolean; wake: (() => void) | null; model: string | null }
  >();
  const modelOption = (current: string): acp.SessionConfigOption[] =>
    script.models === undefined
      ? []
      : [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: current,
            options: script.models.values.map((v) => ({ value: v, name: v })),
          },
        ];
  let caps: acp.ClientCapabilities = {};
  let next = 1;
  const note = (method: string, extra: Record<string, unknown> = {}) => {
    log.methods.push(method);
    onLog?.({ method, ...extra });
  };

  const app = acp
    .agent({ name: 'soot-mock-acp-agent' })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      note('initialize', { clientInfo: params.clientInfo?.name ?? null });
      caps = params.clientCapabilities ?? {};
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: 'soot-mock-acp-agent', version: '0.0.0' },
        authMethods: [],
      };
    })
    .onRequest(acp.methods.agent.session.new, ({ params }) => {
      note('session/new', { cwd: params.cwd, mcpServers: params.mcpServers.length });
      if (script.requireAuth === true) throw acp.RequestError.authRequired();
      const id = `mock-session-${String(next++)}`;
      const model = script.models?.current ?? null;
      sessions.set(id, { cwd: params.cwd, cancelled: false, wake: null, model });
      return model === null
        ? { sessionId: id }
        : { sessionId: id, configOptions: modelOption(model) };
    })
    .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
      const value = 'value' in params ? String(params.value) : '';
      note('session/set_config_option', { configId: params.configId, value });
      const s = sessions.get(params.sessionId);
      if (s === undefined) throw acp.RequestError.sessionNotFound(params.sessionId);
      const m = script.models;
      if (m === undefined || params.configId !== 'model') {
        throw acp.RequestError.invalidParams(undefined, `unknown config option ${params.configId}`);
      }
      if (m.behaviour === 'refuse') throw acp.RequestError.invalidParams(undefined, 'model locked');
      if (!m.values.includes(value))
        throw acp.RequestError.invalidParams(undefined, `no model ${value}`);
      if (m.behaviour === 'apply') s.model = value;
      return { configOptions: modelOption(s.model ?? m.current) };
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      note('session/cancel');
      const s = sessions.get(params.sessionId);
      if (s !== undefined) {
        s.cancelled = true;
        s.wake?.();
      }
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const text = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      log.prompts.push(text);
      const taskId = TASK_LINE.exec(text)?.[1] ?? null;
      const session = sessions.get(params.sessionId);
      note('session/prompt', { taskId, model: session?.model ?? null });
      if (session === undefined) throw acp.RequestError.sessionNotFound(params.sessionId);
      const step: MockAcpStep =
        (taskId === null ? undefined : script.tasks[taskId]) ?? script.default ?? {};
      const sessionId = params.sessionId;
      const say = (t: string) =>
        client.notify(acp.methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } },
        });
      const stopped = (): acp.PromptResponse | null =>
        session.cancelled && step.ignoreCancel !== true ? { stopReason: 'cancelled' } : null;

      await say(`[mock ACP agent] task ${taskId ?? '(unknown)'}. `);
      if (step.permission !== undefined) {
        await client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: step.permission.title,
            kind: step.permission.kind ?? 'edit',
            status: 'pending',
          },
        });
        const request: acp.RequestPermissionRequest = {
          sessionId,
          toolCall: {
            toolCallId: 'call-1',
            title: step.permission.title,
            kind: step.permission.kind ?? 'edit',
            locations: Object.keys(step.writes ?? {}).map((p) => ({ path: join(session.cwd, p) })),
          },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        };
        const answer = await client.request(acp.methods.client.session.requestPermission, request);
        log.permissionOutcomes.push(answer.outcome);
        onLog?.({ method: 'permission-answer', outcome: answer.outcome });
        const allowed =
          answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'allow';
        if (!allowed) {
          await say('Permission was not granted; stopping without changes.');
          return stopped() ?? { stopReason: 'end_turn' };
        }
      }
      for (const rel of step.reads ?? []) {
        try {
          await client.request(acp.methods.client.fs.readTextFile, {
            sessionId,
            path: isAbsolute(rel) ? rel : join(session.cwd, rel),
          });
        } catch (error) {
          log.writeErrors.push(`read ${rel}: ${(error as Error).message}`);
        }
      }
      if (step.writes !== undefined && caps.fs?.writeTextFile === true) {
        for (const [rel, content] of Object.entries(step.writes)) {
          try {
            await client.request(acp.methods.client.fs.writeTextFile, {
              sessionId,
              path: isAbsolute(rel) ? rel : join(session.cwd, rel),
              content,
            });
          } catch (error) {
            log.writeErrors.push(`${rel}: ${(error as Error).message}`);
            onLog?.({ method: 'write-refused', path: rel });
          }
        }
      }
      if (step.costUsd !== undefined) {
        await client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'usage_update',
            used: 1000,
            size: 200_000,
            cost: { amount: step.costUsd, currency: 'USD' },
          },
        });
      }
      if ((step.delayMs ?? 0) > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, step.delayMs);
          session.wake = () => {
            if (step.ignoreCancel === true) return;
            clearTimeout(timer);
            resolve();
          };
        });
      }
      const s = stopped();
      if (s !== null) return s;
      if (step.message !== undefined) await say(step.message);
      return { stopReason: step.stopReason ?? 'end_turn' };
    });
  // Anything else (authenticate, session/set_mode, ...) is recorded and rejected.
  app.onRequest('*', ({ method }) => {
    note(method);
    throw acp.RequestError.methodNotFound(method);
  });
  return { app, log };
}
