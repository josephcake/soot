import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/*
 * Process sandbox for the commands soot launches on an agent's behalf (ADR-051): soot-run
 * validation commands and the ACP agent process. One interface, a backend per OS, using only
 * what the OS already has:
 *
 *   - `bwrap` (Linux bubblewrap): read-only root, the task worktree (and configured extra
 *     paths) writable, a private /tmp, the home and soot state directories hidden behind empty
 *     read-only tmpfs mounts, git internals re-mounted read-only, no network unless configured, its own
 *     PID namespace, killed with its parent.
 *   - `sandbox-exec` (macOS Seatbelt) with a generated deny-default profile: writes only to the
 *     worktree, a per-command temp dir and configured paths; home and state dir unreadable;
 *     network denied unless configured. Built and unit-tested only; never run by soot's CI.
 *   - `none`: the portable fallback. It is NOT isolation and never claims to be: the process
 *     runs with the user's rights. It keeps soot's own protections (allowlisted environment
 *     with credential-like variables stripped, cwd pinned to the task worktree, no shell,
 *     timeouts, process-group kill, output caps; see `runSandboxed`).
 *
 * Policy defaults to deny: nothing is writable except the worktree (+ temp), network is off,
 * and `required: true` (or naming a backend explicitly) blocks rather than falling back.
 */

export const SANDBOX_MODES = ['auto', 'bwrap', 'sandbox-exec', 'none'] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];
export type SandboxBackendName = 'bwrap' | 'sandbox-exec' | 'none';

export interface SandboxSettings {
  /** `auto` picks the OS backend (Linux: bwrap; macOS: sandbox-exec; otherwise none). */
  readonly mode: SandboxMode;
  /** Allow network access from sandboxed processes (default false). */
  readonly network: boolean;
  /** Extra absolute paths made readable (inside hidden locations such as home). */
  readonly readPaths: readonly string[];
  /** Extra absolute paths made writable (never home, dotfiles, .git, the state dir or /). */
  readonly writePaths: readonly string[];
  /** Block tasks instead of running them without real isolation. */
  readonly required: boolean;
  /** Absolute path to bwrap when it is not on PATH. */
  readonly bwrapPath?: string;
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  mode: 'auto',
  network: false,
  readPaths: [],
  writePaths: [],
  required: false,
};

/** Facts about the machine soot runs on. Injected in tests. */
export interface SandboxHost {
  readonly platform: NodeJS.Platform;
  /** The user's home directory (hidden from sandboxed processes), or null when unknown. */
  readonly home: string | null;
  /** soot's state directory (database, reports, worktrees), or null when unknown. */
  readonly dataDir: string | null;
  /** PATH used to find `bwrap`. */
  readonly path: string;
  /** Run the backend once and return null when it works, else why not. Default: real probe. */
  readonly probe?: (backend: 'bwrap' | 'sandbox-exec', executable: string) => string | null;
}

/** Environment variable names that look like credentials never reach a sandboxed process. */
export const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/i;

export function stripSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_ENV_NAME.test(name)) out[name] = value;
  }
  return out;
}

/** True when `child` is `parent` or inside it (both absolute, normalized). */
export function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const segments = (p: string) => p.split(/[\\/]+/).filter((s) => s !== '');

/**
 * Why `path` may never be made writable, or null when it may. Guards: relative paths, `..`,
 * the filesystem root, any `.git` directory, the home directory or an ancestor of it, any
 * dotfile or dot-directory directly in home, and soot's state directory (database, reports,
 * other tasks' worktrees) or anything around it.
 */
export function protectedWriteReason(
  path: string,
  where: { readonly home: string | null; readonly dataDir: string | null },
): string | null {
  if (!isAbsolute(path)) return 'must be an absolute path';
  if (segments(path).includes('..')) return 'must not contain ".."';
  const p = resolve(path);
  if (p === resolve('/')) return 'the filesystem root';
  if (segments(p).includes('.git')) return 'git internals (.git)';
  if (where.home !== null) {
    const home = resolve(where.home);
    if (isWithin(home, p)) return 'your home directory (or a directory containing it)';
    if (isWithin(p, home)) {
      const first = segments(relative(home, p))[0] ?? '';
      if (first.startsWith('.')) return 'a dotfile or dot-directory in your home directory';
    }
  }
  if (where.dataDir !== null) {
    const data = resolve(where.dataDir);
    if (isWithin(data, p) || isWithin(p, data)) return "soot's state directory (database, reports)";
  }
  return null;
}

