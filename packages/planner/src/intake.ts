import { createHash } from 'node:crypto';
import { RelativePathSchema, validateOrThrow } from '@soot/task-graph';
import { z } from 'zod';

/**
 * Project context supplied alongside the prompt by the host harness. Everything is optional;
 * nothing here is inferred. `references` point at prior issues, docs, or URLs the prompt
 * relies on (e.g. "the authentication bug from the previous issue").
 */
export const ProjectContextSchema = z
  .object({
    /** Human-readable project name. */
    name: z.string().min(1).max(200).optional(),
    /** Project-relative files the user or harness considers relevant. */
    files: z.array(RelativePathSchema).max(1000).optional(),
    references: z
      .array(
        z
          .object({
            kind: z.enum(['issue', 'doc', 'url', 'commit']),
            id: z.string().min(1).max(500),
            note: z.string().max(2000).optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    notes: z.string().max(8000).optional(),
  })
  .strict();

export type ProjectContext = z.infer<typeof ProjectContextSchema>;

export interface IntendedOutcome {
  readonly statement: string;
  /**
   * `user`: supplied explicitly by the caller. `prompt`: no separate statement was given,
   * so the outcome is the prompt itself (no interpretation is performed in Milestone 1).
   */
  readonly source: 'user' | 'prompt';
}

/** The immutable record of one user request. */
export interface PromptIntake {
  /** Exact original prompt. Never trimmed, normalized, or rewritten. */
  readonly originalPrompt: string;
  /** SHA-256 (hex) of the prompt's UTF-8 bytes; identifies the prompt byte-for-byte. */
  readonly promptSha256: string;
  readonly context: Readonly<ProjectContext>;
  readonly intendedOutcome: IntendedOutcome;
  /** ISO-8601 timestamp. */
  readonly receivedAt: string;
}

export interface PromptIntakeInput {
  /** The user's prompt, as a string or as raw UTF-8 bytes. */
  readonly prompt: string | Uint8Array;
  readonly context?: unknown;
  /** Optional explicit statement of what "done" looks like. */
  readonly intendedOutcome?: string;
  readonly now?: () => Date;
}

export class PromptIntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptIntakeError';
  }
}

const MAX_PROMPT_BYTES = 256 * 1024;

function decodePrompt(prompt: string | Uint8Array): string {
  if (typeof prompt === 'string') {
    // A string with lone surrogates has no UTF-8 form and could not round-trip.
    if (Buffer.from(prompt, 'utf8').toString('utf8') !== prompt) {
      throw new PromptIntakeError('prompt contains unpaired UTF-16 surrogates');
    }
    return prompt;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(prompt);
  } catch {
    throw new PromptIntakeError('prompt bytes are not valid UTF-8');
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Accept a prompt plus project context. The original prompt is preserved exactly (the
 * returned object is deep-frozen) so later stages and audits can always refer back to it.
 */
export function createPromptIntake(input: PromptIntakeInput): PromptIntake {
  const originalPrompt = decodePrompt(input.prompt);
  const bytes = Buffer.from(originalPrompt, 'utf8');
  if (originalPrompt.trim() === '') throw new PromptIntakeError('prompt must not be empty');
  if (bytes.byteLength > MAX_PROMPT_BYTES) {
    throw new PromptIntakeError(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  }
  const context = validateOrThrow('project context', ProjectContextSchema, input.context ?? {});
  const explicit = input.intendedOutcome?.trim();
  const intendedOutcome: IntendedOutcome =
    explicit === undefined || explicit === ''
      ? { statement: originalPrompt, source: 'prompt' }
      : { statement: explicit, source: 'user' };

  return deepFreeze({
    originalPrompt,
    promptSha256: createHash('sha256').update(bytes).digest('hex'),
    context,
    intendedOutcome,
    receivedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
}

/** UTF-8 bytes of the original prompt (for byte-for-byte comparison or storage). */
export function promptBytes(intake: PromptIntake): Uint8Array {
  return Buffer.from(intake.originalPrompt, 'utf8');
}
