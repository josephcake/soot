import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { redactSecrets } from '@soot/observability';

/*
 * soot-run validation commands (M5-04) and command controls (M5-08). Commands come from soot's
 * configuration only (never from agent output), run as argument vectors without a shell, in
 * the task's worktree, with a scrubbed environment (no keys or tokens), a timeout, and an
 * executable allowlist. Destructive programs and git subcommands are refused outright.
 */

export type CheckKind = 'test' | 'typecheck' | 'lint' | 'acceptance';

export interface CheckCommand {
  readonly name: string;
  readonly kind: CheckKind;
  /** Program and arguments. `argv[0]` must be on the policy allowlist. */
  readonly argv: readonly string[];
  readonly timeoutMs?: number;
  /** Required checks must pass for a task to be verified (default true). */
  readonly required?: boolean;
}

export interface CommandPolicy {
  /** Exact `argv[0]` values that may run (e.g. `process.execPath`). */
  readonly allowedExecutables: readonly string[];
}

export type CheckStatus = 'passed' | 'failed' | 'timed-out' | 'unavailable' | 'refused';

export interface CheckEvidence {
  readonly name: string;
  readonly kind: CheckKind;
  readonly argv: readonly string[];
  readonly status: CheckStatus;
  readonly required: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** Last part of stdout+stderr, secrets redacted. UNTRUSTED text: never interpreted. */
  readonly outputTail: string;
  /** Why it was refused or unavailable. */
  readonly reason: string | null;
  /** Commit checked out where the command ran. */
  readonly commit: string | null;
}

const DESTRUCTIVE_PROGRAMS: ReadonlySet<string> = new Set([
  'rm',
  'rmdir',
  'mv',
  'dd',
  'mkfs',
  'shred',
  'chmod',
  'chown',
  'sudo',
  'su',
  'doas',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'kill',
  'pkill',
]);
const DESTRUCTIVE_GIT: ReadonlySet<string> = new Set([
  'push',
  'reset',
  'clean',
  'checkout',
  'switch',
  'restore',
  'rebase',
  'merge',
  'commit',
  'branch',
  'tag',
  'worktree',
  'update-ref',
  'gc',
  'prune',
  'filter-branch',
  'remote',
  'config',
]);

export type CommandDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export function checkCommand(argv: readonly string[], policy: CommandPolicy): CommandDecision {
  const program = argv[0];
  if (program === undefined || program === '') return { allowed: false, reason: 'empty command' };
  const name = basename(program);
  if (DESTRUCTIVE_PROGRAMS.has(name)) {
    return {
      allowed: false,
      reason: `"${name}" is destructive or a shell; validation commands must not change state`,
    };
  }
  if (name === 'git') {
    const sub = argv.slice(1).find((a) => !a.startsWith('-'));
    if (sub === undefined || DESTRUCTIVE_GIT.has(sub)) {
      return { allowed: false, reason: `git ${sub ?? ''} changes repository state` };
    }
  }
  if (!policy.allowedExecutables.includes(program)) {
    return { allowed: false, reason: `"${program}" is not on the command allowlist` };
  }
  return { allowed: true };
}

const ENV_KEEP = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'];

/** Environment for soot-run commands: a few basics, nothing that could carry a credential. */
export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' };
  for (const key of ENV_KEEP) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const TAIL = 4000;

export interface RunCheckOptions {
  readonly cwd: string;
  readonly policy: CommandPolicy;
  readonly commit: string | null;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

export function runCheck(check: CheckCommand, options: RunCheckOptions): Promise<CheckEvidence> {
  const required = check.required ?? true;
  const base = {
    name: check.name,
    kind: check.kind,
    argv: [...check.argv],
    required,
    commit: options.commit,
  };
  const decision = checkCommand(check.argv, options.policy);
  if (!decision.allowed) {
    return Promise.resolve({
      ...base,
      status: 'refused',
      exitCode: null,
      durationMs: 0,
      outputTail: '',
      reason: decision.reason,
    });
  }
  const [program = '', ...args] = check.argv;
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(
      program,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? scrubbedEnv(),
        timeout: check.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        const durationMs = Math.round(performance.now() - started);
        const output = redactSecrets(`${stdout}${stderr}`);
        const outputTail = output.length > TAIL ? output.slice(-TAIL) : output;
        if (error === null) {
          resolve({ ...base, status: 'passed', exitCode: 0, durationMs, outputTail, reason: null });
          return;
        }
        if (error.code === 'ENOENT') {
          resolve({
            ...base,
            status: 'unavailable',
            exitCode: null,
            durationMs,
            outputTail,
            reason: `${program} not found`,
          });
          return;
        }
        if (error.killed) {
          resolve({
            ...base,
            status: 'timed-out',
            exitCode: null,
            durationMs,
            outputTail,
            reason: 'killed after timeout or cancellation',
          });
          return;
        }
        resolve({
          ...base,
          status: 'failed',
          exitCode: typeof error.code === 'number' ? error.code : null,
          durationMs,
          outputTail,
          reason: null,
        });
      },
    );
  });
}
