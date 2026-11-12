import { execFile } from 'node:child_process';

/*
 * Minimal git runner: `execFile` with an argument vector (never a shell), a timeout, no
 * terminal prompts, and no inherited GIT_DIR-style overrides.
 */

export interface GitOptions {
  readonly cwd: string;
  /** Base environment (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Non-zero exit codes that are answers, not errors (e.g. `merge-tree` exits 1 on conflict). */
  readonly allowExitCodes?: readonly number[];
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(args: readonly string[], exitCode: number | null, stderr: string) {
    super(
      `git ${args.join(' ')} failed (exit ${String(exitCode)}): ${stderr.trim().slice(0, 500)}`,
    );
    this.name = 'GitError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

const STRIPPED = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
];

export function git(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries({ ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0' }).filter(
      ([key]) => !STRIPPED.includes(key),
    ),
  );
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        env,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : null;
        if (code !== null && (options.allowExitCodes ?? []).includes(code)) {
          resolve({ stdout, stderr, exitCode: code });
          return;
        }
        reject(new GitError(args, code, stderr || error.message));
      },
    );
  });
}
