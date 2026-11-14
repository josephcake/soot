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
 * - Session modes (ADR-047): soot never changes the agent's mode. It reads the mode the agent
 *   reports (`modes.currentModeId`, a `mode` config option, or `current_mode_update`) and
 *   refuses the task when that mode turns the host's own approvals off (a bypass mode), or is
 *   not in the user's `allowedModes` when they set some.
 * - Startup limit: `initialize` and `session/new` must finish within `startupTimeoutMs`
 *   (default 60 s), and an abort during startup ends the agent process.
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

/**
 * Session mode ids, from public adapter sources, that turn a harness's own approvals off. soot
 * refuses to run a task in them (it never switches modes itself, so the user must). ADR-047.
 */
export const KNOWN_BYPASS_MODES: readonly string[] = [
  'bypassPermissions',
  'agent-full-access',
  'full-access',
];

/** Rules for the agent's reported session mode. */
export interface AcpModePolicy {
  /** Modes that turn the host's approvals off: the task is refused. */
  readonly bypassModes: readonly string[];
  /** Modes in which the host may approve some actions itself (by the user's own setting). */
  readonly selfApprovingModes?: readonly string[];
  /** When set, the reported mode must be one of these (an unreported mode is refused too). */
  readonly allowedModes?: readonly string[];
}

export const DEFAULT_MODE_POLICY: AcpModePolicy = { bypassModes: KNOWN_BYPASS_MODES };

/** `null` when the mode may run; otherwise why soot refuses it. Exported for tests. */
export function modeRefusal(mode: string | null, policy: AcpModePolicy): string | null {
  if (mode !== null && policy.bypassModes.includes(mode)) {
    return `the agent's session mode is "${mode}", which turns the harness's own approvals off`;
  }
  if (policy.allowedModes !== undefined && policy.allowedModes.length > 0) {
    if (mode === null) {
      return `the agent reports no session mode, and allowedModes (${policy.allowedModes.join(', ')}) is set`;
    }
    if (!policy.allowedModes.includes(mode)) {
      return `the agent's session mode "${mode}" is not in allowedModes (${policy.allowedModes.join(', ')})`;
    }
  }
  return null;
}

/** The mode a new session reports: `modes.currentModeId`, else a `mode`-category select option. */
export function reportedMode(res: acp.NewSessionResponse): string | null {
  if (res.modes?.currentModeId !== undefined) return res.modes.currentModeId;
  const opt = (res.configOptions ?? []).find((o) => o.category === 'mode' && o.type === 'select');
  return opt?.type === 'select' ? opt.currentValue : null;
}

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
  /**
   * User-provided map from soot model refs to the agent's model option values (for agents whose
   * values are aliases). Used before the exact / bare-id match. ADR-047.
   */
  readonly modelMap?: Readonly<Record<string, string>>;
  /** Session mode rules. Default: refuse the known bypass modes. */
  readonly modePolicy?: AcpModePolicy;
  /** Limit for `initialize` + `session/new`. Default 60000 ms. */
  readonly startupTimeoutMs?: number;
  /** Sentence appended when the agent needs sign-in. Default: a generic "sign in yourself". */
  readonly signInHint?: string;
  /** Who the agent is, for summaries (e.g. "claude-code profile"). Default "ACP agent". */
  readonly agentKind?: string;
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
  /** Session mode the agent reported (last seen), or `null`. */
  mode: string | null;
  /** The reported mode is refused (bypass, or not allowed): the task is refused. */
  modeRefused: string | null;
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

type Outcome =
  | { kind: 'stopped'; stopReason: acp.StopReason; agent: string | null }
  | { kind: 'auth-required'; agent: string | null }
  | { kind: 'mode-refused'; agent: string | null };

/** ACP `auth_required` (-32000): the user is not signed in to the harness. */
function isAuthRequired(error: unknown): boolean {
  return error instanceof acp.RequestError && error.code === -32000;
}

class AcpStartupTimeout extends Error {
  constructor(readonly ms: number) {
    super(`ACP agent did not start within ${String(ms)} ms`);
  }
}

interface StartupGuard {
  within<T>(p: Promise<T>): Promise<T>;
  done(): void;
}

