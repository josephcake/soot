import { buildTaskGraph, parseTask, type Task, type TaskGraph } from '@soot/task-graph';
import type { PromptIntake } from './intake.js';

/** Where a decomposition came from. Only `fixture` exists in Milestone 1. */
export type DecomposerKind = 'fixture';

export interface Decomposition {
  /** SHA-256 of the prompt this decomposition is for. */
  readonly promptSha256: string;
  readonly tasks: readonly Task[];
  /** The validated dependency graph built from `tasks`. */
  readonly graph: TaskGraph;
  readonly decomposer: { readonly kind: DecomposerKind; readonly fixtureId: string };
}

/**
 * Turns one prompt into tasks. Implementations must return tasks that pass `parseTask` and
 * form a valid graph. An LLM-backed implementation is planned after Milestone 2.
 */
export interface Decomposer {
  readonly kind: DecomposerKind;
  decompose(intake: PromptIntake): Promise<Decomposition>;
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
        'and does not analyze prompts; real decomposition arrives after Milestone 2.',
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
 * It exists so the rest of the engine can be built and tested before any model is wired in.
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

  decompose(intake: PromptIntake): Promise<Decomposition> {
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