/** The concrete rules for one command. Every path is absolute and resolved. */
export interface SandboxPolicy {
  /** The task worktree: the process's working directory and its main writable root. */
  readonly cwd: string;
  /** Writable roots: the worktree first, then configured extra write paths. */
  readonly writable: readonly string[];
  /** Hidden behind an empty tmpfs (bwrap) or unreadable (sandbox-exec): home, state dir. */
  readonly hidden: readonly string[];
  /** Re-exposed read-only inside hidden locations: the repository, the executable, extras. */
  readonly readable: readonly string[];
  /** Never writable even inside a writable root: git internals, the worktree's `.git`. */
  readonly readOnly: readonly string[];
  readonly network: boolean;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const byDepth = (paths: readonly string[]) =>
  [...new Set(paths.map((p) => resolve(p)))].sort(
    (a, b) => segments(a).length - segments(b).length || a.localeCompare(b),
  );

/**
 * Git directories behind a worktree: its `.git` (file or directory), the repository's common
 * git dir, and the main working tree. Read from the `.git` file git writes for worktrees.
 */
export function gitPathsFor(worktree: string): {
  readonly dotGit: string | null;
  readonly commonDir: string | null;
  readonly mainTree: string | null;
} {
  const dotGit = join(worktree, '.git');
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return { dotGit: null, commonDir: null, mainTree: null };
  }
  if (stat.isDirectory()) return { dotGit, commonDir: real(dotGit), mainTree: null };
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
  if (m?.[1] === undefined) return { dotGit, commonDir: null, mainTree: null };
  const gitDir = resolve(worktree, m[1]);
  let commonDir = gitDir;
  try {
    commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
  } catch {
    // Not a linked worktree (e.g. a submodule): the git dir is the common dir.
  }
  commonDir = real(commonDir);
  const mainTree = commonDir.endsWith(`${sep}.git`) ? dirname(commonDir) : null;
  return { dotGit, commonDir, mainTree };
}

/** First match of `program` on PATH (or the program itself when it has a slash). */
export function findProgram(program: string, path: string | undefined): string | null {
  if (program === '') return null;
  if (program.includes('/') || program.includes('\\')) {
    const abs = resolve(program);
    return existsSync(abs) ? abs : null;
  }
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, program);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export interface PolicyInput {
  readonly cwd: string;
  readonly settings: SandboxSettings;
  readonly home: string | null;
  readonly dataDir: string | null;
  /** Resolved executable, re-exposed read-only when it lives in a hidden location. */
  readonly executable?: string | null;
}

