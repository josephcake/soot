import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_SUPPORT,
  IMPLEMENTATION_STATUS,
  PACKAGE_NAME,
  PLANNED_MILESTONE,
  harnessRunnerStatus,
} from './index.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
};

describe('@soot/harness-adapters', () => {
  it('exports the name declared in package.json', () => {
    expect(PACKAGE_NAME).toBe(manifest.name);
  });

  it('reports partial status: MCP server yes, harness runners no', () => {
    expect(IMPLEMENTATION_STATUS).toBe('partial');
    expect(PLANNED_MILESTONE).toBe(6);
  });

  it('claims only Claude Code as verified end to end, and only with its recorded run', () => {
    expect(HARNESS_SUPPORT.map((h) => [h.id, h.verifiedEndToEnd, h.runner])).toEqual([
      ['claude-code', true, 'acp-profile-verified'],
      ['codex', false, 'acp-profile-simulated'],
      ['grok', false, 'not-implemented'],
    ]);
    // A verified entry must name the run behind it; unverified ones must not pretend to.
    for (const h of HARNESS_SUPPORT) expect(h.verifiedRun !== undefined).toBe(h.verifiedEndToEnd);
    expect(harnessRunnerStatus('claude-code')).toBe(
      'verified in one recorded real run (macOS, claude-agent-acp 0.107.0, 2026-11-16)',
    );
    expect(harnessRunnerStatus('codex')).toBe('tested against simulated adapters only');
    expect(harnessRunnerStatus('grok')).toBe('tested against simulated adapters only');
  });
});
