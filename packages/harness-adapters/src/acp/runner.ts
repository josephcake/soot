import * as acp from '@agentclientprotocol/sdk';
import type { AgentRunner, AgentTaskInput, ApprovalDecision } from '@soot/agent-runtime';
import { buildAgentContext, renderAgentContext } from '@soot/context-manager';
import type { AgentResult, Finding } from '@soot/task-graph';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/*
 * Generic ACP (Agent Client Protocol, stable v1) driver: soot is the ACP *client* and drives
 * one ACP agent session per task attempt (ADR-027). Uses the official ACP TypeScript SDK.
 *
 * What soot offers the agent, and nothing more:
 * - `fs/read_text_file` inside the task's worktree, `fs/write_text_file` inside the task's
 *   write lease (everything else is refused with a JSON-RPC error).
 * - `session/request_permission` answered ONLY by a person through soot's approval gate. soot
 *   never picks an "allow" option on its own, never picks "allow always", and when nobody can
 *   answer (unattended) it rejects and refuses the task.
 * - No terminal capability, no MCP servers, no authentication (soot never signs in), no
 *   session mode changes (the host's approval settings stay as the user set them).
 * - Routed model (ADR-028): when the agent advertises a session config option in the `model`
 *   category, soot sets it to the routed model for this attempt (`session/set_config_option`,
 *   that option only). Otherwise the route is reported as NOT applied, never silently dropped.
 *
 * The agent's report is a claim: soot's isolated runner still diffs and checks the worktree.
 */

/** Where the ACP agent is: an ACP stream (stdio of a spawned process) or an in-process app. */
export interface AcpEndpoint {
  readonly target: acp.Stream | acp.AgentApp;
  /** Display label, e.g. the configured command. Never a vendor product name chosen by soot. */
  readonly label: string;
  /** Called once when the attempt ends (kill the process, close streams). */
  close(): void | Promise<void>;
  /** Diagnostics from the agent process (stderr tail), when available. */
  diagnostics?(): string;
}

export type AcpConnector = (cwd: string) => AcpEndpoint | Promise<AcpEndpoint>;

/** Whether soot's routed model was applied to the ACP session for one attempt. */
export interface AcpRouteRecord {
  readonly taskId: string;
  readonly attempt: number;
  /** soot's routed model ref (`provider/modelId`), or `null` when nothing was routed. */
  readonly routed: string | null;
  readonly applied: boolean;
  /** Option value the agent confirmed, when applied. */
  readonly agentValue: string | null;
  readonly reason: string;
}

export interface AcpAgentRunnerOptions {
  readonly connect: AcpConnector;
  /** Approval mode of the run, shown to the agent in its task text. */
  readonly approvals: 'interactive' | 'unattended';
  /** How long to wait for the agent to stop after `session/cancel`. Default 2000 ms. */
  readonly cancelGraceMs?: number;
  /** Max bytes per `fs/write_text_file`. Default 1 MiB. */
  readonly maxWriteBytes?: number;
  /** Called once per attempt (after the session starts) with whether the route was applied. */
  readonly onRoute?: (record: AcpRouteRecord) => void;
}

type SelectOption = Extract<acp.SessionConfigOption, { type: 'select' }>;

function selectValues(option: SelectOption): string[] {
  return option.options.flatMap((o) => ('group' in o ? o.options.map((x) => x.value) : [o.value]));
}

/** The agent's option value for a routed model ref: the exact ref, or the id after `provider/`. */
export function matchModelValue(routed: string, values: readonly string[]): string | null {
  if (values.includes(routed)) return routed;
  const bare = routed.includes('/') ? routed.slice(routed.indexOf('/') + 1) : routed;
  return values.includes(bare) ? bare : null;
}

export const ACP_CLIENT_INFO = { name: 'soot', title: 'soot', version: '0.0.0' } as const;

const TEXT_CAP = 1800;

const clean = (text: string, max = 400): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, max);

export class AcpAbortError extends Error {
  constructor(taskId: string) {
    super(`ACP attempt for "${taskId}" was cancelled`);
    this.name = 'AbortError';
  }
}

