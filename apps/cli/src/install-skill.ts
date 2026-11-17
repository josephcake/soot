import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Installs the universal skill (Agent Skills format) into each harness's discovery path under
 * a target directory: a project root by default. Only the directories listed here are
 * written, and an existing, different copy is never overwritten without --force.
 */

/** The skill's name and folder. Hosts that run skills by name offer it as `/soot` (ADR-058). */
export const SKILL_NAME = 'soot';

/**
 * Earlier names of the same skill (ADR-058). An old copy next to the new one would give the
 * host two soot skills, so installing removes one that is exactly what soot installed, and
 * keeps (and reports) one that was changed locally unless --force.
 */
export const LEGACY_SKILL_NAMES = ['universal-orchestrator'] as const;

/** Discovery paths, relative to the target directory (research §skills, ADR-026). */
export const SKILL_TARGETS = {
  agents: '.agents/skills',
  claude: '.claude/skills',
  grok: '.grok/skills',
} as const;

export type SkillTarget = keyof typeof SKILL_TARGETS;

export const DEFAULT_SKILL_SOURCE = fileURLToPath(
  new URL(`../../../skills/${SKILL_NAME}/`, import.meta.url),
);

export interface InstallSkillOptions {
  readonly target: string;
  readonly harnesses?: readonly SkillTarget[];
  readonly source?: string;
  readonly force?: boolean;
}

export interface InstallResult {
  readonly harness: SkillTarget;
  readonly path: string;
  readonly action: 'installed' | 'updated' | 'unchanged' | 'skipped-different';
  /** Old copies under an earlier name in the same skills folder, and what was done with them. */
  readonly legacy: readonly {
    readonly path: string;
    readonly action: 'removed' | 'kept-different';
  }[];
}

function files(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name), `${prefix}${e.name}/`)
      : e.isFile()
        ? [`${prefix}${e.name}`]
        : [],
  );
}

function sameTree(
  a: string,
  b: string,
  /** Rewrites a file of `a` before comparing (used to compare against an old skill name). */
  expected: (file: string, content: Buffer) => Buffer = (_f, c) => c,
): boolean {
  const fa = files(a).sort();
  const fb = files(b).sort();
  return (
    fa.length === fb.length &&
    fa.every(
      (f, i) =>
        f === fb[i] && expected(f, readFileSync(join(a, f))).equals(readFileSync(join(b, f))),
    )
  );
}

/** The source as soot installed it under `name`: identical apart from the `name:` line. */
const renamedTo =
  (name: string) =>
  (file: string, content: Buffer): Buffer =>
    file === 'SKILL.md'
      ? Buffer.from(content.toString('utf8').replace(/^name: .+$/m, `name: ${name}`), 'utf8')
      : content;

export function installSkill(options: InstallSkillOptions): InstallResult[] {
  const source = options.source ?? DEFAULT_SKILL_SOURCE;
  if (!existsSync(join(source, 'SKILL.md'))) throw new Error(`skill source not found: ${source}`);
  if (!existsSync(options.target) || !statSync(options.target).isDirectory()) {
    throw new Error(`target is not a directory: ${options.target}`);
  }
  const harnesses = options.harnesses ?? (Object.keys(SKILL_TARGETS) as SkillTarget[]);
  return harnesses.map((harness): InstallResult => {
    const dir = join(options.target, SKILL_TARGETS[harness]);
    const legacy: InstallResult['legacy'][number][] = [];
    for (const name of LEGACY_SKILL_NAMES) {
      const old = join(dir, name);
      if (!existsSync(old)) continue;
      if (options.force !== true && !sameTree(source, old, renamedTo(name))) {
        legacy.push({ path: old, action: 'kept-different' });
        continue;
      }
      rmSync(old, { recursive: true, force: true }); // only soot's own old skill folder
      legacy.push({ path: old, action: 'removed' });
    }
    const path = join(dir, SKILL_NAME);
    const exists = existsSync(path);
    if (exists && sameTree(source, path)) return { harness, path, action: 'unchanged', legacy };
    if (exists && options.force !== true) {
      return { harness, path, action: 'skipped-different', legacy };
    }
    if (exists) rmSync(path, { recursive: true, force: true }); // only our own skill folder
    cpSync(source, path, { recursive: true });
    return { harness, path, action: exists ? 'updated' : 'installed', legacy };
  });
}
