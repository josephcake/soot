/*
 * Temporary copies of examples/demo-app as real git repositories, with git isolated from the
 * box's global and system config. Used by the Milestone 6 CLI tests.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main, type CliIo } from '@soot/cli';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEMO_APP = join(REPO_ROOT, 'examples/demo-app');

export const TEST_1 =
  'Change the page title to HELLO WORLD and update the primary button to purple.';
export const TEST_2 =
  'Change the button color to purple, add a reusable dropdown component, and investigate the previous authentication bug.';
export const TEST_4 =
  'Implement a new feature, add tests, and review the implementation for security issues.';

export interface DemoRepo {
  readonly top: string;
  readonly root: string;
  readonly dataDir: string;
  readonly env: Record<string, string>;
  git(...args: string[]): string;
  write(path: string, content: string): void;
  read(path: string): string;
  commitAll(message: string): void;
  dispose(): void;
}

export function createDemoRepo(): DemoRepo {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'soot-m6-')));
  const root = join(top, 'repo');
  const dataDir = join(top, 'data');
  cpSync(DEMO_APP, root, { recursive: true });
  const globalConfig = join(top, 'gitconfig');
  writeFileSync(globalConfig, '');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: top,
    SOOT_DATA_DIR: dataDir,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Demo User',
    GIT_AUTHOR_EMAIL: 'demo@example.invalid',
    GIT_COMMITTER_NAME: 'Demo User',
    GIT_COMMITTER_EMAIL: 'demo@example.invalid',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const repo: DemoRepo = {
    top,
    root,
    dataDir,
    env,
    git,
    write: (path, content) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    },
    read: (path) => readFileSync(join(root, path), 'utf8'),
    commitAll: (message) => {
      git('add', '-A');
      git('commit', '--quiet', '-m', message);
    },
    dispose: () => {
      rmSync(top, { recursive: true, force: true });
    },
  };
  git('init', '--quiet', '--initial-branch=main');
  repo.commitAll('demo app');
  return repo;
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the CLI in-process against a demo repo (cwd = repo root). */
export async function cli(
  repo: DemoRepo,
  argv: readonly string[],
  options: { stdin?: string; signal?: AbortSignal; cwd?: string } = {},
): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    stdin: Readable.from(options.stdin === undefined ? [] : [options.stdin]),
    stdinIsTTY: false,
    env: repo.env,
    cwd: options.cwd ?? repo.root,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

export const MOCK = ['--agent', 'mock', '--mock-script', 'mock-agent.json'] as const;
