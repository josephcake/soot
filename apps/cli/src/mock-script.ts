import { readFileSync } from 'node:fs';
import type { MockAgentRunnerOptions, MockScript } from '@soot/agent-runtime';
import { z } from 'zod';

/*
 * Scripted mock agents for fixture runs (`soot run --agent mock --mock-script <file>`). This is
 * a TEST DOUBLE, labelled as such in every result ("[mock]"): no model is called. It exists so
 * the full workflow can be exercised locally without providers (M2-07 Blocked) or harness
 * runners (M6-04/05 are implemented as ACP profiles but tested against simulated adapters only).
 */

const ScriptSchema = z.looseObject({
  outcome: z
    .enum(['succeed', 'fail', 'block', 'throw', 'invalid', 'hang', 'provider-error'])
    .optional(),
  delayMs: z.number().int().min(0).max(600_000).optional(),
  summary: z.string().optional(),
  writes: z.record(z.string(), z.string().nullable()).optional(),
  usage: z
    .object({
      inputTokens: z.number().int().min(0).optional(),
      outputTokens: z.number().int().min(0).optional(),
      costUsd: z.number().min(0).nullable().optional(),
    })
    .optional(),
});

export const MockScriptFileSchema = z
  .object({
    version: z.literal(1),
    /** Free text shown in reports, e.g. which fixture this script belongs to. */
    label: z.string().optional(),
    tasks: z.record(z.string(), z.union([ScriptSchema, z.array(ScriptSchema).min(1)])),
    default: ScriptSchema.optional(),
  })
  .strict();

export function loadMockScript(path: string): MockAgentRunnerOptions {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read mock script ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const parsed = MockScriptFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `invalid mock script ${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  // Remaining fields (findings, signals, approval, error) are checked by the mock and by the
  // scheduler's result validation.
  return {
    scripts: parsed.data.tasks as Record<string, MockScript | MockScript[]>,
    ...(parsed.data.default === undefined
      ? {}
      : { defaultScript: parsed.data.default as MockScript }),
  };
}
