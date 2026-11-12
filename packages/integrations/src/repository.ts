import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { git, type GitResult } from './git.js';

/*
 * The user's repository and soot's worktrees in it (M5-01, ADR-019): every task gets its own
 * git worktree and branch `soot/<runId>/<taskId>`, created from a pinned base commit, outside
 * the user's working tree. The user's working tree is never modified except by an approved
 * fast-forward (`fastForwardTo`). Ref-changing git commands are serialized per repository.
 */

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export const SOOT_IDENTITY: GitIdentity = { name: 'soot', email: 'soot@localhost' };

export interface RepositoryOptions {
  /** Root of the user's working tree. */
  readonly root: string;
  /** Directory for soot's worktrees (outside the repository), e.g. `$SOOT_DATA_DIR/worktrees`. */
  readonly worktreesDir: string;
  readonly runId: string;
  /** Author/committer of soot's task and integration commits. */
  readonly identity?: GitIdentity;
  /** Environment for git (default `process.env`). */
  readonly gitEnv?: NodeJS.ProcessEnv;
}

export interface Worktree {
  readonly taskId: string;
  readonly path: string;
  readonly branch: string;
  /** Commit the worktree started from. */
  readonly base: string;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'type-changed';

export interface FileChange {
  readonly path: string;
  readonly status: FileStatus;
}

export type MergeTreeResult =
  | { readonly clean: true; readonly tree: string }
  | { readonly clean: false; readonly conflicts: readonly string[]; readonly messages: string };

export class DirtyWorkingTreeError extends Error {
  constructor(root: string, status: string) {
    super(
      `working tree at ${root} has uncommitted changes; commit or stash them first:\n${status}`,
    );
    this.name = 'DirtyWorkingTreeError';
  }
}

const STATUS: Readonly<Record<string, FileStatus>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  T: 'type-changed',
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class Repository {
  readonly root: string;
  readonly runId: string;
  /** Commit every task starts from (HEAD when the run began). */
  readonly baseCommit: string;
  /** Branch checked out in the user's working tree, or `null` if HEAD is detached. */
  readonly branch: string | null;
  readonly worktreesDir: string;
  readonly #identity: GitIdentity;
  readonly #env: NodeJS.ProcessEnv;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #worktrees = new Map<string, Worktree>();

  private constructor(
    options: RepositoryOptions,
    root: string,
    baseCommit: string,
    branch: string | null,
  ) {
    this.root = root;
    this.runId = options.runId;
    this.baseCommit = baseCommit;
    this.branch = branch;
    this.worktreesDir = join(options.worktreesDir, options.runId);
    this.#identity = options.identity ?? SOOT_IDENTITY;
    this.#env = options.gitEnv ?? process.env;
  }

  /** Open a repository whose working tree is clean, and pin HEAD as the run's base. */
  static async open(options: RepositoryOptions): Promise<Repository> {
    if (!SAFE_ID.test(options.runId)) throw new Error(`unsafe run id: ${options.runId}`);
    const env = options.gitEnv ?? process.env;
    const top = (
      await git(['rev-parse', '--show-toplevel'], { cwd: options.root, env })
    ).stdout.trim();
    const root = realpathSync(top);
    const status = (await git(['status', '--porcelain'], { cwd: root, env })).stdout;
    if (status.trim() !== '') throw new DirtyWorkingTreeError(root, status);
    const base = (await git(['rev-parse', 'HEAD'], { cwd: root, env })).stdout.trim();
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: root,
      env,
      allowExitCodes: [1],
    });
    mkdirSync(join(options.worktreesDir, options.runId), { recursive: true, mode: 0o700 });
    return new Repository(options, root, base, branch.exitCode === 0 ? branch.stdout.trim() : null);
  }

  #git(
    args: readonly string[],
    cwd = this.root,
    allowExitCodes?: readonly number[],
  ): Promise<GitResult> {
    return git(args, {
      cwd,
      env: {
        ...this.#env,
        GIT_AUTHOR_NAME: this.#identity.name,
        GIT_AUTHOR_EMAIL: this.#identity.email,
        GIT_COMMITTER_NAME: this.#identity.name,
        GIT_COMMITTER_EMAIL: this.#identity.email,
      },
      ...(allowExitCodes === undefined ? {} : { allowExitCodes }),
    });
  }

  /** Run ref-changing work one at a time (worktree add/remove, commits, branches). */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  branchFor(taskId: string): string {
    if (!SAFE_ID.test(taskId)) throw new Error(`unsafe task id for a branch: ${taskId}`);
    return `soot/${this.runId}/${taskId}`;
  }

  worktree(taskId: string): Worktree | undefined {
    return this.#worktrees.get(taskId);
  }

  /**
   * Worktree for a task, created from `base` on its own branch. If it already exists (a
   * retry), it is reset to `base` and cleaned; that only touches soot's own worktree.
   */
  ensureWorktree(taskId: string, base: string): Promise<{ worktree: Worktree; reset: boolean }> {
    return this.#serial(async () => {
      const existing = this.#worktrees.get(taskId);
      if (existing !== undefined) {
        await this.#git(['reset', '--quiet', '--hard', base], existing.path);
        await this.#git(['clean', '-fdxq'], existing.path);
        const worktree = { ...existing, base };
        this.#worktrees.set(taskId, worktree);
        return { worktree, reset: true };
      }
      const branch = this.branchFor(taskId);
      const path = join(this.worktreesDir, taskId);
      await this.#git(['worktree', 'add', '--quiet', '-b', branch, path, base]);
      const worktree: Worktree = { taskId, path: realpathSync(path), branch, base };
      this.#worktrees.set(taskId, worktree);
      return { worktree, reset: false };
    });
  }

  /** Detached worktree at `commit` (for final validation of the integrated result). */
  detachedWorktree(name: string, commit: string): Promise<string> {
    return this.#serial(async () => {
      if (!SAFE_ID.test(name)) throw new Error(`unsafe worktree name: ${name}`);
      const path = join(this.worktreesDir, `_${name}`);
      await this.#git(['worktree', 'add', '--quiet', '--detach', path, commit]);
      return realpathSync(path);
    });
  }

  /** Commit everything in a task worktree. Returns the commit, or `null` if nothing changed. */
  commitAll(worktree: Worktree, message: string): Promise<string | null> {
    return this.#serial(async () => {
      await this.#git(['add', '--all'], worktree.path);
      const staged = await this.#git(['diff', '--cached', '--quiet'], worktree.path, [1]);
      if (staged.exitCode === 0) return null;
      await this.#git(['commit', '--quiet', '-m', message], worktree.path);
      return (await this.#git(['rev-parse', 'HEAD'], worktree.path)).stdout.trim();
    });
  }

  /** Files changed between two commits (renames reported as delete + add). */
  async changedFiles(from: string, to: string): Promise<FileChange[]> {
    const out = (await this.#git(['diff', '--name-status', '--no-renames', '-z', from, to])).stdout;
    const parts = out.split('\0').filter((p) => p !== '');
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i] ?? '';
      changes.push({ path: parts[i + 1] ?? '', status: STATUS[code.charAt(0)] ?? 'modified' });
    }
    return changes;
  }

  /** Dry-run merge of `theirs` into `ours` without touching any working tree (git ≥ 2.38). */
  async mergeTree(ours: string, theirs: string): Promise<MergeTreeResult> {
    const r = await this.#git(
      ['merge-tree', '--write-tree', '--name-only', ours, theirs],
      this.root,
      [1],
    );
    const [tree = '', ...rest] = r.stdout.split('\n');
    if (r.exitCode === 0) return { clean: true, tree: tree.trim() };
    const blank = rest.indexOf('');
    const conflicts = (blank === -1 ? rest : rest.slice(0, blank)).filter((l) => l !== '');
    const messages =
      blank === -1
        ? ''
        : rest
            .slice(blank + 1)
            .join('\n')
            .trim();
    return { clean: false, conflicts: [...new Set(conflicts)], messages };
  }

  commitTree(tree: string, parents: readonly string[], message: string): Promise<string> {
    return this.#serial(async () => {
      const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message];
      return (await this.#git(args)).stdout.trim();
    });
  }

  setBranch(name: string, commit: string): Promise<void> {
    return this.#serial(async () => {
      await this.#git(['branch', '--force', name, commit]);
    });
  }

  async headCommit(): Promise<string> {
    return (await this.#git(['rev-parse', 'HEAD'])).stdout.trim();
  }

  async workingTreeStatus(): Promise<string> {
    return (await this.#git(['status', '--porcelain'])).stdout;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.#git(
      ['merge-base', '--is-ancestor', ancestor, descendant],
      this.root,
      [1],
    );
    return r.exitCode === 0;
  }

  /** Fast-forward the user's checked-out branch to `commit`. Callers must hold approval. */
  fastForwardTo(commit: string): Promise<void> {
    return this.#serial(async () => {
      await this.#git(['merge', '--ff-only', '--quiet', commit]);
    });
  }

  /** Paths of every worktree git knows about (the main working tree first). */
  async listWorktrees(): Promise<string[]> {
    const out = (await this.#git(['worktree', 'list', '--porcelain'])).stdout;
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length));
  }

  async listBranches(prefix = `soot/${this.runId}/`): Promise<string[]> {
    const out = (
      await this.#git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`])
    ).stdout;
    return out.split('\n').filter((l) => l !== '');
  }

  /**
   * Remove every worktree of this run and prune. Task branches are kept unless listed in
   * `deleteBranches` (unmerged and conflicting work stays inspectable).
   */
  cleanup(deleteBranches: readonly string[] = []): Promise<void> {
    return this.#serial(async () => {
      const mine = (await this.listWorktrees()).filter((p) =>
        p.startsWith(realpathSync(this.worktreesDir)),
      );
      for (const path of mine) await this.#git(['worktree', 'remove', '--force', path]);
      await this.#git(['worktree', 'prune']);
      for (const branch of deleteBranches) await this.#git(['branch', '-D', '--quiet', branch]);
      this.#worktrees.clear();
    });
  }
}
