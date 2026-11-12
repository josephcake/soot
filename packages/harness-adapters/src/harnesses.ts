/*
 * Harness integration status, stated plainly. soot may later launch a user's already
 * installed and signed-in harness CLI (ADR-015): never bundling a proprietary SDK, never
 * offering a login, never bypassing the host's approvals, never branding as the vendor's
 * product. The generic ACP driver (ADR-027) is how such a harness would connect; it has been
 * run only against soot's own mock ACP agent, so nothing here launches or claims a harness.
 */

export interface HarnessSupport {
  readonly id: string;
  /** How the harness can reach soot today. */
  readonly surfaces: readonly ('skill' | 'mcp' | 'cli')[];
  /** Whether soot can run tasks *through* this harness (ACP or its CLI). */
  readonly runner: 'not-implemented';
  /** Verified end to end inside the product. Only set after a recorded run. */
  readonly verifiedEndToEnd: false;
  readonly note: string;
}

export const HARNESS_SUPPORT: readonly HarnessSupport[] = [
  {
    id: 'claude-code',
    surfaces: ['skill', 'mcp', 'cli'],
    runner: 'not-implemented',
    verifiedEndToEnd: false,
    note: 'Skill path .claude/skills and the MCP server exist; not verified inside Claude Code (M6-04).',
  },
  {
    id: 'codex',
    surfaces: ['skill', 'mcp', 'cli'],
    runner: 'not-implemented',
    verifiedEndToEnd: false,
    note: 'Skill path .agents/skills and the MCP server exist; not verified inside Codex (M6-05).',
  },
  {
    id: 'grok',
    surfaces: ['skill', 'cli'],
    runner: 'not-implemented',
    verifiedEndToEnd: false,
    note: 'Skill path .grok/skills exists; not verified inside Grok Build.',
  },
];