/** Build the deny-by-default policy for one command in one worktree. */
export function buildSandboxPolicy(input: PolicyInput): SandboxPolicy {
  if (!isAbsolute(input.cwd)) throw new Error(`sandbox cwd must be absolute: ${input.cwd}`);
  const cwd = real(input.cwd);
  const where = { home: input.home === null ? null : real(input.home), dataDir: null };
  if (cwd === resolve('/') || (where.home !== null && isWithin(where.home, cwd))) {
    throw new Error(`sandbox cwd must be a task worktree, not ${cwd}`);
  }
  if (input.dataDir !== null && isWithin(real(input.dataDir), cwd)) {
    throw new Error(`sandbox cwd must be a task worktree, not soot's state directory ${cwd}`);
  }
  for (const p of input.settings.writePaths) {
    const why = protectedWriteReason(p, {
      home: where.home,
      dataDir: input.dataDir === null ? null : real(input.dataDir),
    });
    if (why !== null) throw new Error(`sandbox.writePaths: ${p} is not allowed: ${why}`);
  }
  // Hidden: home and the state dir (existing ones only; tmpfs needs a mount point).
  const hidden = byDepth(
    [input.home, input.dataDir]
      .filter((p): p is string => p !== null && existsSync(p))
      .map(real)
      .filter((p) => p !== resolve('/')),
  ).filter((p, i, all) => !all.slice(0, i).some((q) => isWithin(p, q)));
  const git = gitPathsFor(cwd);
  // An executable installed inside a hidden location (e.g. ~/.local/node/bin/node) is
  // re-exposed read-only: its install prefix, or just its directory when the prefix would
  // re-expose a whole hidden location.
  const exe = input.executable ?? null;
  const exeReal = exe !== null && isAbsolute(exe) ? real(exe) : null;
  const exposes = (p: string) => hidden.some((h) => isWithin(h, p));
  const exeRoot =
    exeReal === null || !hidden.some((h) => isWithin(exeReal, h))
      ? null
      : ([dirname(dirname(exeReal)), dirname(exeReal)].find((p) => !exposes(p)) ?? null);
  const readable = byDepth(
    [git.mainTree, git.commonDir, exeRoot, ...input.settings.readPaths]
      .filter((p): p is string => p !== null)
      .map(real),
  );
  const writable = [cwd, ...byDepth(input.settings.writePaths.map(real)).filter((p) => p !== cwd)];
  const readOnly = byDepth([git.commonDir, git.dotGit].filter((p): p is string => p !== null));
  return { cwd, writable, hidden, readable, readOnly, network: input.settings.network };
}

/** bwrap argument vector (everything after the `bwrap` executable) for `argv` under `policy`. */
export function bwrapArgs(policy: SandboxPolicy, argv: readonly string[]): string[] {
  const a = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
  ];
  if (!policy.network) a.push('--unshare-net');
  a.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp');
  for (const p of policy.hidden) a.push('--tmpfs', p);
  for (const p of policy.readable) a.push('--ro-bind-try', p, p);
  for (const p of policy.writable) a.push(p === policy.cwd ? '--bind' : '--bind-try', p, p);
  for (const p of policy.readOnly) a.push('--ro-bind-try', p, p);
  // Hidden locations end up empty AND read-only: a write there fails instead of landing in a
  // throwaway tmpfs. Not recursive, so the binds made inside them keep their own modes.
  for (const p of policy.hidden) a.push('--remount-ro', p);
  a.push('--chdir', policy.cwd, '--setenv', 'TMPDIR', '/tmp', '--', ...argv);
  return a;
}

export interface SeatbeltProfile {
  /** SBPL text; every path is a `(param ...)`, never spliced into the profile. */
  readonly profile: string;
  /** `-D NAME=value` definitions for the params. */
  readonly params: readonly (readonly [string, string])[];
}

/** Deny-default Seatbelt profile for `policy`, with `tempDir` writable. */
export function seatbeltProfile(policy: SandboxPolicy, tempDir: string): SeatbeltProfile {
  const params: [string, string][] = [];
  const param = (prefix: string, value: string) => {
    const name = `${prefix}_${String(params.filter(([n]) => n.startsWith(`${prefix}_`)).length)}`;
    params.push([name, value]);
    return `(subpath (param "${name}"))`;
  };
  const hidden = policy.hidden.map((p) => param('HIDDEN', p));
  const readable = policy.readable.map((p) => param('READ', p));
  const writable = [...policy.writable, tempDir].map((p) => param('WRITE', p));
  const readOnly = policy.readOnly.map((p) => param('READONLY', p));
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow user-preference-read)',
    '(allow file-read*)',
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty"))',
    ...(hidden.length > 0 ? [`(deny file-read* ${hidden.join(' ')})`] : []),
    ...(readable.length > 0 ? [`(allow file-read* ${readable.join(' ')})`] : []),
    `(allow file-read* file-write* ${writable.join(' ')})`,
    ...(readOnly.length > 0 ? [`(deny file-write* ${readOnly.join(' ')})`] : []),
    ...(policy.network ? ['(allow network*)'] : []),
  ];
  return { profile: `${lines.join('\n')}\n`, params };
}

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** sandbox-exec argument vector (after the executable) for `argv`. */
export function sandboxExecArgs(
  policy: SandboxPolicy,
  tempDir: string,
  argv: readonly string[],
): string[] {
  const { profile, params } = seatbeltProfile(policy, tempDir);
  return ['-p', profile, ...params.flatMap(([n, v]) => ['-D', `${n}=${v}`]), '--', ...argv];
}

