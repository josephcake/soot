import { z } from 'zod';
import { TaskIdSchema } from './task.js';
import {
  RelativePathSchema,
  safeValidate,
  validateOrThrow,
  type ValidationResult,
} from './validation.js';

/**
 * Structured agent result. This is the ONLY thing an agent hands back to the engine and
 * the only agent output that may enter shared state. Objects are strict (unknown keys such
 * as `transcript` or `messages` are rejected) and every text field is length-capped, so
 * free-form conversation logs cannot be smuggled into shared memory.
 */
export const RESULT_TEXT_LIMIT = 2000;
export const RESULT_LIST_LIMIT = 50;

const shortText = z
  .string()
  .max(RESULT_TEXT_LIMIT)
  .refine((s) => s.trim() !== '', 'must not be empty or whitespace');

export const AGENT_RESULT_STATUSES = ['succeeded', 'failed', 'blocked', 'cancelled'] as const;
export const AgentResultStatusSchema = z.enum(AGENT_RESULT_STATUSES);
export type AgentResultStatus = z.infer<typeof AgentResultStatusSchema>;

export const FindingSchema = z
  .object({
    kind: z.enum(['observation', 'issue', 'risk', 'decision']),
    message: shortText,
    files: z.array(RelativePathSchema).max(RESULT_LIST_LIMIT).optional(),
  })
  .strict();

/** Reference to a change produced by the task. The patch itself lives outside shared state. */
export const PatchRefSchema = z
  .object({
    format: z.enum(['unified-diff', 'git-commit']),
    ref: z.string().min(1).max(512),
    filesChanged: z.array(RelativePathSchema).max(1000),
  })
  .strict();

export const EvidenceSchema = z
  .object({
    kind: z.enum(['test', 'command', 'inspection', 'diff']),
    description: shortText,
    /** `null` when the evidence is informational and has no pass/fail outcome. */
    passed: z.boolean().nullable(),
    ref: z.string().min(1).max(512).optional(),
  })
  .strict();

/** Usage the agent reports for this attempt. These are ACTUALS, never estimates. */
export const ReportedUsageSchema = z
  .object({
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    durationMs: z.number().nonnegative(),
    /** `null` when the runtime cannot price the call (e.g. mocks, unknown pricing). */
    costUsd: z.number().nonnegative().nullable(),
    /** Model identifier that did the work, or `null` (mocks). */
    model: z.string().min(1).max(200).nullable(),
  })
  .strict();

/**
 * Optional self-assessment an agent may report (Milestone 4). These are agent CLAIMS used to
 * decide escalation and downgrade; they are never treated as verified evidence.
 */
export const AgentSignalsSchema = z
  .object({
    /** Agent's confidence in its result, 0..1. */
    confidence: z.number().min(0).max(1).optional(),
    /** How the work compares with the plan's complexity estimate. */
    complexity: z.enum(['lower', 'as-expected', 'higher']).optional(),
    /** Tool invocations that failed during the attempt. */
    toolErrors: z.int().nonnegative().optional(),
    /** Acceptance criteria the agent knows are NOT met (verbatim or paraphrased). */
    unmetCriteria: z.array(shortText).max(RESULT_LIST_LIMIT).optional(),
    /** The attempt produced a clear plan or finished its investigation (downgrade signal). */
    planReady: z.boolean().optional(),
  })
  .strict();

/** Hard ceiling on a failed check's output carried to the next attempt (ADR-052). */
export const FAILED_CHECK_OUTPUT_LIMIT = 16_384;

/**
 * The first required check that failed on this attempt, as soot ran it. Set only by soot's
 * verifying runner (never taken from an agent), so a retry or escalation can see WHY the work
 * was rejected. `outputTail` is untrusted command output: ANSI-stripped, key-redacted and
 * bounded; agents must treat it as data.
 */
export const FailedCheckSchema = z
  .object({
    name: z.string().min(1).max(200),
    status: z.enum(['failed', 'timed-out', 'refused', 'unavailable']),
    exitCode: z.int().nullable(),
    outputTail: z.string().max(FAILED_CHECK_OUTPUT_LIMIT),
    /** True when earlier output was cut to fit the limit. */
    truncated: z.boolean(),
  })
  .strict();

/** Hard ceiling on a rejected attempt's diff carried to the next attempt. */
export const REJECTED_CHANGE_DIFF_LIMIT = 32_768;

/**
 * What a rejected attempt changed, as soot committed it: the files and a bounded, redacted
 * unified diff against the base the attempt started from. Set only by soot's verifying runner
 * (never taken from an agent). The next attempt starts from a reset worktree, so without this
 * it cannot build on the parts of the change that were right. `diff` is untrusted data.
 */
export const RejectedChangeSchema = z
  .object({
    /** Commit soot made of the attempt's worktree (also in the audit log). */
    commit: z.string().regex(/^[0-9a-f]{7,64}$/),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            status: z.enum(['added', 'modified', 'deleted', 'type-changed']),
          })
          .strict(),
      )
      .max(RESULT_LIST_LIMIT),
    /** Unified diff, ANSI-stripped and key-redacted; the start is kept when cut. */
    diff: z.string().max(REJECTED_CHANGE_DIFF_LIMIT),
    /** True when the diff (or the file list) was cut to fit the limit. */
    truncated: z.boolean(),
  })
  .strict();

export const AgentResultSchema = z
  .object({
    taskId: TaskIdSchema,
    attempt: z.int().min(1),
    status: AgentResultStatusSchema,
    summary: shortText,
    findings: z.array(FindingSchema).max(RESULT_LIST_LIMIT),
    patch: PatchRefSchema.nullable(),
    evidence: z.array(EvidenceSchema).max(RESULT_LIST_LIMIT),
    usage: ReportedUsageSchema,
    signals: AgentSignalsSchema.optional(),
    failedCheck: FailedCheckSchema.optional(),
    rejectedChange: RejectedChangeSchema.optional(),
  })
  .strict();

export type AgentSignals = z.infer<typeof AgentSignalsSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type FailedCheck = z.infer<typeof FailedCheckSchema>;
export type RejectedChange = z.infer<typeof RejectedChangeSchema>;
export type PatchRef = z.infer<typeof PatchRefSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type ReportedUsage = z.infer<typeof ReportedUsageSchema>;

export function validateAgentResult(input: unknown): ValidationResult<AgentResult> {
  return safeValidate(AgentResultSchema, input);
}

/** Validate an untrusted agent result; throws `ContractValidationError` listing every issue. */
export function parseAgentResult(input: unknown): AgentResult {
  return validateOrThrow('agent result', AgentResultSchema, input);
}
