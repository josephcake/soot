import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Installs the universal skill (Agent Skills format) into each harness's discovery path under
 * a target directory: a project root by default. Only the directories listed here are
 * written, and an existing, different copy is never overwritten without --force.
 */

export const SKILL_NAME = 'universal-orchestrator';

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

function sameTree(a: string, b: string): boolean {
  const fa = files(a).sort();
  const fb = files(b).sort();
  return (
    fa.length === fb.length &&
    fa.every((f, i) => f === fb[i] && readFileSync(join(a, f)).equals(readFileSync(join(b, f))))
  );
}

export function installSkill(options: InstallSkillOptions): InstallResult[] {
  const source = options.source ?? DEFAULT_SKILL_SOURCE;
  if (!existsSync(join(source, 'SKILL.md'))) throw new Error(`skill source not found: ${source}`);
  if (!existsSync(options.target) || !statSync(options.target).isDirectory()) {
    throw new Error(`target is not a directory: ${options.target}`);
  }
  const harnesses = options.harnesses ?? (Object.keys(SKILL_TARGETS) as SkillTarget[]);
  return harnesses.map((harness) => {
    const path = join(options.target, SKILL_TARGETS[harness], SKILL_NAME);
    const exists = existsSync(path);
    if (exists && sameTree(source, path)) return { harness, path, action: 'unchanged' };
    if (exists && options.force !== true) return { harness, path, action: 'skipped-different' };
    if (exists) rmSync(path, { recursive: true, force: true }); // only our own skill folder
    cpSync(source, path, { recursive: true });
    return { harness, path, action: exists ? 'updated' : 'installed' };
  });
}
