/*
 * Harness integration status, stated plainly. soot may later launch a user's already
 * installed and signed-in harness CLI (ADR-015): never bundling a proprietary SDK, never
 * offering a login, never bypassing the host's approvals, never branding as the vendor's
 * product. The generic ACP driver (ADR-027) is how such a harness connects. Claude Code and
 * Codex have runner profiles over it (ADR-047, `--agent claude-code` / `--agent codex`). The
 * Claude Code runner has one recorded real run (ADR-047 amendment, M6-04 Verified); Codex is
 * tested against simulated adapters only.
 */

export interface HarnessSupport {
  readonly id: string;
  /** How the harness can reach soot today. */
  readonly surfaces: readonly ('skill' | 'mcp' | 'cli')[];
  /**
   * Whether soot can run tasks *through* this harness. `acp-profile-simulated`: a runner exists
   * over the generic ACP driver and is tested against simulated agents only (not a real run).
   * `acp-profile-verified`: the same runner, with a recorded run against the real adapter.
   */
  readonly runner: 'not-implemented' | 'acp-profile-simulated' | 'acp-profile-verified';
  /** Verified end to end inside the product. Only set after a recorded run. */
  readonly verifiedEndToEnd: boolean;
  /** The recorded run behind `verifiedEndToEnd`: where, with what, when. */
  readonly verifiedRun?: string;
  readonly note: string;
}

export const HARNESS_SUPPORT: readonly HarnessSupport[] = [
  {
    id: 'claude-code',
    surfaces: ['skill', 'mcp', 'cli'],
    runner: 'acp-profile-verified',
    verifiedEndToEnd: true,
    verifiedRun: 'macOS, claude-agent-acp 0.107.0, 2026-11-16',
    note: 'Skill path .claude/skills, the MCP server and an ACP runner profile (--agent claude-code). The runner was verified in one recorded run with the real adapter (M6-04, ADR-047 amendment): two tasks done by Claude Code, every edit approved by the person in soot, soot checks passed under sandbox-exec. The skill and MCP server were used inside Claude Code once: asked explicitly, it called soot_run with the prompt verbatim (mock agent); unasked, it did the work itself.',
  },
  {
    id: 'codex',
    surfaces: ['skill', 'mcp', 'cli'],
    runner: 'acp-profile-simulated',
    verifiedEndToEnd: false,
    note: 'Skill path .agents/skills, the MCP server and an ACP runner profile (--agent codex) exist; the runner is tested against a simulated adapter only, never run with Codex (M6-05).',
  },
  {
    id: 'grok',
    surfaces: ['skill', 'cli'],
    runner: 'not-implemented',
    verifiedEndToEnd: false,
    note: 'Skill path .grok/skills exists; not verified inside Grok Build.',
  },
];

/** How far a harness runner is verified, for labels: one recorded real run, or simulated only. */
export function harnessRunnerStatus(id: string): string {
  const h = HARNESS_SUPPORT.find((x) => x.id === id);
  return h?.runner === 'acp-profile-verified' && h.verifiedRun !== undefined
    ? `verified in one recorded real run (${h.verifiedRun})`
    : 'tested against simulated adapters only';
}
