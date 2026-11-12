import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMPLEMENTATION_STATUS, PACKAGE_NAME, PLANNED_MILESTONE, VERSION } from './index.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
  bin: Record<string, string>;
};

describe('@soot/cli', () => {
  it('exports the name and version declared in package.json', () => {
    expect(PACKAGE_NAME).toBe(manifest.name);
    expect(VERSION).toBe(manifest.version);
  });

  it('declares the `soot` binary and reports partial status', () => {
    expect(manifest.bin).toEqual({ soot: './dist/bin.js' });
    expect(IMPLEMENTATION_STATUS).toBe('partial');
    expect(PLANNED_MILESTONE).toBe(6);
  });
});
