import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { CONFIG_FILE, loadProjectConfig } from './config.js';

/*
 * The dashboard's project allowlist (ADR-038): the folders a `soot dashboard --agent …` page may
 * plan and run in. It lives in the user's state directory, `<dataDir>/dashboard.json` (mode
 * 0600), never in the repository, so a cloned repo cannot allow itself. Only the CLI writes it
 * (`soot dashboard allow|disallow <dir>`); the browser sends an opaque id that the server
 * resolves here, never a path.
 */

export const ALLOWLIST_FILE = 'dashboard.json';

const EntrySchema = z
  .object({
    path: z.string().min(1),
    label: z.string().min(1).max(200),
    addedAt: z.string(),
  })
  .strict();
const FileSchema = z.object({ version: z.literal(1), projects: z.array(EntrySchema) }).strict();

export type AllowedProject = z.infer<typeof EntrySchema>;

export const allowlistPath = (dataDir: string) => join(dataDir, ALLOWLIST_FILE);

/** Opaque, stable id for an allowed folder: a hash of its real path. */
export const projectId = (realPath: string) =>
  `p_${createHash('sha256').update(realPath).digest('hex').slice(0, 16)}`;

export function readAllowlist(dataDir: string): AllowedProject[] {
  const path = allowlistPath(dataDir);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${(error as Error).message})`, { cause: error });
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path}: not a soot dashboard allowlist`);
  return parsed.data.projects;
}

function writeAllowlist(dataDir: string, projects: readonly AllowedProject[]): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = allowlistPath(dataDir);
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Add a folder. It must exist and hold a loadable soot.config.json. Returns the entry. */
export function allowProject(dataDir: string, cwd: string, dir: string): AllowedProject {
  const abs = resolve(cwd, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`not a folder: ${abs}`);
  const real = realpathSync(abs);
  const configFile = join(real, CONFIG_FILE);
  if (!existsSync(configFile)) {
    throw new Error(`${real} has no ${CONFIG_FILE}; only soot projects can be allowed`);
  }
  loadProjectConfig(configFile); // throws a ConfigError with the reason
  const list = readAllowlist(dataDir);
  const existing = list.find((p) => p.path === real);
  if (existing !== undefined) return existing;
  const entry: AllowedProject = {
    path: real,
    label: basename(real) || real,
    addedAt: new Date().toISOString(),
  };
  writeAllowlist(dataDir, [...list, entry]);
  return entry;
}

/** Remove a folder (by path, real path, or id). Returns whether it was listed. */
export function disallowProject(dataDir: string, cwd: string, dir: string): boolean {
  const list = readAllowlist(dataDir);
  const abs = resolve(cwd, dir);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    // The folder may be gone; match the stored path as typed.
  }
  const next = list.filter((p) => p.path !== abs && p.path !== real && projectId(p.path) !== dir);
  if (next.length === list.length) return false;
  writeAllowlist(dataDir, next);
  return true;
}

/**
 * Resolve an id from the browser to an allowed folder. The stored path is re-resolved, and it
 * must still be the same real path (a folder swapped for a symlink elsewhere is refused).
 */
export function resolveProject(dataDir: string, id: string): AllowedProject | null {
  if (!/^p_[0-9a-f]{16}$/.test(id)) return null;
  const entry = readAllowlist(dataDir).find((p) => projectId(p.path) === id);
  if (entry === undefined) return null;
  try {
    if (realpathSync(entry.path) !== entry.path) return null;
  } catch {
    return null;
  }
  return entry;
}
