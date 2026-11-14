import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withinScope } from '@soot/integrations';
import { z } from 'zod';

/*
 * Edits from a `--agent api` reply (ADR-048, amends ADR-039). A reply may replace one exact,
 * unique snippet of an existing file, create a new file, or (ADR-039) give a whole file. Every
 * edit is planned in memory first (path rules, write lease, a unique match, no overlaps, size
 * limits) and nothing is written unless every edit applies. Then the files are written with
 * temp file + rename, and every written file is put back if any write fails.
 */

export type ApiEditOp =
  /** ADR-039 whole-file write; `op` may be omitted for backwards compatibility. */
  | { readonly op?: 'write'; readonly path: string; readonly content: string }
  /** Replace exactly one occurrence of `old` with `new` in an existing file. */
  | { readonly op: 'replace'; readonly path: string; readonly old: string; readonly new: string }
  /** Create a file that does not exist yet. */
  | { readonly op: 'create'; readonly path: string; readonly content: string };

/** Byte limits on the edit payload (not on the size of the original file). */
export const API_EDIT_LIMITS = {
  /** `edits[]` length. */
  ops: 60,
  /** Per `old`. */
  replaceOldBytes: 32 * 1024,
  /** Per `new`. */
  replaceNewBytes: 64 * 1024,
  /** Per whole-file or create `content`. */
  wholeBytes: 512 * 1024,
  /** Sum of every `old`, `new` and `content` in one reply. */
  replyEditBytes: 512 * 1024,
  /** A file after its edits. */
  resultFileBytes: 1024 * 1024,
  /** Per-file send cap for files the task may write, in `auto` mode. */
  sendWritableBytes: 256 * 1024,
  /** Failures reported per reply. */
  failures: 20,
} as const;

const Path = z.string().min(1).max(400);
/** The ADR-039 whole-file edit, exactly (used alone by `apiEditFormat: "whole"`). */
export const WholeEditSchema = z
  .object({ path: Path, content: z.string().max(API_EDIT_LIMITS.wholeBytes) })
  .strict();
const WriteOp = z
  .object({
    op: z.literal('write').optional(),
    path: Path,
    content: z.string().max(API_EDIT_LIMITS.wholeBytes),
  })
  .strict();
const ReplaceOp = z
  .object({
    op: z.literal('replace'),
    path: Path,
    old: z.string().min(1),
    new: z.string(),
  })
  .strict();
const CreateOp = z
  .object({
    op: z.literal('create'),
    path: Path,
    content: z.string().max(API_EDIT_LIMITS.wholeBytes),
  })
  .strict();
/** One edit in `auto` mode. Byte limits are checked by `planEdits` (zod counts UTF-16 units). */
export const ApiEditOpSchema = z.union([ReplaceOp, CreateOp, WriteOp]);

/** A relative, normalized path inside `root`, or a reason it is refused (ADR-039). */
export function checkEditPath(
  root: string,
  path: string,
): { ok: true; rel: string } | { ok: false; reason: string } {
  if (path.includes('\0') || path.includes('\\'))
    return { ok: false, reason: 'invalid characters' };
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path)) return { ok: false, reason: 'absolute path' };
  const parts = path.split('/');
  if (parts.some((p) => p === '..')) return { ok: false, reason: 'path escapes the worktree' };
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    return { ok: false, reason: 'path escapes the worktree' };
  if (rel.split(sep)[0] === '.git') return { ok: false, reason: 'git metadata' };
  // Refuse to write through a symlink anywhere on the way (it could point outside), or below a
  // path that is a file.
  let probe = root;
  const segs = rel.split(sep);
  for (const [i, part] of segs.entries()) {
    probe = join(probe, part);
    if (!existsSync(probe) && !isSymlink(probe)) break;
    const st = lstatSync(probe);
    if (st.isSymbolicLink()) return { ok: false, reason: 'path goes through a symlink' };
    if (i < segs.length - 1 && !st.isDirectory())
      return { ok: false, reason: 'a parent of the path is not a directory' };
  }
  const realRoot = realpathSync(root);
  let parent = dirname(target);
  while (!existsSync(parent)) parent = dirname(parent);
  const realParent = realpathSync(parent);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep))
    return { ok: false, reason: 'path escapes the worktree' };
  return { ok: true, rel: rel.split(sep).join('/') };
}