interface AttemptState {
  text: string;
  toolCalls: number;
  costUsd: number | null;
  /** Approval not granted for a permission request: the task is refused. */
  refused: { decision: Exclude<ApprovalDecision, 'approved'>; detail: string } | null;
  issues: Finding[];
  permissionsAsked: number;
  route: AcpRouteRecord | null;
}

function inside(root: string, path: string): string | null {
  if (!isAbsolute(path)) return null;
  const target = resolve(path);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return relative(root, target).split(sep).join('/');
}

const inScope = (rel: string, scope: readonly string[]): boolean =>
  scope.some((s) => (s.endsWith('/') ? rel.startsWith(s) : rel === s));

function permissionDetail(req: acp.RequestPermissionRequest): string {
  const t = req.toolCall;
  const parts = [
    t.kind ?? 'other',
    t.title ?? t.name ?? t.toolCallId,
    ...(t.locations ?? []).map((l) => l.path),
  ];
  const raw = t.rawInput === undefined ? '' : ` input=${JSON.stringify(t.rawInput)}`;
  return clean(`${parts.join(' ')}${raw}`);
}

/** soot's answer to `session/request_permission`. Exported for tests. */
export function permissionOutcome(
  options: readonly acp.PermissionOption[],
  decision: ApprovalDecision,
): acp.RequestPermissionOutcome {
  if (decision === 'approved') {
    // Only a one-time allow: approving once never grants future calls without asking.
    const once = options.find((o) => o.kind === 'allow_once');
    if (once !== undefined) return { outcome: 'selected', optionId: once.optionId };
    return { outcome: 'cancelled' };
  }
  const reject =
    options.find((o) => o.kind === 'reject_once') ??
    options.find((o) => o.kind === 'reject_always');
  return reject === undefined
    ? { outcome: 'cancelled' }
    : { outcome: 'selected', optionId: reject.optionId };
}

export class AcpAgentRunner implements AgentRunner {
  readonly kind = 'acp';
  readonly #o: AcpAgentRunnerOptions;

  constructor(options: AcpAgentRunnerOptions) {
    this.#o = options;
  }

