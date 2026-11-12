import { z } from 'zod';
import {
  RelativePathSchema,
  safeValidate,
  validateOrThrow,
  type ValidationResult,
} from './validation.js';

/** Task ids are short, stable, kebab-case slugs, e.g. `update-page-title`. */
export const TaskIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'must be 1-64 chars of lowercase letters, digits, or "-"');

/**
 * A capability a model must have to do the task, e.g. `code-edit`, `css`, `debugging`.
 * Kept as an open kebab-case vocabulary so routing (M3) can grow it without a schema change.
 */
export const CapabilitySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,47}$/, 'must be a kebab-case capability name');

export const COMPLEXITY_LEVELS = ['low', 'medium', 'high'] as const;
export const ComplexitySchema = z.enum(COMPLEXITY_LEVELS);
export type Complexity = z.infer<typeof ComplexitySchema>;

const nonEmptyText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim() !== '', 'must not be empty or whitespace');

const uniqueStrings = (values: readonly string[]) => new Set(values).size === values.length;

/**
 * Planner-side estimate made before any model is chosen. `costUsd` is `null` until a
 * model is routed (M3); it is never filled with an actual figure.
 */
export const TaskEstimateSchema = z
  .object({
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    costUsd: z.number().nonnegative().nullable(),
  })
  .strict();

/** Files the task expects to read and to write. Used for conflict detection. */
export const TaskFilesSchema = z
  .object({
    read: z.array(RelativePathSchema).refine(uniqueStrings, 'must not contain duplicates'),
    write: z.array(RelativePathSchema).refine(uniqueStrings, 'must not contain duplicates'),
  })
  .strict();

/** The unit of work the engine plans, schedules, routes, and verifies. */
export const TaskSchema = z
  .object({
    id: TaskIdSchema,
    title: nonEmptyText(200),
    instructions: nonEmptyText(8000),
    acceptanceCriteria: z
      .array(nonEmptyText(1000))
      .min(1, 'at least one acceptance criterion is required'),
    requiredCapabilities: z
      .array(CapabilitySchema)
      .min(1, 'at least one required capability is required')
      .refine(uniqueStrings, 'must not contain duplicates'),
    complexity: ComplexitySchema,
    estimate: TaskEstimateSchema,
    files: TaskFilesSchema,
    dependsOn: z.array(TaskIdSchema).refine(uniqueStrings, 'must not contain duplicates'),
  })
  .strict()
  .refine((task) => !task.dependsOn.includes(task.id), {
    message: 'a task must not depend on itself',
    path: ['dependsOn'],
  });

export type Task = z.infer<typeof TaskSchema>;
export type TaskEstimate = z.infer<typeof TaskEstimateSchema>;
export type TaskFiles = z.infer<typeof TaskFilesSchema>;

/** Validate an untrusted task without throwing. */
export function validateTask(input: unknown): ValidationResult<Task> {
  return safeValidate(TaskSchema, input);
}

/** Validate an untrusted task; throws `ContractValidationError` listing every issue. */
export function parseTask(input: unknown): Task {
  return validateOrThrow('task', TaskSchema, input);
}
