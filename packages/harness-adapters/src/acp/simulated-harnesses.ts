import type { MockAcpScript, MockAcpStep } from './mock-agent.js';
import type { HarnessId } from './harness-profiles.js';

/*
 * TEST DOUBLES. Scripts for soot's mock ACP agent that imitate the ACP interface of each
 * harness's adapter, so the Claude Code and Codex runners can be tested without any vendor
 * binary. They call no model and make no request. Mode ids follow the adapters' public sources
 * (ADR-047); agent names, model values and permission option ids are illustrative only. Never
 * present their output as real harness work.
 */

export interface SimulatedHarnessOptions {
  readonly tasks?: Record<string, MockAcpStep>;
  readonly default?: MockAcpStep;
  /** Mode the simulated adapter starts in (default: its asking mode). */
  readonly mode?: string;
  readonly requireAuth?: boolean;
  readonly requireAuthAtPrompt?: boolean;
  readonly hangOnInitialize?: boolean;
  /** Model behaviour for `session/set_config_option`. */
  readonly modelBehaviour?: 'apply' | 'refuse' | 'ignore';
}

const SHAPES: Record<
  HarnessId,
  {
    agentName: string;
    modes: string[];
    askingMode: string;
    models: { current: string; values: string[] };
    permissionOptions: NonNullable<MockAcpScript['permissionOptions']>;
  }
> = {
  'claude-code': {
    agentName: 'simulated-claude-code-adapter (test double)',
    modes: ['auto', 'default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan'],
    askingMode: 'default',
    models: { current: 'default', values: ['default', 'sonnet', 'opus', 'haiku'] },
    permissionOptions: [
      { optionId: 'allow_always', name: 'Always Allow', kind: 'allow_always' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  },
  codex: {
    agentName: 'simulated-codex-adapter (test double)',
    modes: ['read-only', 'workspace-write', 'agent', 'agent-full-access'],
    askingMode: 'read-only',
    models: { current: 'gpt-5-codex', values: ['gpt-5-codex', 'gpt-5-codex-mini'] },
    permissionOptions: [
      { optionId: 'approved-for-session', name: 'Always', kind: 'allow_always' },
      { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
      { optionId: 'abort', name: 'No', kind: 'reject_once' },
    ],
  },
};

/** A mock ACP agent script shaped like the given harness's ACP adapter. */
export function simulatedHarnessScript(
  id: HarnessId,
  o: SimulatedHarnessOptions = {},
): MockAcpScript {
  const shape = SHAPES[id];
  return {
    version: 1,
    label: `simulated ${id} adapter (test double)`,
    agentName: shape.agentName,
    modes: { current: o.mode ?? shape.askingMode, available: shape.modes, via: 'both' },
    models: { ...shape.models, behaviour: o.modelBehaviour ?? 'apply' },
    permissionOptions: shape.permissionOptions,
    tasks: o.tasks ?? {},
    ...(o.default === undefined ? {} : { default: o.default }),
    ...(o.requireAuth === true ? { requireAuth: true } : {}),
    ...(o.requireAuthAtPrompt === true ? { requireAuthAtPrompt: true } : {}),
    ...(o.hangOnInitialize === true ? { hangOnInitialize: true } : {}),
  };
}