/** A command ready to spawn: the wrapper (or the program itself) and its environment. */
export interface PreparedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly backend: SandboxBackendName;
  /** Remove per-command temp state. Idempotent. */
  readonly cleanup: () => void;
}

export interface Sandbox {
  readonly backend: SandboxBackendName;
  /** True only for a real OS backend. The fallback is never isolation. */
  readonly isolation: boolean;
  readonly network: boolean;
  readonly settings: SandboxSettings;
  /** How the backend was chosen (shown by `soot config` and in run reports). */
  readonly reason: string;
  /** Non-null: tasks block and commands are refused, with this reason. */
  readonly blocked: string | null;
  /** Wrap `argv` to run in `cwd` (the task worktree). Throws on an unsafe cwd or policy. */
  prepare(
    argv: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ): PreparedCommand;
}

const noop = (): void => undefined;

class SandboxImpl implements Sandbox {
  readonly backend: SandboxBackendName;
  readonly isolation: boolean;
  readonly network: boolean;
  readonly settings: SandboxSettings;
  readonly reason: string;
  readonly blocked: string | null;
  readonly #executable: string | null;
  readonly #host: Pick<SandboxHost, 'home' | 'dataDir'>;

  constructor(o: {
    backend: SandboxBackendName;
    executable: string | null;
    settings: SandboxSettings;
    reason: string;
    blocked: string | null;
    host: Pick<SandboxHost, 'home' | 'dataDir'>;
  }) {
    this.backend = o.backend;
    this.isolation = o.backend !== 'none';
    this.network = o.backend === 'none' ? true : o.settings.network;
    this.settings = o.settings;
    this.reason = o.reason;
    this.blocked = o.blocked;
    this.#executable = o.executable;
    this.#host = o.host;
  }

  prepare(argv: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    if (this.blocked !== null) throw new Error(this.blocked);
    const [program, ...rest] = argv;
    if (program === undefined || program === '') throw new Error('empty command');
    const env = stripSecretEnv(options.env);
    if (!isAbsolute(options.cwd)) throw new Error(`command cwd must be absolute: ${options.cwd}`);
    if (this.backend === 'none') {
      // Fallback: the cwd guard still applies; no OS isolation.
      buildSandboxPolicy({ ...this.#host, cwd: options.cwd, settings: this.settings });
      return { command: program, args: rest, env, backend: this.backend, cleanup: noop };
    }
    const policy = buildSandboxPolicy({
      ...this.#host,
      cwd: options.cwd,
      settings: this.settings,
      executable: findProgram(program, env.PATH),
    });
    const wrapper = this.#executable ?? '';
    if (this.backend === 'bwrap') {
      return {
        command: wrapper,
        args: bwrapArgs(policy, argv),
        env: { ...env, TMPDIR: '/tmp' },
        backend: this.backend,
        cleanup: noop,
      };
    }
    const temp = real(mkdtempSync(join(tmpdir(), 'soot-sbx-')));
    let cleaned = false;
    return {
      command: wrapper,
      args: sandboxExecArgs(policy, temp, argv),
      env: { ...env, TMPDIR: temp },
      backend: this.backend,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        rmSync(temp, { recursive: true, force: true });
      },
    };
  }
}

const probeCache = new Map<string, string | null>();

/** Run the backend once with the flags soot uses; null when it works, else why not. */
export function probeBackend(backend: 'bwrap' | 'sandbox-exec', executable: string): string | null {
  const key = `${backend}:${executable}`;
  const cached = probeCache.get(key);
  if (cached !== undefined) return cached;
  const args =
    backend === 'bwrap'
      ? [
          '--die-with-parent',
          '--unshare-pid',
          '--unshare-net',
          '--ro-bind',
          '/',
          '/',
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--tmpfs',
          '/tmp',
          '--',
          'true',
        ]
      : ['-p', '(version 1)(allow default)', '--', '/usr/bin/true'];
  const r = spawnSync(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000 });
  const why =
    r.error !== undefined
      ? r.error.message
      : r.status === 0
        ? null
        : `exit ${String(r.status)}: ${r.stderr.toString('utf8').trim().slice(0, 200)}`;
  probeCache.set(key, why);
  return why;
}

