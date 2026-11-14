/*
 * Harness integration status, stated plainly. soot may later launch a user's already
 * installed and signed-in harness CLI (ADR-015): never bundling a proprietary SDK, never
 * offering a login, never bypassing the host's approvals, never branding as the vendor's
 * product. The generic ACP driver (ADR-027) is how such a harness connects. Claude Code and
 * Codex have runner profiles over it (ADR-047, `--agent claude-code` / `--agent codex`), tested
 * against simulated adapters only: no real harness has been run, so none is verified.
 */

export interface HarnessSupport {
  readonly id: string;
  /** How the harness can reach soot today. */
  readonly surfaces: readonly ('skill' | 'mcp' | 'cli')[];
  /**
   * Whether soot can run tasks *through* this harness. `acp-profile-simulated`: a runner exists
   * over the generic ACP driver and is tested against simulated agents only (not a real run).
   */
  readonly runner: 'not-implemented' | 'acp-profile-simulated';
  /** Verified end to end inside the product. Only set after a recorded run. */
  readonly verifiedEndToEnd: false;
  readonly note: string;
}

export const HARNESS_SUPPORT: readonly HarnessSupport[] = [
  {
    id: 'claude-code',
    surfaces: ['skill', 'mcp', 'cli'],
    runner: 'acp-profile-simulated',
    verifiedEndToEnd: false,
    note: 'Skill path .claude/skills, the MCP server and an ACP runner profile (--agent claude-code) exist; the runner is tested against a simulated adapter only, never run with Claude Code (M6-04).',
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
