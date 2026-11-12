/**
 * Credential boundary guard (M2-08, ADR-022): provider keys are read in exactly one place,
 * the adapter layer of @soot/provider-adapters. Every other production source must not touch
 * key variables. A structural check, so a new code path cannot quietly start reading keys.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const ALLOWED_KEY_READERS = new Set([
  'packages/provider-adapters/src/adapters.ts',
  'packages/provider-adapters/src/discovery.ts',
]);

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...productionSources(path));
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.|test-fixtures\./.test(name))
      out.push(path);
  }
  return out;
}

const files = ['packages', 'apps']
  .flatMap((d) => productionSources(join(ROOT, d)))
  .map((p) => ({
    rel: relative(ROOT, p),
    code: readFileSync(p, 'utf8'),
  }));

describe('credential boundary', () => {
  it('scans the production sources', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('only the adapter layer reads provider keys from the environment', () => {
    const readers = files
      .filter((f) => /\[\s*provider\.apiKeyEnv\s*\]|readApiKey\(/.test(f.code))
      .map((f) => f.rel)
      .filter((rel) => rel !== 'packages/provider-adapters/src/index.ts');
    expect(new Set(readers)).toEqual(ALLOWED_KEY_READERS);
  });

  it('no production code reads a key variable by name', () => {
    const offenders = files.filter((f) =>
      /process\.env(\.[A-Z0-9_]*(_API_KEY|_TOKEN|_SECRET)\b|\[\s*['"`][A-Z0-9_]*(_API_KEY|_TOKEN|_SECRET)['"`]\s*\])/.test(
        f.code,
      ),
    );
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });
});
