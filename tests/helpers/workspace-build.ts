/*
 * Build the workspace once for tests that run the built CLI in a child process. Test files run
 * in parallel, so builds are serialized with a lock directory.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './demo-repo.js';

const LOCK = join(REPO_ROOT, 'node_modules/.cache/soot-test-build.lock');

export async function buildWorkspace(): Promise<void> {
  mkdirSync(join(REPO_ROOT, 'node_modules/.cache'), { recursive: true });
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 180_000)
          rmSync(LOCK, { recursive: true, force: true });
      } catch {
        // lock vanished meanwhile
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'node_modules/typescript/bin/tsc'), '-b', 'tsconfig.json'],
      {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      },
    );
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

export const CLI_BIN = join(REPO_ROOT, 'apps/cli/dist/bin.js');
