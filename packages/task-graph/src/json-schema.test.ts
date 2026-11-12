import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentResultJsonSchema, taskJsonSchema } from './index.js';

const committed = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), 'utf8'));

describe('JSON Schema contracts (M1-01, M1-06)', () => {
  it('schema/task.schema.json matches the runtime validator (run `pnpm --filter @soot/task-graph run schema`)', () => {
    expect(committed('task.schema.json')).toEqual(taskJsonSchema());
  });

  it('schema/agent-result.schema.json matches the runtime validator', () => {
    expect(committed('agent-result.schema.json')).toEqual(agentResultJsonSchema());
  });

  it('task schema is strict and requires every contract field', () => {
    const schema = taskJsonSchema() as {
      required: string[];
      additionalProperties: boolean;
      $schema: string;
    };
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(
      [
        'acceptanceCriteria',
        'complexity',
        'dependsOn',
        'estimate',
        'files',
        'id',
        'instructions',
        'requiredCapabilities',
        'title',
      ].sort(),
    );
  });
});
