import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  CONFIG_FILE,
  DecomposerConfigSchema,
  ProjectConfigSchema,
  type ProjectConfig,
} from './config.js';
import type { CheckCommand } from '@soot/integrations';

/*
 * `soot init` (ADR-055): write a soot.config.json from what is already in the project.
 * Checks come from package.json scripts (test, lint, typecheck) and, if there is no test
 * script, from common language markers (pytest, go test, cargo test). The decomposer model
 * is never written unless the caller asked for one: no vendor default, no implicit model
 * (ADR-034). Keys are never written.
 */

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitError';
  }
}

const SCRIPT_CHECKS: readonly {
  readonly names: readonly string[];
  readonly kind: CheckCommand['kind'];
  readonly checkName: string;
}[] = [
  { names: ['test'], kind: 'test', checkName: 'test' },
  { names: ['lint'], kind: 'lint', checkName: 'lint' },
  {
    names: ['typecheck', 'type-check', 'types', 'typings'],
    kind: 'typecheck',
    checkName: 'typecheck',
  },
];

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

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface DiscoveredCheck {
  readonly check: CheckCommand;
  readonly source: string;
}

export interface InitDiscovery {
  readonly checks: readonly DiscoveredCheck[];
  readonly notes: readonly string[];
  readonly packageManager: PackageManager | null;
}

export interface InitConfigOptions {
  /** Directory to initialise (absolute or relative to cwd). */
  readonly root: string;
  /** Overwrite an existing soot.config.json. */
  readonly force?: boolean;
  /**
   * Optional decomposer model (`auto` or `provider/modelId`). Omitted: fixtures only, and
   * the field is not written. soot never invents a vendor or a model here.
   */
  readonly decomposer?: string;
}

export interface InitConfigResult {
  readonly path: string;
  readonly wrote: boolean;
  readonly config: ProjectConfig;
  readonly discovery: InitDiscovery;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Prefer the lockfile that is already in the project. */
export function detectPackageManager(root: string): PackageManager | null {
  if (!isFile(join(root, 'package.json'))) return null;
  if (isFile(join(root, 'pnpm-lock.yaml')) || isFile(join(root, 'pnpm-workspace.yaml')))
    return 'pnpm';
  if (isFile(join(root, 'yarn.lock'))) return 'yarn';
  if (isFile(join(root, 'bun.lock')) || isFile(join(root, 'bun.lockb'))) return 'bun';
  if (isFile(join(root, 'package-lock.json'))) return 'npm';
  return 'npm';
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) as unknown };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function packageScripts(root: string): { scripts: Record<string, string>; note: string | null } {
  const path = join(root, 'package.json');
  if (!isFile(path)) return { scripts: {}, note: null };
  const parsed = readJson(path);
  if (!parsed.ok) return { scripts: {}, note: `package.json could not be read (${parsed.error})` };
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return { scripts: {}, note: 'package.json is not an object' };
  }
  const raw = (parsed.value as { scripts?: unknown }).scripts;
  if (raw === undefined) return { scripts: {}, note: null };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { scripts: {}, note: 'package.json "scripts" is not an object' };
  }
  const scripts: Record<string, string> = {};
  for (const [name, cmd] of Object.entries(raw)) {
    if (typeof cmd === 'string' && cmd.trim() !== '') scripts[name] = cmd.trim();
  }
  return { scripts, note: null };
}

function hasPytestConfig(root: string): boolean {
  if (isFile(join(root, 'pytest.ini')) || isFile(join(root, 'conftest.py'))) return true;
  const pyproject = join(root, 'pyproject.toml');
  if (!isFile(pyproject)) return false;
  const text = readFileSync(pyproject, 'utf8');
  return text.includes('[tool.pytest');
}

function findPytestFiles(root: string, depth = 0, acc = 0): boolean {
  if (depth > 3 || acc > 200) return false;
  let seen = acc;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && /^test_.*\.py$/.test(e.name)) return true;
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
      seen += 1;
      if (findPytestFiles(join(root, e.name), depth + 1, seen)) return true;
    }
  }
  return false;
}

