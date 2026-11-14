import type { ApprovalGate } from '@soot/agent-runtime';
import { isAbsolute } from 'node:path';
import {
  AcpAgentRunner,
  KNOWN_BYPASS_MODES,
  type AcpAgentRunnerOptions,
  type AcpConnector,
  type AcpModePolicy,
} from './runner.js';
import { describeCommand, spawnAcpAgent, type AcpAgentCommand } from './spawn.js';

/*
 * Harness runners for Claude Code (M6-04) and Codex (M6-05), ADR-047. Each one is a small
 * profile over the generic ACP driver (ADR-027): the user installs and signs in to the
 * harness's ACP adapter themselves and names its command in soot.config.json. soot spawns only
 * that command (no PATH search by soot, no shell), never signs in, never changes the session
 * mode, and refuses modes that turn the harness's own approvals off. Approvals go through
 * soot's gate exactly as for `--agent acp` (allow once; deny or unattended rejects).
 *
 * Status: implemented and tested against simulated agents only (scripted fakes in this repo).
 * No vendor binary has been run; nothing here claims real Claude Code or Codex support.
 */

export const HARNESS_IDS = ['claude-code', 'codex'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export interface HarnessProfile {
  readonly id: HarnessId;
  /** The harness's name, used only to say which harness the user must act in. */
  readonly harness: string;
  /**
   * Session mode ids (public adapter sources, see ADR-047) that turn the harness's own
   * approvals off. soot refuses a task in them; on top of soot's generic bypass list.
   */
  readonly bypassModes: readonly string[];
  /** Mode ids in which the harness may approve some actions itself, by the user's setting. */
  readonly selfApprovingModes: readonly string[];
  /** Appended to "soot never signs in for you;" when the adapter needs sign-in. */
  readonly signInHint: string;
}

export const HARNESS_PROFILES: Readonly<Record<HarnessId, HarnessProfile>> = {
  'claude-code': {
    id: 'claude-code',
    harness: 'Claude Code',
    // claude-agent-acp src/session-mode.ts: auto, default, acceptEdits, bypassPermissions,
    // dontAsk, plan.
    bypassModes: ['bypassPermissions'],
    selfApprovingModes: ['auto', 'acceptEdits'],
    signInHint:
      'sign in to Claude Code yourself (with its own login, outside soot), then run the task again.',
  },
  codex: {
    id: 'codex',
    harness: 'Codex',
    // codex-acp src/AgentMode.ts: read-only, workspace-write, agent (auto review),
    // agent-full-access (approval policy "never", danger-full-access sandbox).
    bypassModes: ['agent-full-access', 'full-access'],
    selfApprovingModes: ['agent', 'workspace-write', 'auto'],
    signInHint:
      'sign in to Codex yourself (with its own login, outside soot), then run the task again.',
  },
};

/** User configuration for one harness runner (`harnesses.<id>` in soot.config.json). */
export interface HarnessAgentConfig extends AcpAgentCommand {
  /** soot model ref → the adapter's model option value (e.g. an alias). */
  readonly models?: Readonly<Record<string, string>> | undefined;
  /** When set, the session mode the adapter reports must be one of these. */
  readonly allowedModes?: readonly string[] | undefined;
  /** Limit for the adapter to start a session. Default 60000 ms. */
  readonly startupTimeoutMs?: number | undefined;
  /** How long to wait after `session/cancel`. Default 2000 ms. */
  readonly cancelGraceMs?: number | undefined;
}

/**
 * Arguments soot refuses to pass to any agent command: flags and values that skip or bypass
 * the harness's approvals or sandbox. Returns the offending argument, or `null`.
 */
export function forbiddenAgentArg(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const lower = a.toLowerCase();
    const next = (args[i + 1] ?? '').toLowerCase();
    if (
      lower.startsWith('--dangerously') ||
      lower.startsWith('--allow-dangerously') ||
      lower === '--yolo' ||
      lower === '--full-auto' ||
      lower.includes('bypasspermissions') ||
      lower.includes('danger-full-access') ||
      lower.includes('agent-full-access') ||
      /approval[_-]?policy\s*=\s*"?never/.test(lower) ||
      /^--ask-for-approval=never$/.test(lower) ||
      ((lower === '--ask-for-approval' || lower === '-a') && next === 'never')
    ) {
      return a;
    }
  }
  return null;
}

export interface HarnessRunnerOptions {
  readonly approvals: ApprovalGate['mode'];
  readonly onRoute?: AcpAgentRunnerOptions['onRoute'];
  /** Environment the scrubbed agent env is taken from. */
  readonly env?: NodeJS.ProcessEnv;
  /** Tests: connect to a simulated agent instead of spawning `config.command`. */
  readonly connect?: AcpConnector;
}

export function harnessModePolicy(
  profile: HarnessProfile,
  config: Pick<HarnessAgentConfig, 'allowedModes'>,
): AcpModePolicy {
  return {
    bypassModes: [...new Set([...KNOWN_BYPASS_MODES, ...profile.bypassModes])],
    selfApprovingModes: profile.selfApprovingModes,
    ...(config.allowedModes === undefined ? {} : { allowedModes: config.allowedModes }),
  };
}

export function harnessRunnerLabel(id: HarnessId, config: AcpAgentCommand): string {
  return `${id} (your ACP adapter command: ${describeCommand(config)})`;
}

/** An `AgentRunner` for one harness, over the generic ACP driver. */
export function createHarnessRunner(
  id: HarnessId,
  config: HarnessAgentConfig,
  options: HarnessRunnerOptions,
): AcpAgentRunner {
  const profile = HARNESS_PROFILES[id];
  if (options.connect === undefined && !isAbsolute(config.command)) {
    throw new Error(
      `${id}: "command" must be an absolute path to the ACP adapter you installed; soot does not search PATH for it`,
    );
  }
  const bad = forbiddenAgentArg(config.args ?? []);
  if (bad !== null) {
    throw new Error(
      `${id}: argument "${bad}" would skip or bypass the harness's approvals; soot never passes it`,
    );
  }
  return new AcpAgentRunner({
    connect: options.connect ?? spawnAcpAgent(config, options.env ?? process.env),
    approvals: options.approvals,
    agentKind: `${id} runner`,
    modePolicy: harnessModePolicy(profile, config),
    signInHint: profile.signInHint,
    ...(config.models === undefined ? {} : { modelMap: config.models }),
    ...(config.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: config.startupTimeoutMs }),
    ...(config.cancelGraceMs === undefined ? {} : { cancelGraceMs: config.cancelGraceMs }),
    ...(options.onRoute === undefined ? {} : { onRoute: options.onRoute }),
  });
}