/** Bounds `initialize` + `session/new`; an abort during startup rejects too. */
function startupGuard(ms: number, signal: AbortSignal): StartupGuard {
  let fail: ((e: Error) => void) | null = null;
  const stop = new Promise<never>((_, reject) => {
    fail = reject;
  });
  stop.catch(() => undefined);
  const timer = setTimeout(() => fail?.(new AcpStartupTimeout(ms)), ms);
  const onAbort = () => fail?.(new Error('aborted during startup'));
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  let finished = false;
  return {
    within: (p) => {
      if (finished) return p;
      p.catch(() => undefined);
      return Promise.race([p, stop]);
    },
    done: () => {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
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
      mode: null,
      modeRefused: null,
    };
    const policy = this.#o.modePolicy ?? DEFAULT_MODE_POLICY;
    const seeMode = (mode: string | null) => {
      state.mode = mode;
      state.modeRefused ??= modeRefusal(mode, policy);
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
        } else if (u.sessionUpdate === 'current_mode_update') {
          seeMode(u.currentModeId);
        } else if (u.sessionUpdate === 'config_option_update') {
          const opt = u.configOptions.find((o) => o.category === 'mode' && o.type === 'select');
          if (opt?.type === 'select') seeMode(opt.currentValue);
        }
      });

    const endpoint = await this.#o.connect(root);
    try {
      const outcome = await app.connectWith(endpoint.target, (ctx) =>
        this.#attempt(ctx, input, root, state, signal, seeMode),
      );
      if (outcome.kind === 'aborted') throw new AcpAbortError(task.id);
      return this.#result(input, state, outcome, endpoint, performance.now() - started);
    } catch (error) {
      if (error instanceof AcpAbortError || aborted()) {
        throw new AcpAbortError(task.id);
      }
      const diag = endpoint.diagnostics?.() ?? '';
      if (error instanceof AcpStartupTimeout) {
        throw new Error(
          `${this.#kind()} (${endpoint.label}) did not start a session for "${task.id}" within ${String(error.ms)} ms (it may be waiting for a sign-in; soot never signs in, sign in to the harness yourself)${diag === '' ? '' : ` | stderr: ${clean(diag, 300)}`}`,
          { cause: error },
        );
      }
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
    seeMode: (mode: string | null) => void,
  ): Promise<Outcome | { kind: 'aborted' }> {
    const startup = startupGuard(this.#o.startupTimeoutMs ?? 60_000, signal);
    try {
      return await this.#session(ctx, input, root, state, signal, seeMode, startup);
    } finally {
      startup.done();
    }
  }

  async #session(
    ctx: acp.ClientContext,
    input: AgentTaskInput,
    root: string,
    state: AttemptState,
    signal: AbortSignal,
    seeMode: (mode: string | null) => void,
    startup: StartupGuard,
  ): Promise<Outcome | { kind: 'aborted' }> {
    const init = await startup.within(
      ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { ...ACP_CLIENT_INFO },
      }),
    );
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(
        `agent speaks ACP protocol ${String(init.protocolVersion)}; soot supports ${String(acp.PROTOCOL_VERSION)}`,
      );
    }
    const agent = init.agentInfo?.name ?? null;
    let session: acp.ActiveSession;
    try {
      session = await startup.within(ctx.buildSession({ cwd: root, mcpServers: [] }).start());
    } catch (error) {
      // soot never authenticates or offers a login: the user signs in to their harness.
      if (isAuthRequired(error)) return { kind: 'auth-required', agent };
      throw error;
    }
    startup.done();
    // soot never changes the mode; a bypass (or not allowed) mode refuses the task up front.
    seeMode(reportedMode(session.newSessionResponse));
    if (state.modeRefused !== null) {
      session.dispose();
      return { kind: 'mode-refused', agent };
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
      if (state.refused !== null || state.modeRefused !== null) cancel();
    }, 20);
    try {
      if (signal.aborted) cancel();
      let response: acp.PromptResponse | null;
      try {
        response = await Promise.race([prompt, gaveUp]);
      } catch (error) {
        // Some adapters only find out at the first prompt that nobody is signed in.
        if (isAuthRequired(error) && !signal.aborted) return { kind: 'auth-required', agent };
        throw error;
      }
      if (signal.aborted) return { kind: 'aborted' };
      // Read through a function: callbacks may have set it since the check above.
      const modeRefused = (): string | null => state.modeRefused;
      if (modeRefused() !== null) return { kind: 'mode-refused', agent };
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
    const mapped = this.#o.modelMap?.[routed];
    if (model === undefined) {
      return notApplied(
        `route not applied: the agent does not advertise a "model" config option, so it picks its own model (routed ${routed})`,
      );
    }
    const values = selectValues(model);
    if (mapped !== undefined && !values.includes(mapped)) {
      return notApplied(
        `route not applied: your modelMap sends ${routed} to "${mapped}", which the agent's model option "${model.id}" does not offer (offered: ${values.slice(0, 10).join(', ') || 'none'})`,
      );
    }
    const value = mapped ?? matchModelValue(routed, values);
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

  #kind(): string {
    return clean(this.#o.agentKind ?? 'ACP agent', 60);
  }

  #result(
    input: AgentTaskInput,
    state: AttemptState,
    outcome: Outcome,
    endpoint: AcpEndpoint,
    durationMs: number,
  ): AgentResult {
    const who = `${this.#kind()} (${clean(endpoint.label, 80)}${outcome.agent === null ? '' : `, reports itself as "${clean(outcome.agent, 60)}"`})`;
    let status: AgentResult['status'];
    let summary: string;
    if (outcome.kind === 'auth-required') {
      status = 'blocked';
      summary = `${who} requires authentication. soot never signs in for you; ${this.#o.signInHint ?? 'sign in to the harness yourself.'}`;
    } else if (outcome.kind === 'mode-refused' || state.modeRefused !== null) {
      status = 'blocked';
      summary = `${who}: ${state.modeRefused ?? 'session mode refused'}, so the task is refused. soot never changes the mode; switch the harness to a mode that asks before acting yourself.`;
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
        ...(state.mode === null
          ? []
          : [
              {
                kind: 'decision' as const,
                message: clean(
                  `ACP session mode: ${state.mode}${(this.#o.modePolicy?.selfApprovingModes ?? []).includes(state.mode) ? ' (in this mode the harness may approve some actions itself, by your own setting; soot still diffs the worktree and runs its checks)' : ''}`,
                  400,
                ),
              },
            ]),
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