const isSymlink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

export type EditFailureKind =
  | 'path-refused'
  | 'outside-lease'
  | 'not-found'
  | 'ambiguous'
  | 'overlap'
  | 'no-op'
  | 'missing-file'
  | 'exists'
  | 'not-seen'
  | 'mixed-ops'
  | 'binary'
  | 'too-large';

export interface EditFailure {
  /** Position in `edits[]`. */
  readonly index: number;
  /** As given (at most 200 characters). */
  readonly path: string;
  readonly kind: EditFailureKind;
  /** Model-facing, e.g. 'old text matches 3 places; include more surrounding lines'. */
  readonly message: string;
}

export interface PlannedWrite {
  /** Normalised, '/'-separated. */
  readonly rel: string;
  /** Exact bytes read while planning; `null` = new file. */
  readonly before: Buffer | null;
  /** Full new content. */
  readonly after: string;
  readonly mode: 'write' | 'replace' | 'create';
  /** Replace ops folded into this file. */
  readonly ops: number;
  /** Replace ops matched only by the trailing-whitespace pass. */
  readonly fuzzy: number;
}

export type EditPlan =
  | {
      readonly ok: true;
      readonly writes: readonly PlannedWrite[];
      readonly unchanged: readonly string[];
    }
  | { readonly ok: false; readonly failures: readonly EditFailure[] };

export type Eol = 'lf' | 'crlf' | 'none' | 'mixed';

/** The line-ending style of a text. */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (lf === 0) return 'none';
  if (crlf === 0) return 'lf';
  return crlf === lf ? 'crlf' : 'mixed';
}

/** Start offsets of every occurrence of `needle`, overlapping ones included. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const rstrip = (s: string) => s.replace(/[ \t]+$/, '');

export type Located =
  | { readonly ok: true; readonly start: number; readonly end: number; readonly fuzzy: boolean }
  | { readonly ok: false; readonly kind: 'not-found' | 'ambiguous'; readonly count: number };

/**
 * Where `old` occurs in `text`: exactly once, or (when it never occurs exactly) exactly once
 * line-aligned with trailing spaces and tabs ignored on both sides. Nothing fuzzier.
 */
