import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMPLEMENTATION_STATUS, PACKAGE_NAME, PLANNED_MILESTONE } from './index.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
};

describe('@soot/observability package', () => {
  it('exports the name declared in package.json', () => {
    expect(PACKAGE_NAME).toBe(manifest.name);
  });

  it('reports its Milestone 1 implementation status', () => {
    expect(IMPLEMENTATION_STATUS).toBe('partial');
    expect(PLANNED_MILESTONE).toBe(1);
  });
});
