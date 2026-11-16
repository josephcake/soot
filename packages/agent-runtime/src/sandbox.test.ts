import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SANDBOX_SETTINGS,
  buildSandboxPolicy,
  bwrapArgs,
  findProgram,
  gitPathsFor,
  hiddenAncestors,
  protectedWriteReason,
  resolveSandbox,
  sandboxExecArgs,
  seatbeltProfile,
  stripSecretEnv,
  unsandboxed,
  type SandboxHost,
  type SandboxSettings,
} from './sandbox.js';

/*
 * ADR-051 unit tests: policy, protected paths, backend choice, and the bwrap / sandbox-exec
 * argument vectors. None of these need bwrap or sandbox-exec installed.
 */

const dirs: string[] = [];
const temp = (prefix = 'soot-sbx-test-') => {
  // Resolved, as the policy resolves every path (macOS: /var/folders -> /private/var/folders).
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake layout: home, a repo with .git, soot's state dir with one linked worktree. */
function layout() {
  const root = temp();
  const home = join(root, 'home', 'u');
  const repo = join(home, 'code', 'repo');
  const common = join(repo, '.git');
  const dataDir = join(home, '.soot');
  const worktree = join(dataDir, 'worktrees', 'run1', 'task-a');
  const gitDir = join(common, 'worktrees', 'task-a');
  for (const d of [home, repo, common, gitDir, worktree]) mkdirSync(d, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  return { root, home, repo, common, dataDir, worktree };
}

const settings = (s: Partial<SandboxSettings> = {}): SandboxSettings => ({
  ...DEFAULT_SANDBOX_SETTINGS,
  ...s,
});

describe('protected paths (ADR-051)', () => {
  const where = { home: '/home/u', dataDir: '/home/u/.soot' };
  it('refuses root, home and its ancestors, dotfiles, .git, the state dir, relative and ..', () => {
    expect(protectedWriteReason('/', where)).toMatch(/root/);
    expect(protectedWriteReason('/home', where)).toMatch(/home directory/);
    expect(protectedWriteReason('/home/u', where)).toMatch(/home directory/);
    expect(protectedWriteReason('/home/u/.ssh', where)).toMatch(/dotfile/);
    expect(protectedWriteReason('/home/u/.config/x', where)).toMatch(/dotfile/);
    expect(protectedWriteReason('/home/u/code/repo/.git', where)).toMatch(/\.git/);
    expect(protectedWriteReason('/srv/repo/.git/hooks', where)).toMatch(/\.git/);
    expect(protectedWriteReason('/opt/soot', { home: null, dataDir: '/opt/soot/state' })).toMatch(
      /state directory/,
    );
    expect(
      protectedWriteReason('/opt/soot/state/db', { home: null, dataDir: '/opt/soot/state' }),
    ).toMatch(/state directory/);
    expect(protectedWriteReason('relative/dir', where)).toMatch(/absolute/);
    expect(protectedWriteReason('/srv/../home/u', where)).toMatch(/\.\./);
  });
  it('allows ordinary directories', () => {
    expect(protectedWriteReason('/home/u/code/cache', where)).toBeNull();
    expect(protectedWriteReason('/var/cache/build', where)).toBeNull();
  });
});

describe('environment', () => {
  it('strips credential-like names and keeps the rest', () => {
    const env = stripSecretEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      OPENAI_API_KEY: 'sk-x',
      GITHUB_TOKEN: 't',
      AWS_SECRET_ACCESS_KEY: 's',
      DB_PASSWORD: 'p',
      MY_AUTH: 'a',
      SESSION_COOKIE: 'c',
      LANG: 'C',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', LANG: 'C' });
  });
});

describe('policy', () => {
  it('worktree writable, home and state dir hidden, repo and git re-exposed read-only', () => {
    const l = layout();
    const p = buildSandboxPolicy({
      cwd: l.worktree,
      settings: settings(),
      home: l.home,
      dataDir: l.dataDir,
    });
    expect(p.cwd).toBe(l.worktree);
    expect(p.writable).toEqual([l.worktree]);
    // The state dir lies inside home, so hiding home hides both.
    expect(p.hidden).toEqual([l.home]);
    expect(p.readable).toEqual([l.repo, l.common]);
    expect(p.readOnly).toEqual([l.common, join(l.worktree, '.git')]);
    expect(p.network).toBe(false);
  });

  it('reads the git layout of a linked worktree', () => {
    const l = layout();
    expect(gitPathsFor(l.worktree)).toEqual({
      dotGit: join(l.worktree, '.git'),
      commonDir: l.common,
      mainTree: l.repo,
    });
    expect(gitPathsFor(temp())).toEqual({ dotGit: null, commonDir: null, mainTree: null });
  });

  it('re-exposes an executable installed inside home, and configured read/write paths', () => {
    const l = layout();
    const bin = join(l.home, 'tools', 'node', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), '');
    const cache = join(l.root, 'cache');
    const p = buildSandboxPolicy({
      cwd: l.worktree,
      settings: settings({ readPaths: ['/opt/x'], writePaths: [cache], network: true }),
      home: l.home,
      dataDir: l.dataDir,
      executable: join(bin, 'node'),
    });
    expect(p.readable).toContain(join(l.home, 'tools', 'node'));
    expect(p.readable).toContain('/opt/x');
    expect(p.writable).toEqual([l.worktree, cache]);
    expect(p.network).toBe(true);
  });

  it('never re-exposes a whole hidden location for an executable in it', () => {
    const l = layout();
    mkdirSync(join(l.home, 'bin'), { recursive: true });
    writeFileSync(join(l.home, 'bin', 'tool'), '');
    const p = buildSandboxPolicy({
      cwd: l.worktree,
      settings: settings(),
      home: l.home,
      dataDir: l.dataDir,
      executable: join(l.home, 'bin', 'tool'),
    });
    expect(p.readable).toContain(join(l.home, 'bin'));
    expect(p.readable).not.toContain(l.home);
  });

  it('refuses a cwd that is not a task worktree, and protected write paths', () => {
    const l = layout();
    const base = { settings: settings(), home: l.home, dataDir: l.dataDir };
    expect(() => buildSandboxPolicy({ ...base, cwd: '/' })).toThrow(/task worktree/);
    expect(() => buildSandboxPolicy({ ...base, cwd: l.home })).toThrow(/task worktree/);
    expect(() => buildSandboxPolicy({ ...base, cwd: l.dataDir })).toThrow(/state directory/);
    expect(() => buildSandboxPolicy({ ...base, cwd: 'rel' })).toThrow(/absolute/);
    expect(() =>
      buildSandboxPolicy({
        ...base,
        cwd: l.worktree,
        settings: settings({ writePaths: [join(l.home, '.ssh')] }),
      }),
    ).toThrow(/dotfile/);
  });

  it('refuses a write path that only reaches a protected location through a symlink', () => {
    const l = layout();
    const ssh = join(l.home, '.ssh');
    mkdirSync(ssh);
    const link = join(l.root, 'innocent');
    symlinkSync(ssh, link);
    const stateLink = join(l.root, 'state-link');
    symlinkSync(l.dataDir, stateLink);
    const base = { settings: settings(), home: l.home, dataDir: l.dataDir, cwd: l.worktree };
    for (const p of [link, stateLink]) {
      expect(() =>
        buildSandboxPolicy({ ...base, settings: settings({ writePaths: [p] }) }),
      ).toThrow(/is not allowed/);
    }
  });
});

describe('bwrap argv', () => {
  it('denies network by default, binds in a safe order, and never uses a shell', () => {
    const l = layout();
    const p = buildSandboxPolicy({
      cwd: l.worktree,
      settings: settings(),
      home: l.home,
      dataDir: l.dataDir,
    });
    const a = bwrapArgs(p, ['/usr/bin/node', '-e', 'x; rm -rf /']);
    expect(a).toContain('--unshare-net');
    expect(a).toContain('--die-with-parent');
    expect(a).toContain('--unshare-pid');
    expect(a).toContain('--new-session');
    const at = (...xs: string[]) => a.findIndex((_, i) => xs.every((x, j) => a[i + j] === x));
    const last = (...xs: string[]) => a.findLastIndex((_, i) => xs.every((x, j) => a[i + j] === x));
    const root = at('--ro-bind', '/', '/');
    const tmp = at('--tmpfs', '/tmp');
    const hideHome = at('--tmpfs', l.home);
    const repo = at('--ro-bind-try', l.repo, l.repo);
    const wt = at('--bind', l.worktree, l.worktree);
    const gitRo = last('--ro-bind-try', l.common, l.common);
    const dotGit = last('--ro-bind-try', join(l.worktree, '.git'), join(l.worktree, '.git'));
    for (const i of [root, tmp, hideHome, repo, wt, gitRo, dotGit]) expect(i).toBeGreaterThan(-1);
    // Root first; hide before re-exposing; worktree writable; git read-only LAST so it wins.
    expect(root).toBeLessThan(tmp);
    expect(tmp).toBeLessThan(hideHome);
    expect(hideHome).toBeLessThan(repo);
    expect(repo).toBeLessThan(wt);
    expect(wt).toBeLessThan(gitRo);
    expect(wt).toBeLessThan(dotGit);
    // The hidden home is remounted read-only after every bind.
    expect(last('--remount-ro', l.home)).toBeGreaterThan(dotGit);
    expect(a.slice(at('--chdir', l.worktree))).toEqual([
      '--chdir',
      l.worktree,
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--',
      '/usr/bin/node',
      '-e',
      'x; rm -rf /',
    ]);
    // Nothing writable but the worktree.
    expect(a.filter((x) => x === '--bind' || x === '--bind-try')).toHaveLength(1);
  });

  it('keeps network only when configured', () => {
    const l = layout();
    const p = buildSandboxPolicy({
      cwd: l.worktree,
      settings: settings({ network: true }),
      home: l.home,
      dataDir: l.dataDir,
    });
    expect(bwrapArgs(p, ['true'])).not.toContain('--unshare-net');
  });
});

describe('sandbox-exec profile (run for real by the darwin-only tests in sandbox-process.test.ts)', () => {
  it('is deny-default with paths only as params, writes only to worktree and temp', () => {
    const l = layout();
    const p = buildSandboxPolicy({
      cwd: l.worktree,
      settings: settings(),
      home: l.home,
      dataDir: l.dataDir,
    });
    const { profile, params } = seatbeltProfile(p, '/private/tmp/soot-sbx-1');
    expect(profile.split('\n')[1]).toBe('(deny default)');
    expect(profile).not.toContain('(allow network');
    expect(profile).not.toContain(l.home); // no path is spliced into the profile text
    expect(profile).toMatch(/\(deny file-read\* \(subpath \(param "HIDDEN_0"\)\)\)/);
    expect(profile).toMatch(
      /\(allow file-read\* file-write\* \(subpath \(param "WRITE_0"\)\) \(subpath \(param "WRITE_1"\)\)\)/,
    );
    expect(profile).toMatch(/\(deny file-write\* \(subpath \(param "READONLY_0"\)\)/);
    // The read-only deny comes after the write allow (later rules win in SBPL).
    expect(profile.indexOf('(deny file-write*')).toBeGreaterThan(
      profile.indexOf('(allow file-read* file-write*'),
    );
    expect(params).toEqual([
      ['HIDDEN_0', l.home],
      ...hiddenAncestors([l.home], [l.repo, l.common, l.worktree]).map(
        (p, i) => [`ANCESTOR_${String(i)}`, p] as const,
      ),
      ['READ_0', l.repo],
      ['READ_1', l.common],
      ['WRITE_0', l.worktree],
      ['WRITE_1', '/private/tmp/soot-sbx-1'],
      ['READONLY_0', l.common],
      ['READONLY_1', join(l.worktree, '.git')],
    ]);
    const net = seatbeltProfile({ ...p, network: true }, '/t').profile;
    expect(net).toContain('(allow network*)');
  });

  it('gives metadata-only access to the hidden directories on the way to a re-exposed path', () => {
    const l = layout();
    const p = buildSandboxPolicy({
      cwd: l.worktree,
      settings: settings(),
      home: l.home,
      dataDir: l.dataDir,
    });
    const { profile, params } = seatbeltProfile(p, '/private/tmp/soot-sbx-1');
    const ancestors = params.filter(([n]) => n.startsWith('ANCESTOR_')).map(([, v]) => v);
    // Every parent of the worktree from the hidden home down, and of the re-exposed repo.
    expect([...ancestors].sort()).toEqual(
      [
        l.home,
        join(l.home, '.soot'),
        join(l.home, '.soot', 'worktrees'),
        join(l.home, '.soot', 'worktrees', 'run1'),
        join(l.home, 'code'),
        l.repo, // parent of the re-exposed .git dir
      ].sort(),
    );
    // Nothing above the hidden root (already readable) and nothing outside it (the temp dir).
    expect(ancestors.every((a) => a.startsWith(l.home))).toBe(true);
    // Exact directories (literal), metadata only, and after the hidden deny so it wins.
    const rule = profile.split('\n').find((x) => x.startsWith('(allow file-read-metadata'));
    expect(rule).toMatch(/^\(allow file-read-metadata( \(literal \(param "ANCESTOR_\d+"\)\))+\)$/);
    expect(profile.indexOf('(allow file-read-metadata')).toBeGreaterThan(
      profile.indexOf('(deny file-read*'),
    );
    // Without hidden locations there is nothing to re-expose and no rule.
    const open = buildSandboxPolicy({
      cwd: l.worktree,
      settings: settings(),
      home: null,
      dataDir: null,
    });
    expect(seatbeltProfile(open, '/t').profile).not.toContain('file-read-metadata');
  });

  it('builds the argv with -p, -D params and the command after --', () => {
    const l = layout();
    const p = buildSandboxPolicy({
      cwd: l.worktree,
      settings: settings(),
      home: null,
      dataDir: null,
    });
    const a = sandboxExecArgs(p, '/t', ['/usr/bin/make', 'test']);
    expect(a[0]).toBe('-p');
    expect(a).toContain(`WRITE_0=${l.worktree}`);
    expect(a.slice(a.indexOf('--'))).toEqual(['--', '/usr/bin/make', 'test']);
  });
});

describe('backend choice', () => {
  const host = (h: Partial<SandboxHost>): SandboxHost => ({
    platform: 'linux',
    home: '/home/u',
    dataDir: '/home/u/.soot',
    path: '',
    probe: () => null,
    ...h,
  });
  const withBwrap = () => {
    const d = temp();
    writeFileSync(join(d, 'bwrap'), '');
    return d;
  };

  it('auto: bwrap on Linux when found and working', () => {
    const bin = withBwrap();
    const s = resolveSandbox(settings(), host({ path: bin }));
    expect(s).toMatchObject({ backend: 'bwrap', isolation: true, blocked: null, network: false });
  });

  it('auto: falls back to none (not isolation) when bwrap is missing, unless required', () => {
    const s = resolveSandbox(settings(), host({ path: '' }));
    expect(s).toMatchObject({ backend: 'none', isolation: false, blocked: null });
    expect(s.reason).toMatch(/not isolation.*not found/);
    const r = resolveSandbox(settings({ required: true }), host({ path: '' }));
    expect(r.blocked).toMatch(/required/);
  });

  it('auto: a bwrap that fails its probe is not used', () => {
    const bin = withBwrap();
    const s = resolveSandbox(settings(), host({ path: bin, probe: () => 'no user namespaces' }));
    expect(s).toMatchObject({ backend: 'none', isolation: false });
    expect(s.reason).toMatch(/no user namespaces/);
  });

  it('auto: sandbox-exec on macOS; none elsewhere (Windows has no backend)', () => {
    expect(resolveSandbox(settings(), host({ platform: 'darwin' }))).toMatchObject({
      backend: 'sandbox-exec',
      isolation: true,
    });
    const w = resolveSandbox(settings(), host({ platform: 'win32' }));
    expect(w).toMatchObject({ backend: 'none', isolation: false, blocked: null });
    expect(w.reason).toMatch(/win32/);
  });

  it('an explicitly named backend never silently falls back', () => {
    const s = resolveSandbox(settings({ mode: 'bwrap' }), host({ platform: 'darwin' }));
    expect(s.backend).toBe('none');
    expect(s.blocked).toMatch(/Linux-only.*mode is "bwrap"/);
    const m = resolveSandbox(settings({ mode: 'sandbox-exec' }), host({}));
    expect(m.blocked).toMatch(/macOS-only/);
  });

  it('mode none is the fallback; required + none blocks; bad write paths block', () => {
    expect(resolveSandbox(settings({ mode: 'none' }), host({}))).toMatchObject({
      backend: 'none',
      blocked: null,
    });
    expect(resolveSandbox(settings({ mode: 'none', required: true }), host({})).blocked).toMatch(
      /required/,
    );
    const bad = resolveSandbox(
      settings({ writePaths: ['/srv/soot/x'] }),
      host({ dataDir: '/srv/soot' }),
    );
    expect(bad.blocked).toMatch(/state directory/);
  });

  it('uses a configured bwrapPath', () => {
    const s = resolveSandbox(
      settings({ mode: 'bwrap', bwrapPath: '/opt/bw/bwrap' }),
      host({ path: '' }),
    );
    expect(s.backend).toBe('bwrap');
    expect(s.reason).toContain('/opt/bw/bwrap');
  });

  it('prepare: wraps with the backend, strips secrets, refuses when blocked', () => {
    const l = layout();
    const bin = withBwrap();
    const s = resolveSandbox(settings(), host({ path: bin, home: l.home, dataDir: l.dataDir }));
    const p = s.prepare(['/usr/bin/env'], {
      cwd: l.worktree,
      env: { PATH: '/usr/bin', XAI_API_KEY: 'k' },
    });
    expect(p.command).toBe(join(bin, 'bwrap'));
    expect(p.args.at(-1)).toBe('/usr/bin/env');
    expect(p.env).toEqual({ PATH: '/usr/bin', TMPDIR: '/tmp' });
    const blocked = resolveSandbox(settings({ required: true }), host({ path: '' }));
    expect(() => blocked.prepare(['/usr/bin/env'], { cwd: l.worktree, env: {} })).toThrow(
      /required/,
    );
    const none = unsandboxed();
    const n = none.prepare(['/usr/bin/env', 'x'], { cwd: l.worktree, env: { A_TOKEN: 't' } });
    expect(n).toMatchObject({ command: '/usr/bin/env', args: ['x'], env: {}, backend: 'none' });
    expect(none.isolation).toBe(false);
    expect(none.network).toBe(true); // the fallback cannot stop network, and says so
    expect(() => none.prepare(['/usr/bin/env'], { cwd: '/', env: {} })).toThrow(/worktree/);
  });

  it('findProgram resolves names on PATH and absolute paths', () => {
    const bin = withBwrap();
    expect(findProgram('bwrap', `/nonexistent:${bin}`)).toBe(join(bin, 'bwrap'));
    expect(findProgram('bwrap', '')).toBeNull();
    expect(findProgram(join(bin, 'bwrap'), '')).toBe(join(bin, 'bwrap'));
    expect(findProgram('/nonexistent/x', '')).toBeNull();
  });
});
