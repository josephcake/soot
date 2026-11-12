import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_SUPPORT,
  IMPLEMENTATION_STATUS,
  PACKAGE_NAME,
  PLANNED_MILESTONE,
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

  it('claims no harness as verified end to end', () => {
    expect(HARNESS_SUPPORT.map((h) => [h.id, h.verifiedEndToEnd, h.runner])).toEqual([
      ['claude-code', false, 'not-implemented'],
      ['codex', false, 'not-implemented'],
      ['grok', false, 'not-implemented'],
    ]);
  });
});