/** The fallback with soot's own protections only. Not isolation. */
export function unsandboxed(settings: SandboxSettings = DEFAULT_SANDBOX_SETTINGS): Sandbox {
  return new SandboxImpl({
    backend: 'none',
    executable: null,
    settings,
    reason: 'no OS sandbox (soot protections only)',
    blocked: null,
    host: { home: null, dataDir: null },
  });
}

/** Pick the backend for `settings` on `host`. Never throws; problems become `blocked`. */
export function resolveSandbox(settings: SandboxSettings, host: SandboxHost): Sandbox {
  const probe = host.probe ?? probeBackend;
  const tryBwrap = (): { executable: string } | { why: string } => {
    if (host.platform !== 'linux') return { why: `bwrap is Linux-only (this is ${host.platform})` };
    const executable = settings.bwrapPath ?? findProgram('bwrap', host.path);
    if (executable === null) return { why: 'bwrap was not found on PATH' };
    const why = probe('bwrap', executable);
    return why === null ? { executable } : { why: `${executable} does not work here: ${why}` };
  };
  const trySeatbelt = (): { executable: string } | { why: string } => {
    if (host.platform !== 'darwin')
      return { why: `sandbox-exec is macOS-only (this is ${host.platform})` };
    const why = probe('sandbox-exec', SANDBOX_EXEC);
    return why === null ? { executable: SANDBOX_EXEC } : { why: `${SANDBOX_EXEC}: ${why}` };
  };
  const make = (
    backend: SandboxBackendName,
    executable: string | null,
    reason: string,
    blocked: string | null,
  ) =>
    new SandboxImpl({
      backend,
      executable,
      settings,
      reason,
      blocked,
      host: { home: host.home, dataDir: host.dataDir },
    });
  for (const p of settings.writePaths) {
    const why = protectedWriteReason(p, { home: host.home, dataDir: host.dataDir });
    if (why !== null) {
      return make(
        'none',
        null,
        'invalid sandbox settings',
        `sandbox.writePaths: ${p} is not allowed: ${why}`,
      );
    }
  }
  if (settings.mode === 'none') {
    const blocked = settings.required
      ? 'sandbox.required is true but sandbox.mode is "none"'
      : null;
    return make(
      'none',
      null,
      'sandbox.mode is "none": soot protections only, no OS isolation',
      blocked,
    );
  }
  const attempt =
    settings.mode === 'bwrap'
      ? tryBwrap()
      : settings.mode === 'sandbox-exec'
        ? trySeatbelt()
        : host.platform === 'linux'
          ? tryBwrap()
          : host.platform === 'darwin'
            ? trySeatbelt()
            : { why: `no OS sandbox backend for ${host.platform}` };
  if ('executable' in attempt) {
    const backend: SandboxBackendName =
      settings.mode === 'auto'
        ? host.platform === 'linux'
          ? 'bwrap'
          : 'sandbox-exec'
        : settings.mode;
    return make(
      backend,
      attempt.executable,
      `${backend} (${settings.mode === 'auto' ? 'auto' : 'configured'}): ${attempt.executable}`,
      null,
    );
  }
  // An explicitly named backend never silently falls back.
  const explicit = settings.mode !== 'auto';
  const blocked =
    settings.required || explicit
      ? `no real sandbox: ${attempt.why}${explicit ? ` (sandbox.mode is "${settings.mode}")` : ' (sandbox.required is true)'}`
      : null;
  return make('none', null, `fallback, not isolation: ${attempt.why}`, blocked);
}