  async run(input: AgentTaskInput, signal: AbortSignal): Promise<unknown> {
    const { task } = input;
    if (input.workspace === undefined) {
      throw new Error(
        `ACP runner needs a soot worktree for "${task.id}" (use the isolated runner)`,
      );
    }
    // A function, so TypeScript does not narrow `signal.aborted` from this first check.
    const aborted = () => signal.aborted;
    if (aborted()) throw new AcpAbortError(task.id);
    const root = realpathSync(input.workspace.root);
    const scope = input.workspace.writeScope;
    const permissions = input.permissions;
    const started = performance.now();
    const state: AttemptState = {
      text: '',
      toolCalls: 0,
      costUsd: null,
      refused: null,
      issues: [],
      permissionsAsked: 0,
      route: null,
    };
    const maxWrite = this.#o.maxWriteBytes ?? 1024 * 1024;
    const refuse = (message: string): never => {
      state.issues.push({ kind: 'issue', message: clean(message, 300) });
      throw acp.RequestError.invalidParams(undefined, message);
    };

    const app = acp
      .client({ name: 'soot' })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params, signal: s }) => {
        state.permissionsAsked++;
        const detail = permissionDetail(params);
        const decision: ApprovalDecision =
          permissions === undefined
            ? 'unavailable'
            : await permissions.requestApproval({ action: 'harness-permission', detail }, s);
        if (decision !== 'approved') state.refused ??= { decision, detail };
        return { outcome: permissionOutcome(params.options, decision) };
      })
      .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => {
        const rel = inside(root, params.path);
        if (rel === null) return refuse(`read outside the task worktree refused: ${params.path}`);
        let content: string;
        try {
          content = readFileSync(resolve(root, rel), 'utf8');
        } catch {
          throw acp.RequestError.resourceNotFound(params.path);
        }
        if (params.line == null && params.limit == null) return { content };
        const lines = content.split('\n');
        const from = Math.max(0, (params.line ?? 1) - 1);
        const to = params.limit == null ? lines.length : from + params.limit;
        return { content: lines.slice(from, to).join('\n') };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
        const rel = inside(root, params.path);
        if (rel === null || rel === '' || rel === '.git' || rel.startsWith('.git/')) {
          return refuse(`write outside the task worktree refused: ${params.path}`);
        }
        if (!inScope(rel, scope))
          return refuse(`write outside the task's write lease refused: ${rel}`);
        if (Buffer.byteLength(params.content) > maxWrite) return refuse(`write too large: ${rel}`);
        const target = resolve(root, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, params.content);
        return {};
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const u = params.update;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
          if (state.text.length < TEXT_CAP) state.text += u.content.text;
        } else if (u.sessionUpdate === 'tool_call') {
          state.toolCalls++;
        } else if (u.sessionUpdate === 'usage_update' && u.cost?.currency === 'USD') {
          state.costUsd = u.cost.amount;
        }
      });

    const endpoint = await this.#o.connect(root);
    try {
      const outcome = await app.connectWith(endpoint.target, (ctx) =>
        this.#attempt(ctx, input, root, state, signal),
      );
      if (outcome.kind === 'aborted') throw new AcpAbortError(task.id);
      return this.#result(input, state, outcome, endpoint, performance.now() - started);
    } catch (error) {
      if (error instanceof AcpAbortError || aborted()) {
        throw new AcpAbortError(task.id);
      }
      const diag = endpoint.diagnostics?.() ?? '';
      throw new Error(
        `ACP agent (${endpoint.label}) failed for "${task.id}": ${(error as Error).message}${diag === '' ? '' : ` | stderr: ${clean(diag, 300)}`}`,
        { cause: error },
      );
    } finally {
      await endpoint.close();
    }
  }

  async #attempt(
    ctx: acp.ClientContext,
    input: AgentTaskInput,
    root: string,
    state: AttemptState,
    signal: AbortSignal,
  ): Promise<
    | { kind: 'stopped'; stopReason: acp.StopReason; agent: string | null }
    | { kind: 'auth-required'; agent: string | null }
    | { kind: 'aborted' }
  > {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { ...ACP_CLIENT_INFO },
    });
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(
        `agent speaks ACP protocol ${String(init.protocolVersion)}; soot supports ${String(acp.PROTOCOL_VERSION)}`,
      );
    }
    const agent = init.agentInfo?.name ?? null;
    let session: acp.ActiveSession;
    try {
      session = await ctx.buildSession({ cwd: root, mcpServers: [] }).start();
    } catch (error) {
      // soot never authenticates or offers a login: the user signs in to their harness.
      if (error instanceof acp.RequestError && error.code === -32000) {
        return { kind: 'auth-required', agent };
      }
      throw error;
    }
    state.route = await this.#applyRoute(ctx, session, input);
    this.#o.onRoute?.(state.route);
    const text = renderAgentContext(
      buildAgentContext({
        task: input.task,
        dependencyResults: input.dependencyResults,
        priorAttempts: input.priorAttempts ?? [],
        approvals: this.#o.approvals,
      }),
    );
    const prompt = session.prompt(text);
    const grace = this.#o.cancelGraceMs ?? 2000;
    let cancelled: (() => void) | null = null;
    const gaveUp = new Promise<null>((r) => {
      cancelled = () => {
        setTimeout(() => {
          r(null);
        }, grace);
      };
    });
    let cancelSent = false;
    const cancel = () => {
      if (cancelSent) return;
      cancelSent = true;
      void ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      cancelled?.();
    };
    signal.addEventListener('abort', cancel, { once: true });
    // A refused permission refuses the task: stop the turn instead of letting it continue.
    const watchRefusal = setInterval(() => {
      if (state.refused !== null) cancel();
    }, 20);
    try {
      if (signal.aborted) cancel();
      const response = await Promise.race([prompt, gaveUp]);
      if (signal.aborted) return { kind: 'aborted' };
      // The agent did not stop within the grace period after cancel: treat the turn as cancelled.
      return { kind: 'stopped', stopReason: response?.stopReason ?? 'cancelled', agent };
    } finally {
      clearInterval(watchRefusal);
      signal.removeEventListener('abort', cancel);
      session.dispose();
      prompt.catch(() => undefined);
    }
  }

  /** Set the session's `model` config option to the routed model, if the agent offers one. */
  async #applyRoute(
    ctx: acp.ClientContext,
    session: acp.ActiveSession,
    input: AgentTaskInput,
  ): Promise<AcpRouteRecord> {
    const routed = input.assignment?.model ?? null;
    const base = { taskId: input.task.id, attempt: input.attempt, routed };
    const notApplied = (reason: string): AcpRouteRecord => ({
      ...base,
      applied: false,
      agentValue: null,
      reason: clean(reason, 300),
    });
    if (routed === null) return notApplied('no model was routed for this attempt');
    const options = session.newSessionResponse.configOptions ?? [];
    const model = options.find(
      (o): o is SelectOption => o.category === 'model' && o.type === 'select',
    );
    if (model === undefined) {
      return notApplied(
        `route not applied: the agent does not advertise a "model" config option, so it picks its own model (routed ${routed})`,
      );
    }
    const values = selectValues(model);
    const value = matchModelValue(routed, values);
    if (value === null) {
      return notApplied(
        `route not applied: the agent's model option "${model.id}" offers no value for ${routed} (offered: ${values.slice(0, 10).join(', ') || 'none'})`,
      );
    }
    try {
      const res = await ctx.request(acp.methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: model.id,
        value,
      });
      const after = res.configOptions.find((o) => o.id === model.id);
      if (after?.type !== 'select' || after.currentValue !== value) {
        return notApplied(
          `route not applied: the agent did not confirm ${value} for "${model.id}" (current: ${after === undefined ? 'unknown' : String(after.currentValue)})`,
        );
      }
    } catch (error) {
      return notApplied(
        `route not applied: the agent refused ${value}: ${(error as Error).message}`,
      );
    }
    return {
      ...base,
      applied: true,
      agentValue: value,
      reason: `routed model ${routed} applied as "${model.id}" = ${value}`,
    };
  }

  #result(
    input: AgentTaskInput,
    state: AttemptState,
    outcome:
      | { kind: 'stopped'; stopReason: acp.StopReason; agent: string | null }
      | { kind: 'auth-required'; agent: string | null },
    endpoint: AcpEndpoint,
    durationMs: number,
  ): AgentResult {
    const who = `ACP agent (${clean(endpoint.label, 80)}${outcome.agent === null ? '' : `, reports itself as "${clean(outcome.agent, 60)}"`})`;
    let status: AgentResult['status'];
    let summary: string;
    if (outcome.kind === 'auth-required') {
      status = 'blocked';
      summary = `${who} requires authentication. soot never signs in for you; sign in to the harness yourself.`;
    } else if (state.refused !== null) {
      status = 'blocked';
      summary = `${who} asked for permission (${state.refused.detail}); approval ${state.refused.decision}, so the task is refused.`;
    } else if (outcome.stopReason === 'end_turn') {
      status = 'succeeded';
      summary = `${who} ended its turn: ${clean(state.text, 300) || '(no message)'}`;
    } else {
      status = 'failed';
      summary = `${who} stopped (${outcome.stopReason}): ${clean(state.text, 300) || '(no message)'}`;
    }
    return {
      taskId: input.task.id,
      attempt: input.attempt,
      status,
      summary: clean(summary, 1000),
      findings: [
        {
          kind: 'observation',
          message: `Reported over ACP (${String(state.toolCalls)} tool calls, ${String(state.permissionsAsked)} permission requests). Agent claims are unverified until soot checks the worktree.`,
        },
        ...(state.route === null
          ? []
          : [
              {
                kind: 'decision' as const,
                message: clean(`ACP model routing: ${state.route.reason}`, 400),
              },
            ]),
        ...state.issues.slice(0, 20),
      ],
      patch: null,
      evidence: [],
      usage: {
        // ACP v1 reports no per-turn token counts; zero here means "not reported".
        inputTokens: 0,
        outputTokens: 0,
        durationMs,
        costUsd: state.costUsd,
        // The routed model only when the agent confirmed it; otherwise unknown (agent's choice).
        model: state.route?.applied === true ? state.route.routed : null,
      },
    };
  }
}