/** Discover project checks. Never invents a decomposer model or a key. */
export function discoverChecks(root: string): InitDiscovery {
  const notes: string[] = [];
  const checks: DiscoveredCheck[] = [];
  const packageManager = detectPackageManager(root);
  const { scripts, note } = packageScripts(root);
  if (note !== null) notes.push(note);

  if (packageManager !== null) {
    for (const spec of SCRIPT_CHECKS) {
      const scriptName = spec.names.find((n) => scripts[n] !== undefined);
      if (scriptName === undefined) continue;
      checks.push({
        check: { name: spec.checkName, kind: spec.kind, argv: [packageManager, scriptName] },
        source: `package.json script "${scriptName}"`,
      });
    }
  }

  const hasTest = checks.some((c) => c.check.kind === 'test');
  if (!hasTest) {
    if (isFile(join(root, 'Cargo.toml'))) {
      checks.push({
        check: { name: 'test', kind: 'test', argv: ['cargo', 'test'] },
        source: 'Cargo.toml',
      });
    } else if (isFile(join(root, 'go.mod'))) {
      checks.push({
        check: { name: 'test', kind: 'test', argv: ['go', 'test', './...'] },
        source: 'go.mod',
      });
    } else if (hasPytestConfig(root) || findPytestFiles(root)) {
      checks.push({
        check: { name: 'test', kind: 'test', argv: ['python3', '-m', 'pytest'] },
        source: hasPytestConfig(root) ? 'pytest config' : 'test_*.py files',
      });
    }
  }

  if (isFile(join(root, 'tsconfig.json')) && !checks.some((c) => c.check.kind === 'typecheck')) {
    notes.push('found tsconfig.json but no typecheck script; add one to include a typecheck');
  }
  if (
    (isFile(join(root, 'eslint.config.js')) ||
      isFile(join(root, 'eslint.config.mjs')) ||
      isFile(join(root, 'eslint.config.cjs')) ||
      isFile(join(root, 'eslint.config.ts'))) &&
    !checks.some((c) => c.check.kind === 'lint')
  ) {
    notes.push('found an ESLint config but no lint script; add one to include a lint check');
  }

  if (checks.length === 0) {
    notes.push(
      'no checks discovered; add a test command to soot.config.json so write tasks can be verified',
    );
  }

  return { checks, notes, packageManager };
}

function parseDecomposer(model: string): NonNullable<ProjectConfig['decomposer']> {
  const parsed = DecomposerConfigSchema.safeParse({ model: model.trim() });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join('; ');
    throw new InitError(
      `invalid --decomposer "${model}": must be "auto" or a model reference "provider/modelId" (${issues})`,
    );
  }
  return parsed.data;
}

/**
 * Build and write soot.config.json for `root`. Throws `InitError` when the folder is missing,
 * a config already exists and `force` is not set, or `--decomposer` is invalid.
 */
export function initConfig(options: InitConfigOptions): InitConfigResult {
  const root = resolve(options.root);
  if (!isDir(root)) throw new InitError(`not a folder: ${root}`);
  const path = join(root, CONFIG_FILE);
  if (isFile(path) && options.force !== true) {
    throw new InitError(`${path} already exists; pass --force to overwrite it`);
  }
  if (existsSync(path) && !isFile(path)) {
    throw new InitError(`${path} exists and is not a file`);
  }

  const discovery = discoverChecks(root);
  const allowedExecutables = [
    ...new Set(
      discovery.checks.map((c) => c.check.argv[0]).filter((c): c is string => c !== undefined),
    ),
  ];
  const raw: Record<string, unknown> = {
    version: 1,
    checks: discovery.checks.map((c) => ({
      name: c.check.name,
      kind: c.check.kind,
      argv: [...c.check.argv],
    })),
    allowedExecutables,
  };
  if (options.decomposer !== undefined) {
    raw.decomposer = parseDecomposer(options.decomposer);
  }

  const parsed = ProjectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new InitError(`generated config is invalid: ${issues}`);
  }

  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o644 });
  return { path, wrote: true, config: parsed.data, discovery };
}

/** Human-readable summary for `soot init`. Paths are repo-relative when possible. */
export function formatInitResult(result: InitConfigResult, cwd: string): string {
  const rel = relative(cwd, result.path);
  const shown =
    rel === '' || rel.startsWith('..') || rel.split(sep).includes('..') ? result.path : rel;
  const lines = [`Wrote ${shown}.`];
  if (result.discovery.checks.length === 0) {
    lines.push('No checks were discovered.');
  } else {
    lines.push('Checks:');
    for (const c of result.discovery.checks) {
      lines.push(`- ${c.check.name} (${c.check.kind}): ${c.check.argv.join(' ')}  [${c.source}]`);
    }
  }
  if (result.config.decomposer === undefined) {
    lines.push(
      'Decomposer: not set (recorded fixtures only). Pass --decomposer auto or --decomposer provider/modelId to plan other prompts.',
    );
  } else {
    lines.push(`Decomposer: ${result.config.decomposer.model} (opt-in; not a soot default).`);
  }
  for (const note of result.discovery.notes) lines.push(`Note: ${note}`);
  return lines.join('\n');
}
