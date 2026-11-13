import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { CheckCommand, CommandPolicy } from '@soot/integrations';
import { z } from 'zod';

/*
 * Project configuration (`soot.config.json`, committed in the repository). It is the ONLY
 * source of check commands (agents never supply commands, ADR-025), so it is protected from
 * task edits automatically.
 */

export const CONFIG_FILE = 'soot.config.json';

const SafeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const CheckSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(['test', 'typecheck', 'lint', 'acceptance']),
    argv: z.array(z.string().min(1)).min(1),
    timeoutMs: z.number().int().positive().optional(),
    required: z.boolean().optional(),
  })
  .strict();

const RelativePath = z
  .string()
  .min(1)
  .refine((p) => !isAbsolute(p) && !p.split(/[\\/]/).includes('..'), {
    message: 'must be a relative path inside the repository',
  });

/** Env names that look like credentials are never passed to an agent process (ADR-022). */
const SECRET_LIKE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/**
 * A user-supplied ACP agent command (ADR-027). soot only runs what is configured here, and only
 * with `--agent acp`. Paths in `args` are passed verbatim; the process runs in the task's
 * worktree, so use absolute paths.
 */
export const AcpAgentConfigSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(4096)
      .refine((c) => !/[\n\r\0]/.test(c), 'one executable'),
    args: z.array(z.string().max(4096)).max(64).default([]),
    passEnv: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .refine((n) => !SECRET_LIKE.test(n), 'credential-like variables are never passed'),
      )
      .max(32)
      .default([]),
  })
  .strict();

/**
 * Optional model-backed decomposition (ADR-034). `model` is a model reference
 * (`provider/modelId`) from the user's own model registry file; soot names no vendor. Absent:
 * decomposition stays fixture-only. Present: recorded prompts still come from fixtures, and only
 * prompts without a fixture are sent to this model, and only when a client can be built for it
 * (callable provider, key variable set). Keys are never written here (ADR-022).
 */
export const DecomposerConfigSchema = z
  .object({
    model: z
      .string()
      .min(3)
      .max(512)
      .regex(
        /^[^/\s]+\/\S+$/,
        'must be a model reference "provider/modelId" from your models file',
      ),
  })
  .strict();

export const ProjectConfigSchema = z
  .object({
    version: z.literal(1),
    /** Registry config file (see docs/guides/configuration.md), relative to this file. */
    models: z.string().min(1),
    policy: z.enum(['economy', 'balanced', 'quality']).default('balanced'),
    /** Project checks soot runs for every task that changes files. */
    checks: z.array(CheckSchema).default([]),
    /** Extra acceptance commands per task id (also run for read-only tasks). */
    acceptance: z.record(SafeId, z.array(CheckSchema)).default({}),
    /** Paths no task may change, even inside its lease. */
    protectedPaths: z.array(RelativePath).default([]),
    /** Exact `argv[0]` values allowed to run. */
    allowedExecutables: z.array(z.string().min(1)).default([]),
    concurrency: z.number().int().min(1).max(16).default(4),
    attemptTimeoutMs: z.number().int().positive().optional(),
    /** Escalation limits and budgets (`@soot/escalation` EscalationConfig fields). */
    escalation: z.record(z.string(), z.unknown()).optional(),
    /** Extra recorded decompositions (JSON array of {id, prompt, tasks}), relative to this file. */
    fixtures: z.string().min(1).optional(),
    /** ACP agent to spawn for `--agent acp` (never used otherwise). */
    acpAgent: AcpAgentConfigSchema.optional(),
    /** Model for prompts with no recorded fixture (ADR-034). Absent: fixtures only. */
    decomposer: DecomposerConfigSchema.optional(),
  })
  .strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LoadedConfig {
  readonly path: string;
  readonly dir: string;
  readonly config: ProjectConfig;
  readonly modelsPath: string;
  readonly fixturesPath: string | null;
  readonly checks: readonly CheckCommand[];
  readonly acceptance: Readonly<Record<string, readonly CheckCommand[]>>;
  readonly policy: CommandPolicy;
}

const toCheck = (c: z.infer<typeof CheckSchema>): CheckCommand => ({
  name: c.name,
  kind: c.kind,
  argv: c.argv,
  ...(c.timeoutMs === undefined ? {} : { timeoutMs: c.timeoutMs }),
  ...(c.required === undefined ? {} : { required: c.required }),
});

export function loadProjectConfig(path: string): LoadedConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(
      code === 'ENOENT'
        ? `no soot config at ${path} (create ${CONFIG_FILE}; see docs/guides/installation.md)`
        : `cannot read ${path}: ${(error as Error).message}`,
    );
  }
  const parsed = ProjectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`invalid ${path}: ${issues}`);
  }
  const config = parsed.data;
  const dir = dirname(resolve(path));
  return {
    path: resolve(path),
    dir,
    config,
    modelsPath: resolve(dir, config.models),
    fixturesPath: config.fixtures === undefined ? null : resolve(dir, config.fixtures),
    checks: config.checks.map(toCheck),
    acceptance: Object.fromEntries(
      Object.entries(config.acceptance).map(([id, list]) => [id, list.map(toCheck)]),
    ),
    policy: { allowedExecutables: config.allowedExecutables },
  };
}

/** Repository-relative form of `path`, or `null` when it lies outside `root`. */
export function insideRepo(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}
