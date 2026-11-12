import { describe, expect, it } from 'vitest';
import {
  FixtureDecomposer,
  NoFixtureError,
  SPEC_FIXTURES,
  SPEC_SECTION_3_FIXTURE,
  createPromptIntake,
  type Decomposition,
} from './index.js';

const decomposer = new FixtureDecomposer(SPEC_FIXTURES);
const decompose = (prompt: string): Promise<Decomposition> =>
  decomposer.decompose(createPromptIntake({ prompt }));

describe('fixture decomposer (M1-03)', () => {
  it('is labeled as a fixture decomposer, not a model', () => {
    expect(decomposer.kind).toBe('fixture');
  });

  it('spec §3 prompt -> title, button, auth-verification tasks, all independent', async () => {
    const result = await decompose(
      'Change my page title to HELLO WORLD, update the primary button color to purple, and make sure the authentication bug from the previous issue has been fixed.',
    );
    expect(result.decomposer).toEqual({ kind: 'fixture', fixtureId: 'build-spec-3' });
    expect(result.tasks.map((t) => [t.id, t.complexity])).toEqual([
      ['update-page-title', 'low'],
      ['update-button-color', 'low'],
      ['verify-auth-bug', 'high'],
    ]);
    expect(result.graph.layers).toEqual([
      ['update-page-title', 'update-button-color', 'verify-auth-bug'],
    ]);
    expect(result.graph.conflicts).toEqual([]);
  });

  it('spec §17 Test 1 prompt -> two separate, concurrent-safe tasks', async () => {
    const result = await decompose(
      'Change the page title to HELLO WORLD and update the primary button to purple.',
    );
    expect(result.tasks.map((t) => t.id)).toEqual(['update-page-title', 'update-button-color']);
    expect(result.graph.layers).toEqual([['update-page-title', 'update-button-color']]);
    expect(result.tasks.every((t) => t.complexity === 'low')).toBe(true);
  });

  it('spec §17 Test 2 prompt -> low / medium / high complexity tasks that can run together', async () => {
    const result = await decompose(
      'Change the button color to purple, add a reusable dropdown component, and investigate the previous authentication bug.',
    );
    expect(result.tasks.map((t) => [t.id, t.complexity])).toEqual([
      ['update-button-color', 'low'],
      ['add-dropdown-component', 'medium'],
      ['verify-auth-bug', 'high'],
    ]);
    expect(result.graph.layers).toHaveLength(1);
  });

  it('spec §17 Test 4 prompt -> tests and review depend on the implementation', async () => {
    const result = await decompose(
      'Implement a new feature, add tests, and review the implementation for security issues.',
    );
    expect(result.graph.layers).toEqual([
      ['implement-feature'],
      ['add-feature-tests', 'security-review'],
    ]);
    expect(result.graph.prerequisites.get('security-review')).toEqual(['implement-feature']);
  });

  it('matches regardless of case, whitespace, and a trailing period, but keeps the original prompt', async () => {
    const prompt =
      '  change THE page title to hello world   and update the primary button to purple ';
    const intake = createPromptIntake({ prompt });
    const result = await decomposer.decompose(intake);
    expect(result.decomposer.fixtureId).toBe('build-spec-17-test-1');
    expect(result.promptSha256).toBe(intake.promptSha256);
    expect(intake.originalPrompt).toBe(prompt);
  });

  it('refuses prompts it has no fixture for instead of guessing', async () => {
    await expect(decompose('Rewrite the backend in Rust.')).rejects.toBeInstanceOf(NoFixtureError);
  });

  it('is deterministic', async () => {
    const a = await decompose(SPEC_SECTION_3_FIXTURE.prompt);
    const b = await decompose(SPEC_SECTION_3_FIXTURE.prompt);
    expect(a.tasks).toEqual(b.tasks);
    expect(a.graph.layers).toEqual(b.graph.layers);
  });

  it('rejects invalid or duplicate fixtures at construction', () => {
    expect(
      () => new FixtureDecomposer([{ id: 'bad', prompt: 'x', tasks: [{ id: 'nope' }] }]),
    ).toThrow(/Invalid task/);
    expect(
      () =>
        new FixtureDecomposer([SPEC_SECTION_3_FIXTURE, { ...SPEC_SECTION_3_FIXTURE, id: 'dup' }]),
    ).toThrow(/Duplicate fixture/);
  });
});
