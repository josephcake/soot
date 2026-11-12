import { z } from 'zod';
import { AgentResultSchema } from './result.js';
import { TaskSchema } from './task.js';

/**
 * JSON Schema (draft 2020-12) contracts generated from the runtime validators, so the two
 * can never drift. Committed copies live in `schema/*.schema.json` for non-TypeScript
 * consumers; a test fails if they are stale (regenerate with `pnpm run schema`).
 *
 * Note: cross-field refinements (no self-dependency, unique list items, non-whitespace
 * text, path segment rules) are enforced by `parseTask` / `parseAgentResult` only.
 */
export const TASK_JSON_SCHEMA_ID = 'https://soot.dev/schema/task.schema.json';
export const AGENT_RESULT_JSON_SCHEMA_ID = 'https://soot.dev/schema/agent-result.schema.json';

function generate(schema: z.ZodType, id: string, title: string): Record<string, unknown> {
  return { $id: id, title, ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) };
}

export function taskJsonSchema(): Record<string, unknown> {
  return generate(TaskSchema, TASK_JSON_SCHEMA_ID, 'soot task');
}

export function agentResultJsonSchema(): Record<string, unknown> {
  return generate(AgentResultSchema, AGENT_RESULT_JSON_SCHEMA_ID, 'soot agent result');
}
