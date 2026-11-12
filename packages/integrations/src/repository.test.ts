import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '@soot/observability';
import { applyStructuredEdits, EditRejectedError } from './edits.js';
import { integrateSerially } from './integrate.js';
import { DirtyWorkingTreeError, Repository } from './repository.js';
import { findDiffOverlaps, WriteLeases, withinScope } from './scope.js';
import { createFixtureRepo, type FixtureRepo } from './test-fixtures.js';

let fx: FixtureRepo | undefined;
afterEach(() => {
  fx?.dispose();
  fx = undefined;
});
const open = async (f: FixtureRepo, runId = 'r1') =>
  Repository.open({
    root: f.root,
    worktreesDir: join(f.dataDir, 'worktrees'),
    runId,
    gitEnv: f.gitEnv,
  });

describe('Repository: worktree isolation (M5-01)', () => {
  it('pins HEAD, gives each task its own worktree and branch, and cleans up', async () => {
    fx = createFixtureRepo();
    const repo = await open(fx);
    expect(repo.baseCommit).toBe(fx.git('rev-parse', 'HEAD'));
    expect(repo.branch).toBe('main');
    const a = (await repo.ensureWorktree('a', repo.baseCommit)).worktree;
    const b = (await repo.ensureWorktree('b', repo.baseCommit)).worktree;
    expect(a.path).not.toBe(b.path);
    expect(a.path.startsWith(fx.root)).toBe(false);
    expect(a.branch).toBe('soot/r1/a');
    writeFileSync(join(a.path, 'src/title.ts'), "export const PAGE_TITLE: string = 'A';\n");
    writeFileSync(join(b.path, 'src/title.ts'), "export const PAGE_TITLE: string = 'B';\n");
    // Isolation: each worktree sees only its own edit; the user's tree sees neither.
    expect(readFileSync(join(fx.root, 'src/title.ts'), 'utf8')).toContain("'Hello'");
    const ca = await repo.commitAll(a, 'a');
    const cb = await repo.commitAll(b, 'b');
    expect(ca).not.toBeNull();
    expect(await repo.changedFiles(repo.baseCommit, ca ?? '')).toEqual([
      { path: 'src/title.ts', status: 'modified' },
    ]);
    expect(await repo.commitAll(a, 'nothing')).toBeNull();
    expect((await repo.listWorktrees()).length).toBe(3);

    // A retry resets the task's worktree to its base.
    const again = await repo.ensureWorktree('a', repo.baseCommit);
    expect(again.reset).toBe(true);
    expect(readFileSync(join(a.path, 'src/title.ts'), 'utf8')).toContain("'Hello'");

    await repo.cleanup(['soot/r1/a']);
    expect(await repo.listWorktrees()).toEqual([fx.root]);
    expect(existsSync(a.path)).toBe(false);
    expect(await repo.listBranches()).toEqual(['soot/r1/b']);
    expect(cb).not.toBeNull();
    expect(fx.git('status', '--porcelain')).toBe('');
  });

  it('refuses a dirty working tree and unsafe ids', async () => {
    fx = createFixtureRepo();
    fx.write('src/title.ts', 'dirty');
    await expect(open(fx)).rejects.toBeInstanceOf(DirtyWorkingTreeError);
    fx.git('checkout', '--', 'src/title.ts');
    await expect(open(fx, '../evil')).rejects.toThrow(/unsafe run id/);
    const repo = await open(fx);
    expect(() => repo.branchFor('a b')).toThrow(/unsafe task id/);
  });
});

