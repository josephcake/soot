import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMockScript, loadProjectConfig } from './index.js';

let dir = '';
afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});
const file = (name: string, value: unknown) => {
  dir ||= mkdtempSync(join(tmpdir(), 'soot-cfg-'));
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
};

describe('soot.config.json', () => {
  it('applies defaults and resolves paths next to the config file', () => {
    const cfg = loadProjectConfig(file('soot.config.json', { version: 1, models: 'models.json' }));
    expect(cfg.modelsPath).toBe(join(dir, 'models.json'));
    expect(cfg.config).toMatchObject({
      policy: 'balanced',
      concurrency: 4,
      checks: [],
      protectedPaths: [],
    });
    expect(cfg.policy).toEqual({ allowedExecutables: [] });
  });

  it('rejects unknown keys, escaping protected paths, unsafe task ids and a missing file', () => {
    expect(() =>
      loadProjectConfig(file('a.json', { version: 1, models: 'm', autoApprove: true })),
    ).toThrow(/Unrecognized key.*autoApprove/);
    expect(() =>
      loadProjectConfig(
        file('b.json', { version: 1, models: 'm', protectedPaths: ['../outside'] }),
      ),
    ).toThrow(/protectedPaths\.0: must be a relative path inside the repository/);
    expect(() =>
      loadProjectConfig(file('c.json', { version: 1, models: 'm', acceptance: { '../x': [] } })),
    ).toThrow(/invalid/);
    expect(() => loadProjectConfig(join(dir, 'missing.json'))).toThrow(/no soot config at/);
    expect(() => loadProjectConfig(file('d.json', '{ nope'))).toThrow(/cannot read/);
  });
});

describe('mock script files', () => {
  it('loads per-task scripts and rejects malformed ones', () => {
    const ok = loadMockScript(
      file('m.json', {
        version: 1,
        tasks: { a: { writes: { 'x.txt': 'y' } }, b: [{ outcome: 'fail' }, {}] },
      }),
    );
    expect(Object.keys(ok.scripts ?? {})).toEqual(['a', 'b']);
    expect(() =>
      loadMockScript(file('n.json', { version: 1, tasks: { a: { outcome: 'win' } } })),
    ).toThrow(/invalid mock script/);
    expect(() => loadMockScript(file('o.json', { version: 2, tasks: {} }))).toThrow(
      /invalid mock script/,
    );
  });
});
