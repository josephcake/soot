import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { ProjectContext } from '@soot/planner';

/*
 * Bounded repository sketch for model-backed planning (ADR-056). The planner's intake
 * context is filled from the project: a file list, the package name and scripts, and a
 * README excerpt. Repository content is untrusted data; the decomposer fences it before
 * a model sees it.
 */

export const SKETCH_LIMITS = {
  /** Max paths listed in `context.files` (the intake schema allows 1000). */
  maxFiles: 200,
  /** Max directory depth for the walk fallback (git ls-files is unbounded then capped). */
  maxDepth: 4,
  /** README excerpt, in UTF-8 bytes, before it is put in `context.notes`. */
  maxReadmeBytes: 2000,
  /** Max characters of one package script body in the notes. */
  maxScriptBody: 200,
} as const;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'vendor',
  'target',
  'venv',
  '.venv',
  '__pycache__',
  '.tox',
  '.soot',
]);

const README_NAMES = ['README.md', 'README', 'README.txt', 'readme.md'] as const;

function isSafeRel(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || rel.includes('\\')) return false;
  const segs = rel.split('/');
  return segs.every(
    (seg, i, all) => (seg !== '' || i === all.length - 1) && seg !== '..' && seg !== '.',
  );
}

function firstSkipped(rel: string): boolean {
  return rel.split('/').some((seg) => SKIP_DIRS.has(seg));
}

function gitListedFiles(root: string): string[] | null {
  const result = spawnSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'buffer',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 3000,
  });
  if (result.status !== 0) return null;
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter((p) => p !== '' && isSafeRel(p) && !firstSkipped(p));
}

function walkFiles(root: string, dir: string, depth: number, acc: string[]): void {
  if (depth > SKETCH_LIMITS.maxDepth || acc.length >= SKETCH_LIMITS.maxFiles) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (acc.length >= SKETCH_LIMITS.maxFiles) return;
    if (SKIP_DIRS.has(e.name) || e.name === '.') continue;
    const abs = join(dir, e.name);
    const rel = relative(root, abs).split(sep).join('/');
    if (!isSafeRel(rel)) continue;
    if (e.isDirectory()) walkFiles(root, abs, depth + 1, acc);
    else if (e.isFile()) acc.push(rel);
  }
}

function readUtf8Prefix(path: string, maxBytes: number): string | null {
  try {
    const buf = readFileSync(path);
    const slice = buf.byteLength <= maxBytes ? buf : buf.subarray(0, maxBytes);
    return slice.toString('utf8');
  } catch {
    return null;
  }
}

function packageInfo(root: string): { name: string | null; scripts: Record<string, string> } {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return { name: null, scripts: {} };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { name: null, scripts: {} };
    }
    const rec = raw as { name?: unknown; scripts?: unknown };
    const name = typeof rec.name === 'string' && rec.name.trim() !== '' ? rec.name.trim() : null;
    const scripts: Record<string, string> = {};
    if (typeof rec.scripts === 'object' && rec.scripts !== null && !Array.isArray(rec.scripts)) {
      for (const [k, v] of Object.entries(rec.scripts)) {
        if (typeof v === 'string' && v.trim() !== '') {
          const body = v.trim();
          scripts[k] =
            body.length <= SKETCH_LIMITS.maxScriptBody
              ? body
              : `${body.slice(0, SKETCH_LIMITS.maxScriptBody)}…`;
        }
      }
    }
    return { name, scripts };
  } catch {
    return { name: null, scripts: {} };
  }
}

function folderName(root: string): string | null {
  const name = basename(root);
  if (name === '' || name === '.' || name.length > 200) return null;
  return name;
}

/**
 * Build a bounded `ProjectContext` for the planner. Never throws: a missing, unreadable or
 * non-git folder yields an empty context. Does not read secrets; only path names, package
 * script text and a README prefix are included.
 */
export function gatherRepoSketch(root: string): ProjectContext {
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return {};
    const listed = gitListedFiles(root);
    const files = (
      listed ??
      (() => {
        const acc: string[] = [];
        walkFiles(root, root, 0, acc);
        return acc;
      })()
    )
      .sort()
      .slice(0, SKETCH_LIMITS.maxFiles);

    const { name: pkgName, scripts } = packageInfo(root);
    const name = pkgName ?? folderName(root) ?? undefined;

    const noteParts: string[] = [];
    const scriptEntries = Object.entries(scripts);
    if (scriptEntries.length > 0) {
      noteParts.push('package scripts:');
      for (const [k, v] of scriptEntries) noteParts.push(`  ${k}: ${v}`);
    }
    const readmeName = README_NAMES.find((n) => existsSync(join(root, n)));
    if (readmeName !== undefined) {
      const excerpt = readUtf8Prefix(join(root, readmeName), SKETCH_LIMITS.maxReadmeBytes);
      if (excerpt !== null && excerpt.trim() !== '') {
        noteParts.push(`README (${readmeName} excerpt):`);
        noteParts.push(excerpt.trimEnd());
      }
    }
    let notes = noteParts.join('\n');
    if (notes.length > 8000) notes = `${notes.slice(0, 8000)}…`;

    const context: ProjectContext = {
      ...(name === undefined ? {} : { name }),
      ...(files.length === 0 ? {} : { files }),
      ...(notes === '' ? {} : { notes }),
    };
    return context;
  } catch {
    return {};
  }
}
