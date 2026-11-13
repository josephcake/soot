import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allowProject,
  allowlistPath,
  disallowProject,
  projectId,
  readAllowlist,
  resolveProject,
} from './dashboard-allowlist.js';

/* The dashboard's folder allowlist (ADR-038): written by the CLI only, resolved by opaque id. */

const CONFIG = JSON.stringify({ version: 1, models: 'models.json', checks: [] });
let top = '';
afterEach(() => {
  if (top !== '') rmSync(top, { recursive: true, force: true });
  top = '';
});

function setup() {
  top = realpathSync(mkdtempSync(join(tmpdir(), 'soot-allow-')));
  const data = join(top, 'data');
  const proj = join(top, 'proj');
  mkdirSync(proj);
  writeFileSync(join(proj, 'soot.config.json'), CONFIG);
  return { data, proj };
}

describe('dashboard allowlist', () => {
  it('allow stores the real path in <dataDir>/dashboard.json with mode 0600, once', () => {
    const { data, proj } = setup();
    const e = allowProject(data, top, 'proj');
    expect(e.path).toBe(proj);
    expect(e.label).toBe('proj');
    allowProject(data, top, proj);
    expect(readAllowlist(data)).toHaveLength(1);
    expect(statSync(allowlistPath(data)).mode & 0o777).toBe(0o600);
    expect(resolveProject(data, projectId(proj))?.path).toBe(proj);
  });

  it('refuses folders that are missing, are files, or have no loadable soot.config.json', () => {
    const { data } = setup();
    expect(() => allowProject(data, top, 'nope')).toThrow(/not a folder/);
    writeFileSync(join(top, 'file'), 'x');
    expect(() => allowProject(data, top, 'file')).toThrow(/not a folder/);
    mkdirSync(join(top, 'bare'));
    expect(() => allowProject(data, top, 'bare')).toThrow(/no soot.config.json/);
    mkdirSync(join(top, 'broken'));
    writeFileSync(join(top, 'broken', 'soot.config.json'), '{"version": 2}');
    expect(() => allowProject(data, top, 'broken')).toThrow();
    expect(readAllowlist(data)).toEqual([]);
  });

  it('resolves ids only: paths, traversal and unknown ids are null', () => {
    const { data, proj } = setup();
    allowProject(data, top, proj);
    for (const id of [
      proj,
      '../proj',
      '/etc',
      'p_../../etc',
      `${projectId(proj)}/..`,
      'p_ffffffffffffffff',
      '',
    ])
      expect(resolveProject(data, id), id).toBeNull();
  });

  it('a folder swapped for a symlink after allow is refused', () => {
    const { data, proj } = setup();
    const id = projectId(allowProject(data, top, proj).path);
    const elsewhere = join(top, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(proj, { recursive: true });
    symlinkSync(elsewhere, proj);
    expect(resolveProject(data, id)).toBeNull();
  });

  it('disallow removes by path or id', () => {
    const { data, proj } = setup();
    allowProject(data, top, proj);
    expect(disallowProject(data, top, projectId(proj))).toBe(true);
    expect(disallowProject(data, top, proj)).toBe(false);
    allowProject(data, top, proj);
    expect(disallowProject(data, top, 'proj')).toBe(true);
    expect(readAllowlist(data)).toEqual([]);
  });

  it('a tampered file is an error, not an empty list', () => {
    const { data } = setup();
    mkdirSync(data, { recursive: true });
    writeFileSync(allowlistPath(data), '{"version":1,"projects":[{"path":"/x"}]}');
    expect(() => readAllowlist(data)).toThrow(/not a soot dashboard allowlist/);
  });
});
