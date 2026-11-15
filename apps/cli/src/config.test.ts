import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
      retryCheckOutputBytes: 4096,
      retryDiffBytes: 8192,
    });
    expect(cfg.policy).toEqual({ allowedExecutables: [] });
  });

  it('sandbox (ADR-051): defaults to auto, no network, not required; validates paths', () => {
    const cfg = loadProjectConfig(file('s.json', { version: 1 }));
    expect(cfg.sandbox).toEqual({
      mode: 'auto',
      network: false,
      readPaths: [],
      writePaths: [],
      required: false,
    });
    const set = loadProjectConfig(
      file('t.json', {
        version: 1,
        sandbox: {
          mode: 'bwrap',
          network: true,
          readPaths: ['/opt/tools'],
          writePaths: ['/var/cache/soot-build'],
          required: true,
          bwrapPath: '/usr/local/bin/bwrap',
        },
      }),
    );
    expect(set.sandbox).toEqual({
      mode: 'bwrap',
      network: true,
      readPaths: ['/opt/tools'],
      writePaths: ['/var/cache/soot-build'],
      required: true,
      bwrapPath: '/usr/local/bin/bwrap',
    });
    const bad = (sandbox: unknown) => () =>
      loadProjectConfig(file('u.json', { version: 1, sandbox }));
    expect(bad({ mode: 'firejail' })).toThrow(/sandbox\.mode/);
    expect(bad({ readPaths: ['rel'] })).toThrow(/sandbox\.readPaths\.0: must be an absolute path/);
    expect(bad({ writePaths: ['/a/../b'] })).toThrow(/must not contain/);
    expect(bad({ writePaths: [join(homedir(), '.ssh')] })).toThrow(/dotfile/);
    expect(bad({ writePaths: [homedir()] })).toThrow(/home directory/);
    expect(bad({ mode: 'none', required: true })).toThrow(/cannot be combined/);
    expect(bad({ allowAll: true })).toThrow(/Unrecognized key/);
  });

  it('retryCheckOutputBytes: 0 turns retry check output off; more than 16384 is refused', () => {
    expect(
      loadProjectConfig(file('r0.json', { version: 1, retryCheckOutputBytes: 0 })).config
        .retryCheckOutputBytes,
    ).toBe(0);
    expect(() =>
      loadProjectConfig(file('r1.json', { version: 1, retryCheckOutputBytes: 16_385 })),
    ).toThrow(/retryCheckOutputBytes/);
    expect(() =>
      loadProjectConfig(file('r2.json', { version: 1, retryCheckOutputBytes: -1 })),
    ).toThrow(/retryCheckOutputBytes/);
  });

  it('retryDiffBytes: 0 turns the retry diff off; more than 32768 is refused', () => {
    expect(
      loadProjectConfig(file('d0.json', { version: 1, retryDiffBytes: 0 })).config.retryDiffBytes,
    ).toBe(0);
    expect(() =>
      loadProjectConfig(file('d1.json', { version: 1, retryDiffBytes: 32_769 })),
    ).toThrow(/retryDiffBytes/);
    expect(() => loadProjectConfig(file('d2.json', { version: 1, retryDiffBytes: 1.5 }))).toThrow(
      /retryDiffBytes/,
    );
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

describe('soot.config.json "decomposer" (ADR-034)', () => {
  it('is optional, takes a registry model reference, and is strict', () => {
    expect(
      loadProjectConfig(file('e.json', { version: 1, models: 'm' })).config.decomposer,
    ).toBeUndefined();
    expect(
      loadProjectConfig(
        file('f.json', { version: 1, models: 'm', decomposer: { model: 'local/qwen3:8b' } }),
      ).config.decomposer,
    ).toEqual({ model: 'local/qwen3:8b' });
    expect(() =>
      loadProjectConfig(file('g.json', { version: 1, models: 'm', decomposer: { model: 'x' } })),
    ).toThrow(/decomposer\.model: must be "auto" or a model reference/);
    expect(
      loadProjectConfig(file('i.json', { version: 1, models: 'm', decomposer: { model: 'auto' } }))
        .config.decomposer,
    ).toEqual({ model: 'auto' });
    expect(() =>
      loadProjectConfig(
        file('h.json', {
          version: 1,
          models: 'm',
          decomposer: { model: 'a/b', apiKey: 'sk-nope' },
        }),
      ),
    ).toThrow(/Unrecognized key.*apiKey/);
  });
});

describe('soot.config.json models and autoModels (ADR-043)', () => {
  it('makes the models file optional and turns the auto pool on by default', () => {
    const none = loadProjectConfig(file('j.json', { version: 1 }));
    expect(none.modelsPath).toBeNull();
    expect(none.config.autoModels).toBe(true);
    const off = loadProjectConfig(file('k.json', { version: 1, models: 'm', autoModels: false }));
    expect(off.config.autoModels).toBe(false);
    expect(() => loadProjectConfig(file('l.json', { version: 1, autoModels: 'yes' }))).toThrow(
      /autoModels/,
    );
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