describe('serial integration with merge-tree dry runs (M5-03)', () => {
  it('merges non-conflicting work and surfaces conflicts without dropping them', async () => {
    fx = createFixtureRepo();
    const repo = await open(fx);
    const commitIn = async (id: string, path: string, content: string) => {
      const { worktree } = await repo.ensureWorktree(id, repo.baseCommit);
      writeFileSync(join(worktree.path, path), content);
      return {
        taskId: id,
        commit: (await repo.commitAll(worktree, id)) ?? '',
        branch: worktree.branch,
      };
    };
    const title = await commitIn(
      'title',
      'src/title.ts',
      "export const PAGE_TITLE: string = 'HELLO WORLD';\n",
    );
    const red = await commitIn(
      'red',
      'src/button.ts',
      "export const PRIMARY_COLOR: string = 'red';\nexport const SECONDARY_COLOR: string = 'gray';\n",
    );
    const green = await commitIn(
      'green',
      'src/button.ts',
      "export const PRIMARY_COLOR: string = 'green';\nexport const SECONDARY_COLOR: string = 'gray';\n",
    );
    const audit = new AuditLog({ runId: 'r1' });
    const result = await integrateSerially(repo, [title, red, green], audit);
    expect(result.steps.map((s) => [s.taskId, s.status])).toEqual([
      ['title', 'merged'],
      ['red', 'merged'],
      ['green', 'conflict'],
    ]);
    const conflict = result.steps[2];
    expect(conflict?.status === 'conflict' ? conflict.conflicts : []).toEqual(['src/button.ts']);
    expect(audit.entries({ type: 'integration-conflict' })).toHaveLength(1);
    // Nothing touched the user's working tree or branch.
    expect(fx.git('rev-parse', 'HEAD')).toBe(repo.baseCommit);
    expect(fx.git('show', `${result.head}:src/button.ts`)).toContain("'red'");
    expect(fx.git('show', `${result.head}:src/title.ts`)).toContain('HELLO WORLD');
    await repo.cleanup();
    expect(await repo.listBranches()).toEqual(['soot/r1/green', 'soot/r1/red', 'soot/r1/title']);
  });
});

describe('write scope and leases (M5-01/M5-02)', () => {
  it('scope is file- or directory-based; leases exclude overlapping holders', () => {
    expect(withinScope('src/title.ts', ['src/title.ts'])).toBe(true);
    expect(withinScope('src/a/b.ts', ['src/'])).toBe(true);
    expect(withinScope('src/button.ts', ['src/title.ts'])).toBe(false);
    const leases = new WriteLeases();
    expect(leases.acquire('a', ['src/'])).toEqual({ ok: true });
    expect(leases.acquire('b', ['src/x.ts'])).toEqual({
      ok: false,
      heldBy: 'a',
      paths: ['src/x.ts'],
    });
    expect(leases.acquire('c', ['test/x.ts'])).toEqual({ ok: true });
    leases.release('a');
    expect(leases.acquire('b', ['src/x.ts'])).toEqual({ ok: true });
  });

  it('reports overlapping actual diffs between tasks', () => {
    expect(
      findDiffOverlaps([
        {
          taskId: 'a',
          files: [
            { path: 'src/x.ts', status: 'modified' },
            { path: 'src/y.ts', status: 'added' },
          ],
        },
        { taskId: 'b', files: [{ path: 'src/y.ts', status: 'modified' }] },
        { taskId: 'c', files: [{ path: 'src/z.ts', status: 'modified' }] },
      ]),
    ).toEqual([{ first: 'a', second: 'b', paths: ['src/y.ts'] }]);
  });
});

describe('structured edits for the minimal executor (ADR-020, M5-09)', () => {
  it('writes in scope and rejects traversal, absolute, .git, out-of-scope, and symlink escapes', async () => {
    fx = createFixtureRepo();
    const repo = await open(fx);
    const { worktree } = await repo.ensureWorktree('t', repo.baseCommit);
    expect(
      applyStructuredEdits(worktree.path, ['src/'], [{ path: 'src/new.ts', content: 'x' }]),
    ).toEqual(['src/new.ts']);
    symlinkSync('/tmp', join(worktree.path, 'src/escape'));
    for (const path of [
      '../outside.ts',
      '/etc/passwd',
      'src/../README.md',
      '.git/config',
      'README.md',
      'src/escape/x.ts',
      'src\\x.ts',
    ]) {
      expect(() =>
        applyStructuredEdits(worktree.path, ['src/', '.git/'], [{ path, content: 'x' }]),
      ).toThrow(EditRejectedError);
    }
    // All or nothing: one bad edit means nothing is written.
    expect(() =>
      applyStructuredEdits(
        worktree.path,
        ['src/'],
        [
          { path: 'src/ok.ts', content: 'x' },
          { path: 'test/no.ts', content: 'x' },
        ],
      ),
    ).toThrow(/outside the task write scope/);
    expect(existsSync(join(worktree.path, 'src/ok.ts'))).toBe(false);
    await repo.cleanup();
  });
});
