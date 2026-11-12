import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { withinScope } from './scope.js';

/*
 * Structured edits for soot's minimal executor (ADR-020): whole-file writes inside a task's
 * worktree and write scope, validated before anything is written (all or nothing). No
 * deletes, no shell, no paths outside the scope, no `.git`, no symlink escapes.
 */

export interface StructuredEdit {
  /** Path relative to the worktree root, with `/` separators. */
  readonly path: string;
  readonly content: string;
}

export class EditRejectedError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`edit rejected for ${JSON.stringify(path)}: ${reason}`);
    this.name = 'EditRejectedError';
    this.path = path;
  }
}

export const MAX_EDIT_BYTES = 256 * 1024;
export const MAX_EDITS = 50;

function check(root: string, scope: readonly string[], edit: StructuredEdit): string {
  const p = edit.path;
  if (p === '' || p.includes('\0') || p.includes('\\'))
    throw new EditRejectedError(p, 'invalid path');
  if (isAbsolute(p) || p.startsWith('/'))
    throw new EditRejectedError(p, 'absolute paths are not allowed');
  const segments = p.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) {
    throw new EditRejectedError(p, 'path must be normalised (no "..", ".", or empty segments)');
  }
  if (segments[0] === '.git') throw new EditRejectedError(p, 'the .git directory is off limits');
  if (!withinScope(p, scope))
    throw new EditRejectedError(p, `outside the task write scope (${scope.join(', ') || 'none'})`);
  if (Buffer.byteLength(edit.content, 'utf8') > MAX_EDIT_BYTES)
    throw new EditRejectedError(p, 'content too large');
  const target = join(root, ...segments);
  // Every existing ancestor must resolve inside the worktree (no symlinked directories out).
  let dir = dirname(target);
  while (!existsSync(dir)) dir = dirname(dir);
  const real = realpathSync(dir);
  if (real !== root && !real.startsWith(root + sep))
    throw new EditRejectedError(p, 'resolves outside the worktree');
  if (existsSync(target) && lstatSync(target).isSymbolicLink())
    throw new EditRejectedError(p, 'target is a symlink');
  if (relative(root, target).startsWith('..'))
    throw new EditRejectedError(p, 'resolves outside the worktree');
  return target;
}

/** Validate every edit, then write them. Returns the paths written. */
export function applyStructuredEdits(
  worktreeRoot: string,
  writeScope: readonly string[],
  edits: readonly StructuredEdit[],
): string[] {
  if (edits.length > MAX_EDITS)
    throw new EditRejectedError('', `too many edits (${String(edits.length)})`);
  const root = realpathSync(worktreeRoot);
  const targets = edits.map((e) => ({ target: check(root, writeScope, e), edit: e }));
  for (const { target, edit } of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, edit.content);
  }
  return edits.map((e) => e.path);
}
