import { z } from 'zod';

/** One problem found while validating untrusted input against a soot contract. */
export interface ValidationIssue {
  /** Dotted path to the offending value, e.g. `files.write.0`. Empty for the root. */
  readonly path: string;
  readonly message: string;
}

/** Thrown when input does not satisfy a soot contract (task, agent result, context, ...). */
export class ContractValidationError extends Error {
  readonly contract: string;
  readonly issues: readonly ValidationIssue[];

  constructor(contract: string, issues: readonly ValidationIssue[]) {
    const detail = issues.map((i) => `  - ${i.path === '' ? '(root)' : i.path}: ${i.message}`);
    super(`Invalid ${contract}:\n${detail.join('\n')}`);
    this.name = 'ContractValidationError';
    this.contract = contract;
    this.issues = issues;
  }
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/** Validate without throwing. */
export function safeValidate<T>(schema: z.ZodType<T>, input: unknown): ValidationResult<T> {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: toIssues(parsed.error) };
}

/** Validate and throw {@link ContractValidationError} listing every issue. */
export function validateOrThrow<T>(contract: string, schema: z.ZodType<T>, input: unknown): T {
  const result = safeValidate(schema, input);
  if (!result.ok) throw new ContractValidationError(contract, result.issues);
  return result.value;
}

/**
 * A project-relative POSIX path. Absolute paths, `..` segments, backslashes, and empty
 * segments are rejected so declared file sets can be compared reliably. A trailing `/`
 * declares a directory (it overlaps every path below it).
 */
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith('/'), 'must be relative to the project root, not absolute')
  .refine((p) => !p.includes('\\'), 'must use "/" separators')
  .refine(
    (p) =>
      p
        .split('/')
        .every(
          (seg, i, all) => (seg !== '' || i === all.length - 1) && seg !== '..' && seg !== '.',
        ),
    'must not contain empty, "." or ".." segments',
  );
