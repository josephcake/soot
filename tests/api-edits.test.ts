/**
 * The `--agent api` edit planner and applier (ADR-048): exact-unique replace, create, whole-file
 * writes, path and lease refusals, size limits, line endings, and all-or-nothing writes with
 * rollback. Pure file-system tests in temp dirs; no model is called.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  API_EDIT_LIMITS,
  ApiEditOpSchema,
  applyPlan,
  locateReplace,
  planEdits,
  type ApiEditOp,
  type EditPlan,
} from '../apps/cli/src/api-edits.js';
import { parseEditsReply } from '../apps/cli/src/api-runner.js';

let root: string | null = null;
const extra: string[] = [];
afterEach(() => {
  if (root !== null) {
    chmodRecursiveWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
  root = null;
  for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
});
function chmodRecursiveWritable(dir: string) {
  try {
    chmodSync(dir, 0o755);
    for (const e of readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory()) chmodRecursiveWritable(join(dir, e.name));
  } catch {
    // best effort
  }
}

function repo(files: Record<string, string | Buffer>): string {
  const r = (root = realpathSync(mkdtempSync(join(tmpdir(), 'soot-api-edits-'))));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(r, p, '..'), { recursive: true });
    writeFileSync(join(r, p), c);
  }
  return r;
}

const plan = (
  r: string,
  ops: ApiEditOp[],
  opts: { scope?: string[]; seen?: string[] } = {},
): EditPlan =>
  planEdits({
    root: r,
    writeScope: opts.scope ?? ['src/'],
    sentInFull: new Set(opts.seen ?? []),
    ops,
  });

const rep = (path: string, old: string, n: string): ApiEditOp => ({
  op: 'replace',
  path,
  old,
  new: n,
});

function kinds(p: EditPlan): string[] {
  return p.ok ? [] : p.failures.map((f) => f.kind);
}

function applied(r: string, p: EditPlan) {
  if (!p.ok) throw new Error(`plan failed: ${JSON.stringify(p.failures)}`);
  const out = applyPlan(r, p.writes);
  expect(out.ok).toBe(true);
  return p;
}

const SRC = 'export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n';

describe('planEdits: replace', () => {
  it('U1 replaces a unique snippet and leaves every other byte alone', () => {
    const r = repo({ 'src/a.ts': SRC });
    const p = applied(r, plan(r, [rep('src/a.ts', '  return 2;', '  return 3;')]));
    expect(readFileSync(join(r, 'src/a.ts'), 'utf8')).toBe(SRC.replace('return 2', 'return 3'));
    expect(p.writes[0]).toMatchObject({ mode: 'replace', ops: 1, fuzzy: 0 });
  });

  it('U2 refuses an ambiguous snippet (overlapping matches count too) and writes nothing', () => {
    const r = repo({ 'src/a.ts': SRC, 'src/b.txt': 'aaa' });
    const p = plan(r, [rep('src/a.ts', 'export function', 'function')]);
    expect(kinds(p)).toEqual(['ambiguous']);
    expect(!p.ok && p.failures[0]?.message).toMatch(/matches 2 places.*more surrounding lines/);
    const q = plan(r, [rep('src/b.txt', 'aa', 'b')]);
    expect(!q.ok && q.failures[0]?.message).toMatch(/matches 2 places/);
    expect(readFileSync(join(r, 'src/a.ts'), 'utf8')).toBe(SRC);
  });

  it('U3 refuses a snippet that is not in the file', () => {
    const r = repo({ 'src/a.ts': SRC });
    expect(kinds(plan(r, [rep('src/a.ts', 'return 9;', 'x')]))).toEqual(['not-found']);
  });

  it('U4 tolerates trailing-whitespace drift when the line match is unique', () => {
    const r = repo({ 'src/a.txt': 'keep\nfoo  \nbar\n' });
    const p = applied(r, plan(r, [rep('src/a.txt', 'foo\n', 'baz\n')]));
    expect(p.writes[0]?.fuzzy).toBe(1);
    expect(readFileSync(join(r, 'src/a.txt'), 'utf8')).toBe('keep\nbaz\nbar\n');
  });

  it('U5 does not guess when the trailing-whitespace pass matches twice', () => {
    const r = repo({ 'src/a.txt': 'foo \nfoo\t\n' });
    expect(kinds(plan(r, [rep('src/a.txt', 'foo\n', 'x\n')]))).toEqual(['ambiguous']);
  });

  it('U6 does not tolerate leading-indentation drift', () => {
    const r = repo({ 'src/a.ts': SRC });
    expect(kinds(plan(r, [rep('src/a.ts', 'return 1;\n}', 'return 5;\n}')]))).toEqual([]);
    expect(kinds(plan(r, [rep('src/a.ts', '    return 1;', '  return 5;')]))).toEqual([
      'not-found',
    ]);
  });

  it('U7/U8 CRLF files match LF or CRLF snippets and keep CRLF on every line', () => {
    const crlf = 'one\r\ntwo\r\nthree\r\n';
    for (const [old, n] of [
      ['two\nthree', 'TWO\nTHREE\nFOUR'],
      ['two\r\nthree', 'TWO\r\nTHREE\r\nFOUR'],
    ] as const) {
      const r = repo({ 'src/w.txt': crlf });
      applied(r, plan(r, [rep('src/w.txt', old, n)]));
      expect(readFileSync(join(r, 'src/w.txt'), 'utf8')).toBe('one\r\nTWO\r\nTHREE\r\nFOUR\r\n');
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('U9 mixed line endings match raw bytes only', () => {
    const r = repo({ 'src/m.txt': 'a\r\nb\nc\n' });
    expect(kinds(plan(r, [rep('src/m.txt', 'a\nb', 'x')]))).toEqual(['not-found']);
    expect(kinds(plan(r, [rep('src/m.txt', 'a\r\nb', 'x')]))).toEqual([]);
  });

  it('U10 keeps a UTF-8 BOM and matches without it', () => {
    const r = repo({ 'src/bom.txt': '\uFEFFhello world\n' });
    applied(r, plan(r, [rep('src/bom.txt', 'hello', 'goodbye')]));
    expect(readFileSync(join(r, 'src/bom.txt'), 'utf8')).toBe('\uFEFFgoodbye world\n');
  });

  it('U11 applies two non-overlapping replaces given in reverse order', () => {
    const r = repo({ 'src/a.ts': SRC });
    applied(
      r,
      plan(r, [
        rep('src/a.ts', 'return 2;', 'return 20;'),
        rep('src/a.ts', 'return 1;', 'return 10;'),
      ]),
    );
    expect(readFileSync(join(r, 'src/a.ts'), 'utf8')).toBe(
      SRC.replace('return 1;', 'return 10;').replace('return 2;', 'return 20;'),
    );
  });

  it('U12 refuses overlapping replaces', () => {
    const r = repo({ 'src/a.ts': SRC });
    expect(
      kinds(
        plan(r, [
          rep('src/a.ts', 'function a() {\n  return 1;', 'x'),
          rep('src/a.ts', 'return 1;\n}', 'y'),
        ]),
      ),
    ).toEqual(['overlap']);
  });

  it('U13 accepts adjacent replaces', () => {
    const r = repo({ 'src/x.txt': 'abcdef' });
    applied(r, plan(r, [rep('src/x.txt', 'abc', 'A'), rep('src/x.txt', 'def', 'D')]));
    expect(readFileSync(join(r, 'src/x.txt'), 'utf8')).toBe('AD');
  });

  it('U14 refuses a replace whose old and new are the same', () => {
    const r = repo({ 'src/a.ts': SRC });
    expect(kinds(plan(r, [rep('src/a.ts', 'return 1;', 'return 1;')]))).toEqual(['no-op']);
  });

  it('U15 an empty "old" is a schema error', () => {
    expect(ApiEditOpSchema.safeParse({ op: 'replace', path: 'a', old: '', new: 'x' }).success).toBe(
      false,
    );
  });

  it('U31 a result equal to the original is listed unchanged and not written', () => {
    const r = repo({ 'src/x.txt': 'foo  \n' });
    // The trailing-whitespace pass matches, and the replacement restores the same bytes.
    const p = plan(r, [rep('src/x.txt', 'foo\n', 'foo  \n')]);
    expect(p).toMatchObject({ ok: true, writes: [], unchanged: ['src/x.txt'] });
  });
});

describe('planEdits: create and whole-file writes', () => {
  it('U16 creates a new file with its parent directories', () => {
    const r = repo({});
    applied(r, plan(r, [{ op: 'create', path: 'src/deep/new.ts', content: 'x\n' }]));
    expect(readFileSync(join(r, 'src/deep/new.ts'), 'utf8')).toBe('x\n');
  });

  it('U17 refuses create on an existing file; U18 refuses replace on a missing file', () => {
    const r = repo({ 'src/a.ts': SRC });
    expect(kinds(plan(r, [{ op: 'create', path: 'src/a.ts', content: 'x' }]))).toEqual(['exists']);
    expect(kinds(plan(r, [rep('src/nope.ts', 'a', 'b')]))).toEqual(['missing-file']);
  });

  it('U19 refuses a whole-file write to an existing file the model was not shown in full', () => {
    const r = repo({ 'src/a.ts': SRC });
    expect(kinds(plan(r, [{ path: 'src/a.ts', content: 'x' }]))).toEqual(['not-seen']);
    expect(kinds(plan(r, [{ path: 'src/a.ts', content: 'x' }], { seen: ['src/a.ts'] }))).toEqual(
      [],
    );
  });

  it('U20 a legacy whole-file edit (no "op") to a new file works as in ADR-039', () => {
    const r = repo({});
    const p = applied(r, plan(r, [{ path: 'src/n.txt', content: 'hi' }]));
    expect(p.writes[0]?.mode).toBe('write');
    expect(readFileSync(join(r, 'src/n.txt'), 'utf8')).toBe('hi');
  });

  it('U21 refuses whole + replace for one path, and two whole writes for one path', () => {
    const r = repo({ 'src/a.ts': SRC });
    const seen = { seen: ['src/a.ts'] };
    expect(
      kinds(plan(r, [{ path: 'src/a.ts', content: 'x' }, rep('src/a.ts', 'return 1;', 'y')], seen)),
    ).toEqual(['mixed-ops']);
    expect(
      kinds(
        plan(
          r,
          [
            { path: 'src/a.ts', content: 'x' },
            { path: 'src/a.ts', content: 'y' },
          ],
          seen,
        ),
      ),
    ).toEqual(['mixed-ops']);
  });

  it('U22 there is no delete: a delete op or null content is a schema error', () => {
    for (const edit of [
      { op: 'delete', path: 'a' },
      { path: 'a', content: null },
    ]) {
      expect(ApiEditOpSchema.safeParse(edit).success).toBe(false);
      const reply = JSON.stringify({ summary: 's', edits: [edit] });
      expect(parseEditsReply(reply).ok).toBe(false);
    }
  });
});

describe('planEdits: paths, lease, encoding and sizes', () => {
  it.each(['../x', '/etc/x', 'C:/x', 'a\\b', '.git/config', 'src/\0x'])(
    'U23 refuses the path %j',
    (path) => {
      const r = repo({});
      mkdirSync(join(r, '.git'));
      expect(
        kinds(plan(r, [{ op: 'create', path, content: 'x' }], { scope: ['', '.git/', 'src/'] })),
      ).toEqual(['path-refused']);
    },
  );

  it('U24 refuses a symlinked directory pointing outside and a symlinked file', () => {
    const r = repo({ 'src/real.txt': 'hello' });
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'soot-outside-')));
    extra.push(outside);
    writeFileSync(join(outside, 'f.txt'), 'hello');
    symlinkSync(outside, join(r, 'src/out'));
    symlinkSync(join(r, 'src/real.txt'), join(r, 'src/link.txt'));
    expect(kinds(plan(r, [rep('src/out/f.txt', 'hello', 'bye')]))).toEqual(['path-refused']);
    expect(kinds(plan(r, [rep('src/link.txt', 'hello', 'bye')]))).toEqual(['path-refused']);
    expect(readFileSync(join(outside, 'f.txt'), 'utf8')).toBe('hello');
  });

  it('U25 refuses a path inside the worktree but outside the write lease', () => {
    const r = repo({ 'src/a.ts': SRC, 'src/b.ts': SRC });
    const p = plan(r, [rep('src/b.ts', 'return 1;', 'x')], { scope: ['src/a.ts'] });
    expect(kinds(p)).toEqual(['outside-lease']);
    expect(!p.ok && p.failures[0]?.message).toMatch(
      /outside this task's write lease \(src\/a\.ts\)/,
    );
  });

  it('U26 refuses to replace in a binary or invalid UTF-8 file', () => {
    const r = repo({
      'src/nul.bin': Buffer.from([0x61, 0x00, 0x62]),
      'src/bad.txt': Buffer.from([0x61, 0xff, 0x62]),
    });
    expect(kinds(plan(r, [rep('src/nul.bin', 'a', 'c')]))).toEqual(['binary']);
    expect(kinds(plan(r, [rep('src/bad.txt', 'a', 'c')]))).toEqual(['binary']);
  });

  it('U27 size limits on the edit payload and the result', () => {
    const r = repo({ 'src/a.txt': 'x', 'src/big.txt': 'y'.repeat(1000) });
    const big = (n: number) => 'z'.repeat(n);
    expect(
      kinds(plan(r, [rep('src/a.txt', big(API_EDIT_LIMITS.replaceOldBytes + 1), 'q')])),
    ).toEqual(['too-large']);
    expect(
      kinds(plan(r, [rep('src/a.txt', 'x', big(API_EDIT_LIMITS.replaceNewBytes + 1))])),
    ).toEqual(['too-large']);
    const many = Array.from({ length: API_EDIT_LIMITS.ops + 1 }, () => rep('src/a.txt', 'x', 'q'));
    expect(kinds(plan(r, many))).toEqual(['too-large']);
    const halfMiB = big(300 * 1024);
    expect(
      kinds(
        plan(r, [
          { op: 'create', path: 'src/n1.txt', content: halfMiB },
          { op: 'create', path: 'src/n2.txt', content: halfMiB },
        ]),
      ),
    ).toEqual(['too-large']);
    // Result over 1 MiB: a 1 MiB file plus a little more.
    writeFileSync(join(r, 'src/big.txt'), 'y'.repeat(API_EDIT_LIMITS.resultFileBytes - 10) + 'END');
    expect(kinds(plan(r, [rep('src/big.txt', 'END', big(100))]))).toEqual(['too-large']);
    // The original file may be far over 64 KiB: only the payload is limited.
    writeFileSync(join(r, 'src/big.txt'), 'y'.repeat(200 * 1024) + 'END');
    expect(kinds(plan(r, [rep('src/big.txt', 'END', 'FIN')]))).toEqual([]);
  });

  it('U28 reports every failure in one reply (at most 20)', () => {
    const r = repo({ 'src/a.ts': SRC });
    const p = plan(r, [
      rep('src/a.ts', 'nope', 'x'),
      rep('../out', 'a', 'b'),
      { op: 'create', path: 'src/a.ts', content: 'x' },
      rep('lib/z.ts', 'a', 'b'),
    ]);
    expect(kinds(p).sort()).toEqual(['mixed-ops', 'outside-lease', 'path-refused']);
    const lots = Array.from({ length: 30 }, (_, i) => rep(`src/m${String(i)}.ts`, 'a', 'b'));
    expect(kinds(plan(r, lots))).toHaveLength(20);
  });
});

describe('applyPlan: all or nothing', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'U29 a failing second write restores the first, removes temp files and created dirs',
    () => {
      const r = repo({ 'src/a.txt': 'one', 'src/locked/b.txt': 'two' });
      const p = plan(r, [
        rep('src/a.txt', 'one', 'ONE'),
        rep('src/locked/b.txt', 'two', 'TWO'),
        { op: 'create', path: 'src/newdir/c.txt', content: 'three' },
      ]);
      if (!p.ok) throw new Error('plan failed');
      // Order the new directory first so the rollback has a directory to remove.
      const writes = [p.writes[2], p.writes[0], p.writes[1]].filter((w) => w !== undefined);
      chmodSync(join(r, 'src/locked'), 0o500);
      const out = applyPlan(r, writes);
      chmodSync(join(r, 'src/locked'), 0o755);
      expect(out).toMatchObject({ ok: false, restored: true });
      expect(readFileSync(join(r, 'src/a.txt'), 'utf8')).toBe('one');
      expect(readFileSync(join(r, 'src/locked/b.txt'), 'utf8')).toBe('two');
      expect(existsSync(join(r, 'src/newdir'))).toBe(false);
      for (const d of ['src', 'src/locked'])
        expect(readdirSync(join(r, d)).filter((f) => f.startsWith('.soot-tmp-'))).toEqual([]);
    },
  );

  it('U29b a write that cannot happen (a file where a directory must go) rolls back cleanly', () => {
    const r = repo({ 'src/a.txt': 'one' });
    const p = plan(r, [
      rep('src/a.txt', 'one', 'ONE'),
      { op: 'create', path: 'src/sub/c.txt', content: 'x' },
    ]);
    if (!p.ok) throw new Error('plan failed');
    writeFileSync(join(r, 'src/sub'), 'in the way');
    const out = applyPlan(r, p.writes);
    expect(out).toMatchObject({ ok: false, restored: true });
    expect(readFileSync(join(r, 'src/a.txt'), 'utf8')).toBe('one');
    expect(readdirSync(join(r, 'src')).sort()).toEqual(['a.txt', 'sub']);
  });

  it('U30 aborts with no writes when a file changed on disk after planning', () => {
    const r = repo({ 'src/a.txt': 'one', 'src/b.txt': 'two' });
    const p = plan(r, [rep('src/a.txt', 'one', 'ONE'), rep('src/b.txt', 'two', 'TWO')]);
    if (!p.ok) throw new Error('plan failed');
    writeFileSync(join(r, 'src/b.txt'), 'two!');
    const out = applyPlan(r, p.writes);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/changed on disk.*nothing was written/);
    expect(readFileSync(join(r, 'src/a.txt'), 'utf8')).toBe('one');
  });

  it('keeps the file mode of a replaced file', () => {
    const r = repo({ 'src/run.sh': '#!/bin/sh\necho hi\n' });
    chmodSync(join(r, 'src/run.sh'), 0o755);
    applied(r, plan(r, [rep('src/run.sh', 'echo hi', 'echo bye')]));
    expect(readdirSync(join(r, 'src'))).toEqual(['run.sh']);
    if (process.platform !== 'win32') {
      expect(statSync(join(r, 'src/run.sh')).mode & 0o777).toBe(0o755);
    }
  });
});

describe('locateReplace', () => {
  it('finds exact matches first and counts overlapping ones', () => {
    expect(locateReplace('abcabc', 'bc')).toEqual({ ok: false, kind: 'ambiguous', count: 2 });
    expect(locateReplace('abc', 'b')).toEqual({ ok: true, start: 1, end: 2, fuzzy: false });
    expect(locateReplace('x\ny  \nz', 'y\nz')).toEqual({ ok: true, start: 2, end: 7, fuzzy: true });
  });
});
