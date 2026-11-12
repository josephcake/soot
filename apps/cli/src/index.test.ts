import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEPENDS_ON, IMPLEMENTATION_STATUS, PACKAGE_NAME, PLANNED_MILESTONE } from './index.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
};

describe('@soot/cli stub', () => {
  it('exports the name declared in package.json', () => {
    expect(PACKAGE_NAME).toBe(manifest.name);
  });

  it('honestly reports that it is not implemented yet', () => {
    expect(IMPLEMENTATION_STATUS).toBe('stub');
    expect(PLANNED_MILESTONE).toBe(6);
  });

  it('links to @soot/core through the workspace', () => {
    expect(DEPENDS_ON).toEqual(['@soot/core']);
  });
});
