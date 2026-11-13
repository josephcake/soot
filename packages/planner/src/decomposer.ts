import { buildTaskGraph, parseTask, type Task, type TaskGraph } from '@soot/task-graph';
import type { PromptIntake } from './intake.js';

/**
 * Which implementation a decomposer is. `fixture-then-model` answers recorded prompts from
 * fixtures and asks its model only for the rest (see `createDecomposer`).
 */
export type DecomposerKind = 'fixture' | 'model' | 'fixture-then-model';

/** A decomposition taken from a recorded fixture. */
export interface FixtureDecompositionSource {
  readonly kind: 'fixture';
  readonly fixtureId: string;
}

/** Token usage the model reported for a decomposition. `null` = not reported. */
export interface DecompositionUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** A decomposition a model proposed and soot validated. */
export interface ModelDecompositionSource {
  readonly kind: 'model';
  /** soot model reference `provider/modelId` that was asked. */
  readonly modelRef: string;
  /** Model id the provider says served the request, or `null`. */
  readonly servedModelId: string | null;
  readonly usage: DecompositionUsage;
  /** Model calls made, including retries (>= 1). */
  readonly attempts: number;
}

/** Where one decomposition came from. */
export type DecompositionSource = FixtureDecompositionSource | ModelDecompositionSource;

export interface Decomposition<S extends DecompositionSource = DecompositionSource> {
  /** SHA-256 of the prompt this decomposition is for. */
  readonly promptSha256: string;
  readonly tasks: readonly Task[];
  /** The validated dependency graph built from `tasks`. */
  readonly graph: TaskGraph;
  readonly decomposer: S;
}

/**
 * Turns one prompt into tasks. Implementations must return tasks that pass `parseTask` and
 * form a valid graph (`buildTaskGraph`), whatever produced them.
 */
export interface Decomposer {
  readonly kind: DecomposerKind;
  decompose(intake: PromptIntake, signal?: AbortSignal): Promise<Decomposition>;
}

/** A recorded decomposition for one known prompt. */
export interface DecompositionFixture {
  readonly id: string;
  /** Prompt the fixture answers. Matched after whitespace/case normalization. */
  readonly prompt: string;
  readonly tasks: readonly unknown[];
}

export class NoFixtureError extends Error {
  readonly promptSha256: string;
  constructor(promptSha256: string) {
    super(
      'No decomposition fixture matches this prompt. The fixture decomposer is deterministic ' +
        'and does not analyze prompts. Model-backed decomposition needs a configured model client.',
    );
    this.name = 'NoFixtureError';
    this.promptSha256 = promptSha256;
  }
}

/** Lowercase, collapse whitespace, and drop a trailing period. Matching key only. */
export function normalizePromptForMatching(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase();
}

/**
 * Deterministic decomposer backed by recorded fixtures. It performs NO language
 * understanding: a prompt either matches a fixture or `decompose` throws `NoFixtureError`.
 * It never calls a model and is the default whenever no model client is configured.
 */
export class FixtureDecomposer implements Decomposer {
  readonly kind = 'fixture' as const;
  readonly #fixtures = new Map<string, DecompositionFixture>();

  constructor(fixtures: readonly DecompositionFixture[]) {
    for (const fixture of fixtures) {
      const key = normalizePromptForMatching(fixture.prompt);
      if (this.#fixtures.has(key)) throw new Error(`Duplicate fixture prompt: "${fixture.id}"`);
      // Fail fast on bad fixtures: every task must be valid and the graph must build.
      buildTaskGraph(fixture.tasks);
      this.#fixtures.set(key, fixture);
    }
  }

  decompose(intake: PromptIntake): Promise<Decomposition<FixtureDecompositionSource>> {
    const fixture = this.#fixtures.get(normalizePromptForMatching(intake.originalPrompt));
    if (!fixture) return Promise.reject(new NoFixtureError(intake.promptSha256));
    const tasks = fixture.tasks.map(parseTask);
    return Promise.resolve({
      promptSha256: intake.promptSha256,
      tasks,
      graph: buildTaskGraph(tasks),
      decomposer: { kind: this.kind, fixtureId: fixture.id },
    });
  }
}
