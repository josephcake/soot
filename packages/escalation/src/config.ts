import { z } from 'zod';

/*
 * Configurable escalation thresholds, retry limits, and budgets (spec §6, M4-03). Defaults are
 * soot's choices (ADR-024), not measurements.
 */
export const EscalationConfigSchema = z
  .object({
    /** Hard cap on attempts per task, across retries, fallbacks, and escalations. */
    maxAttemptsPerTask: z.int().min(1).max(20),
    /** Hard cap on escalations (moves to a stronger model) per task. */
    maxEscalationsPerTask: z.int().min(0).max(5),
    /** Retries on the SAME model after a reported failure, invalid output, or crash. */
    sameModelRetries: z.int().min(0).max(5),
    /** Retries on the same model after a rate limit or timeout before falling back. */
    transientRetries: z.int().min(0).max(10),
    /** A success reporting confidence below this is not accepted. */
    minConfidence: z.number().min(0).max(1),
    /** This many tool errors in one attempt is an escalation trigger. */
    toolErrorLimit: z.int().min(1),
    /** Reported tokens above factor × the task's planned tokens is a "token blowup". */
    tokenBlowupFactor: z.number().min(1),
    backoff: z.object({ baseDelayMs: z.number().min(0), maxDelayMs: z.number().min(0) }).strict(),
    /** Per-task and per-run spend caps in USD (`null` = none). Spend = reported actual cost
     *  when the runtime reports one, else the attempt's routed estimate. */
    taskBudgetUsd: z.number().nonnegative().nullable(),
    runBudgetUsd: z.number().nonnegative().nullable(),
    downgrade: z
      .object({
        enabled: z.boolean(),
        /** Only switch to a cheaper model if it saves at least this share of the estimate. */
        minSavingsRatio: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();

export type EscalationConfig = z.infer<typeof EscalationConfigSchema>;

export const DEFAULT_ESCALATION_CONFIG: EscalationConfig = EscalationConfigSchema.parse({
  maxAttemptsPerTask: 5,
  maxEscalationsPerTask: 2,
  sameModelRetries: 1,
  transientRetries: 2,
  minConfidence: 0.6,
  toolErrorLimit: 3,
  tokenBlowupFactor: 3,
  backoff: { baseDelayMs: 1000, maxDelayMs: 30_000 },
  taskBudgetUsd: null,
  runBudgetUsd: null,
  downgrade: { enabled: true, minSavingsRatio: 0.3 },
});

export type EscalationConfigInput = Partial<Omit<EscalationConfig, 'backoff' | 'downgrade'>> & {
  readonly backoff?: Partial<EscalationConfig['backoff']>;
  readonly downgrade?: Partial<EscalationConfig['downgrade']>;
};

export function escalationConfig(input: EscalationConfigInput = {}): EscalationConfig {
  const d = DEFAULT_ESCALATION_CONFIG;
  return EscalationConfigSchema.parse({
    ...d,
    ...input,
    backoff: { ...d.backoff, ...input.backoff },
    downgrade: { ...d.downgrade, ...input.downgrade },
  });
}
