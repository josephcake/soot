// Regenerates schema/*.schema.json from the built runtime validators.
// Usage: pnpm --filter @soot/task-graph run schema
import { writeFileSync } from 'node:fs';
import { agentResultJsonSchema, taskJsonSchema } from '../dist/index.js';

const write = (name, schema) =>
  writeFileSync(
    new URL(`../schema/${name}`, import.meta.url),
    `${JSON.stringify(schema, null, 2)}\n`,
  );

write('task.schema.json', taskJsonSchema());
write('agent-result.schema.json', agentResultJsonSchema());