export function locateReplace(text: string, old: string): Located {
  const exact = occurrences(text, old);
  if (exact.length === 1) {
    const start = exact[0] ?? 0;
    return { ok: true, start, end: start + old.length, fuzzy: false };
  }
  if (exact.length > 1) return { ok: false, kind: 'ambiguous', count: exact.length };
  // Trailing-whitespace pass, whole lines only.
  const lines = text.split('\n');
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  const oldLines = old.split('\n');
  const endsWithNewline = oldLines.length > 1 && oldLines.at(-1) === '';
  const want = (endsWithNewline ? oldLines.slice(0, -1) : oldLines).map(rstrip);
  const hits: { start: number; end: number }[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let match = true;
    for (let j = 0; j < want.length; j++) {
      if (rstrip(lines[i + j] ?? '') !== want[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const last = i + want.length - 1;
    const lastEnd = (starts[last] ?? 0) + (lines[last] ?? '').length;
    if (endsWithNewline && last === lines.length - 1) continue; // no newline to consume
    hits.push({ start: starts[i] ?? 0, end: endsWithNewline ? lastEnd + 1 : lastEnd });
    if (hits.length > 1) break;
  }
  if (hits.length === 1 && hits[0] !== undefined)
    return { ok: true, start: hits[0].start, end: hits[0].end, fuzzy: true };
  if (hits.length > 1) return { ok: false, kind: 'ambiguous', count: hits.length };
  return { ok: false, kind: 'not-found', count: 0 };
}

const BOM = '\uFEFF';
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const kib = (n: number) => `${String(Math.round(n / 1024))} KiB`;

/**
 * Check every edit against the worktree without writing anything. Returns the full new
 * content of each changed file, or every failure found (at most `API_EDIT_LIMITS.failures`).
 */
export function planEdits(input: {
  readonly root: string;
  readonly writeScope: readonly string[];
  /** Paths whose full content was in the prompt. */
  readonly sentInFull: ReadonlySet<string>;
  readonly ops: readonly ApiEditOp[];
}): EditPlan {
  const failures: EditFailure[] = [];
  const fail = (index: number, path: string, kind: EditFailureKind, message: string) => {
    if (failures.length < API_EDIT_LIMITS.failures)
      failures.push({ index, path: path.slice(0, 200), kind, message });
  };
  const { root, ops } = input;
  if (ops.length > API_EDIT_LIMITS.ops) {
    fail(
      API_EDIT_LIMITS.ops,
      '(reply)',
      'too-large',
      `${String(ops.length)} edits; at most ${String(API_EDIT_LIMITS.ops)} per reply`,
    );
    return { ok: false, failures };
  }
  let payload = 0;
  for (const op of ops)
    payload += op.op === 'replace' ? bytes(op.old) + bytes(op.new) : bytes(op.content);
  if (payload > API_EDIT_LIMITS.replyEditBytes) {
    fail(
      0,
      '(reply)',
      'too-large',
      `the edits add up to ${kib(payload)}; at most ${kib(API_EDIT_LIMITS.replyEditBytes)} per reply`,
    );
  }

  // Path, lease and per-field size checks, then group by file.
  const groups = new Map<string, { index: number; op: ApiEditOp }[]>();
  for (const [index, op] of ops.entries()) {
    const checked = checkEditPath(root, op.path);
    if (!checked.ok) {
      fail(
        index,
        op.path,
        'path-refused',
        `refused edit to "${op.path.slice(0, 200)}": ${checked.reason}`,
      );
      continue;
    }
    if (!withinScope(checked.rel, input.writeScope)) {
      fail(
        index,
        op.path,
        'outside-lease',
        `${checked.rel} is outside this task's write lease (${input.writeScope.join(', ') || 'none'})`,
      );
      continue;
    }
    if (op.op === 'replace') {
      if (bytes(op.old) > API_EDIT_LIMITS.replaceOldBytes) {
        fail(
          index,
          op.path,
          'too-large',
          `"old" is ${kib(bytes(op.old))}; at most ${kib(API_EDIT_LIMITS.replaceOldBytes)}`,
        );
        continue;
      }
      if (bytes(op.new) > API_EDIT_LIMITS.replaceNewBytes) {
        fail(
          index,
          op.path,
          'too-large',
          `"new" is ${kib(bytes(op.new))}; at most ${kib(API_EDIT_LIMITS.replaceNewBytes)}`,
        );
        continue;
      }
    } else if (bytes(op.content) > API_EDIT_LIMITS.wholeBytes) {
      fail(
        index,
        op.path,
        'too-large',
        `"content" is ${kib(bytes(op.content))}; at most ${kib(API_EDIT_LIMITS.wholeBytes)}`,
      );
      continue;
    }
    const list = groups.get(checked.rel) ?? [];
    list.push({ index, op });
    groups.set(checked.rel, list);
  }

  const writes: PlannedWrite[] = [];
  const unchanged: string[] = [];
  for (const [rel, list] of groups) {
    const first = list[0];
    if (first === undefined) continue;
    const kinds = list.map((e) => e.op.op ?? 'write');
    if (list.length > 1 && kinds.some((k) => k !== 'replace')) {
      fail(
        first.index,
        first.op.path,
        'mixed-ops',
        `${rel} has a whole-file or create edit plus other edits; send either one whole file or only "replace" edits`,
      );
      continue;
    }
    const abs = join(root, rel);
    let before: Buffer | null = null;
    if (existsSync(abs)) {
      const st = lstatSync(abs);
      if (!st.isFile()) {
        fail(
          first.index,
          first.op.path,
          'path-refused',
          `refused edit to "${rel}": not a regular file`,
        );
        continue;
      }
      before = readFileSync(abs);
    }
    const op = first.op;
    if (op.op === 'create' || op.op === undefined || op.op === 'write') {
      const mode = op.op === 'create' ? 'create' : 'write';
      if (mode === 'create' && before !== null) {
        fail(
          first.index,
          op.path,
          'exists',
          `${rel} already exists; use "replace" edits (or the whole-file form if it was shown in full)`,
        );
        continue;
      }
      if (mode === 'write' && before !== null && !input.sentInFull.has(rel)) {
        fail(
          first.index,
          op.path,
          'not-seen',
          `${rel} was not shown to you in full, so it cannot be overwritten as a whole file; use "replace" edits`,
        );
        continue;
      }
      if (bytes(op.content) > API_EDIT_LIMITS.resultFileBytes) {
        fail(
          first.index,
          op.path,
          'too-large',
          `${rel} would be larger than ${kib(API_EDIT_LIMITS.resultFileBytes)}`,
        );
        continue;
      }
      if (before?.equals(Buffer.from(op.content, 'utf8'))) {
        unchanged.push(rel);
        continue;
      }
      writes.push({ rel, before, after: op.content, mode, ops: 0, fuzzy: 0 });
      continue;
    }

    // Only replace ops from here on.
    if (before === null) {
      fail(
        first.index,
        op.path,
        'missing-file',
        `${rel} does not exist; use {"op": "create"} for a new file`,
      );
      continue;
    }
    const raw = before.toString('utf8');
    if (before.includes(0) || !Buffer.from(raw, 'utf8').equals(before)) {
      fail(
        first.index,
        op.path,
        'binary',
        `${rel} is binary or not valid UTF-8; it cannot be edited here`,
      );
      continue;
    }
    const bom = raw.startsWith(BOM);
    const body = bom ? raw.slice(1) : raw;
    const eol = detectEol(body);
    const text = eol === 'crlf' ? body.replaceAll('\r\n', '\n') : body;
    const norm = (s: string) => (eol === 'mixed' ? s : s.replaceAll('\r\n', '\n'));
    const ranges: { start: number; end: number; repl: string; index: number; path: string }[] = [];
    let fuzzy = 0;
    let bad = false;
    for (const { index, op: e } of list) {
      if (e.op !== 'replace') continue;
      const oldText = norm(e.old);
      const newText = norm(e.new);
      if (oldText === newText) {
        fail(index, e.path, 'no-op', `"old" and "new" are the same for ${rel}; leave the edit out`);
        bad = true;
        continue;
      }
      const at = locateReplace(text, oldText);
      if (!at.ok) {
        bad = true;
        if (at.kind === 'ambiguous')
          fail(
            index,
            e.path,
            'ambiguous',
            `"old" text matches ${String(at.count)} places in ${rel}; include more surrounding lines so it matches exactly once`,
          );
        else
          fail(
            index,
            e.path,
            'not-found',
            `"old" text was not found in ${rel}; copy it exactly from the current file (same indentation and blank lines)`,
          );
        continue;
      }
      if (at.fuzzy) fuzzy++;
      ranges.push({ start: at.start, end: at.end, repl: newText, index, path: e.path });
    }
    if (bad) continue;
    ranges.sort((a, b) => a.start - b.start);
    let overlap = false;
    for (let i = 1; i < ranges.length; i++) {
      const prev = ranges[i - 1];
      const cur = ranges[i];
      if (prev !== undefined && cur !== undefined && cur.start < prev.end) {
        fail(
          cur.index,
          cur.path,
          'overlap',
          `two "replace" edits on ${rel} change the same text; merge them into one`,
        );
        overlap = true;
      }
    }
    if (overlap) continue;
    let out = '';
    let pos = 0;
    for (const r of ranges) {
      out += text.slice(pos, r.start) + r.repl;
      pos = r.end;
    }
    out += text.slice(pos);
    if (eol === 'crlf') out = out.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
    if (bom) out = BOM + out;
    if (bytes(out) > API_EDIT_LIMITS.resultFileBytes) {
      fail(
        first.index,
        op.path,
        'too-large',
        `${rel} would be larger than ${kib(API_EDIT_LIMITS.resultFileBytes)}`,
      );
      continue;
    }
    if (out === raw) {
      unchanged.push(rel);
      continue;
    }
    writes.push({ rel, before, after: out, mode: 'replace', ops: ranges.length, fuzzy });
  }
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, writes, unchanged };
}

/** Model-facing text for a list of failures (the repair round and the findings). */
export function formatFailures(failures: readonly EditFailure[]): string[] {
  return failures.map((f) => `edit ${String(f.index + 1)} (${f.kind}): ${f.message}`);
}

/**
 * Write every planned file, or none. Each file goes to a temp file in its directory and is
 * renamed over the target; on any error the targets already renamed are restored from
 * `before` (or removed), temp files are deleted, and directories this call created are
 * removed. Never throws for a write error.
 */
export function applyPlan(
  root: string,
  writes: readonly PlannedWrite[],
): { ok: true; written: string[] } | { ok: false; error: string; restored: boolean } {
  // The worktree must still be what was planned against.
  for (const w of writes) {
    const abs = join(root, w.rel);
    let current: Buffer | null;
    try {
      const st = lstatSync(abs);
      current = st.isFile() ? readFileSync(abs) : Buffer.from('\0not a file');
    } catch {
      current = null;
    }
    const same = w.before === null ? current === null : (current?.equals(w.before) ?? false);
    if (!same) {
      return {
        ok: false,
        error: `${w.rel} changed on disk after the edits were checked; nothing was written`,
        restored: true,
      };
    }
  }
  const createdDirs: string[] = [];
  const renamed: PlannedWrite[] = [];
  const temps: string[] = [];
  const written: string[] = [];
  try {
    for (const w of writes) {
      const abs = join(root, w.rel);
      const dir = dirname(abs);
      const missing: string[] = [];
      for (let d = dir; !existsSync(d) && d !== root; d = dirname(d)) missing.push(d);
      mkdirSync(dir, { recursive: true });
      createdDirs.push(...missing); // deepest first within this file
      const tmp = join(dir, `.soot-tmp-${randomBytes(6).toString('hex')}`);
      writeFileSync(tmp, w.after, { flag: 'wx' });
      temps.push(tmp);
      if (w.before !== null) chmodSync(tmp, lstatSync(abs).mode & 0o7777);
      renameSync(tmp, abs);
      temps.pop();
      renamed.push(w);
      written.push(w.rel);
    }
    return { ok: true, written };
  } catch (e) {
    let restored = true;
    for (const t of temps) {
      try {
        unlinkSync(t);
      } catch {
        // already gone
      }
    }
    for (const w of renamed.reverse()) {
      const abs = join(root, w.rel);
      try {
        if (w.before === null) unlinkSync(abs);
        else writeFileSync(abs, w.before);
      } catch {
        restored = false;
      }
    }
    for (const d of [...createdDirs].sort((a, b) => b.length - a.length)) {
      try {
        rmdirSync(d);
      } catch {
        restored = false;
      }
    }
    return { ok: false, error: `writing the edits failed (${(e as Error).message})`, restored };
  }
}
