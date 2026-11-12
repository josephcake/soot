import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, PACKAGE_VERSION } from './index.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

describe('@intelligent-agent-router/core package metadata', () => {
  it('matches package.json', () => {
    expect(PACKAGE_NAME).toBe('@intelligent-agent-router/core');
    expect(PACKAGE_NAME).toBe(manifest.name);
    expect(PACKAGE_VERSION).toBe(manifest.version);
  });

  it('uses a semver version', () => {
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
