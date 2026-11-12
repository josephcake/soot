import type { Task } from '@soot/task-graph';
import type { DecompositionFixture } from './decomposer.js';

/*
 * Recorded decompositions of the example prompts in docs/specs/build-spec.md (§3 and §17).
 * They are hand-written expected outputs used as test data and as the Milestone 1 demo;
 * token estimates are illustrative placeholders, not measurements, and costs are unknown
 * (`null`) because no model is routed before Milestone 3.
 */

const estimate = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  costUsd: null,
});

const updatePageTitle: Task = {
  id: 'update-page-title',
  title: 'Update page title',
  instructions:
    'Locate the component that renders the page title and change the title text to "HELLO WORLD".',
  acceptanceCriteria: [
    'The rendered page title reads exactly "HELLO WORLD".',
    'No other page text changes.',
  ],
  requiredCapabilities: ['code-edit'],
  complexity: 'low',
  estimate: estimate(2000, 300),
  files: { read: ['src/pages/'], write: ['src/pages/index.html'] },
  dependsOn: [],
};

const updateButtonColor = (id: string, title: string): Task => ({
  id,
  title,
  instructions:
    'Locate the primary button styling and change its color to purple. Leave other button variants unchanged.',
  acceptanceCriteria: [
    'The primary button renders purple.',
    'Secondary and other button variants are unaffected.',
  ],
  requiredCapabilities: ['code-edit', 'css'],
  complexity: 'low',
  estimate: estimate(2500, 300),
  files: { read: ['src/styles/'], write: ['src/styles/button.css'] },
  dependsOn: [],
});

const investigateAuthBug = (fix: boolean): Task => ({
  id: 'verify-auth-bug',
  title: fix
    ? 'Verify the previous authentication bug is fixed'
    : 'Investigate the previous authentication bug',
  instructions:
    'Identify the previous authentication bug from issue history or supplied references, inspect the relevant ' +
    'implementation, reproduce the original issue if possible, run regression tests, and report whether it is resolved.',
  acceptanceCriteria: [
    'The referenced bug is identified, or the result states that it could not be identified.',
    'Regression tests for the bug were run and their outcome is reported as evidence.',
    'The result states clearly whether the bug is resolved.',
  ],
  requiredCapabilities: ['code-read', 'debugging', 'testing'],
  complexity: 'high',
  estimate: estimate(12000, 2000),
  files: { read: ['src/auth/', 'tests/auth/'], write: [] },
  dependsOn: [],
});

/** Build spec §3 example prompt: three tasks, all independent (A and B parallel; C too). */
export const SPEC_SECTION_3_FIXTURE: DecompositionFixture = {
  id: 'build-spec-3',
  prompt:
    'Change my page title to HELLO WORLD, update the primary button color to purple, and make sure the ' +
    'authentication bug from the previous issue has been fixed.',
  tasks: [
    updatePageTitle,
    updateButtonColor('update-button-color', 'Update button color'),
    investigateAuthBug(true),
  ],
};

/** Build spec §17 Test 1 — simple parallel changes: two independent tasks. */
export const SPEC_TEST_1_FIXTURE: DecompositionFixture = {
  id: 'build-spec-17-test-1',
  prompt: 'Change the page title to HELLO WORLD and update the primary button to purple.',
  tasks: [
    updatePageTitle,
    updateButtonColor('update-button-color', 'Update primary button to purple'),
  ],
};

/** Build spec §17 Test 2 — mixed complexity: three independent tasks of low/medium/high complexity. */
export const SPEC_TEST_2_FIXTURE: DecompositionFixture = {
  id: 'build-spec-17-test-2',
  prompt:
    'Change the button color to purple, add a reusable dropdown component, and investigate the previous ' +
    'authentication bug.',
  tasks: [
    updateButtonColor('update-button-color', 'Change button color to purple'),
    {
      id: 'add-dropdown-component',
      title: 'Add a reusable dropdown component',
      instructions:
        'Create a reusable, accessible dropdown component with keyboard support, export it, and add unit tests.',
      acceptanceCriteria: [
        'A Dropdown component is exported and renders a list of options.',
        'Keyboard navigation (arrow keys, Enter, Escape) works.',
        'Unit tests for the component pass.',
      ],
      requiredCapabilities: ['code-edit', 'react', 'testing'],
      complexity: 'medium',
      estimate: estimate(6000, 2500),
      files: {
        read: ['src/components/'],
        write: ['src/components/Dropdown.tsx', 'src/components/Dropdown.test.tsx'],
      },
      dependsOn: [],
    },
    investigateAuthBug(false),
  ],
};

/** Build spec §17 Test 4 — implement, test, review: tests and review depend on the implementation. */
export const SPEC_TEST_4_FIXTURE: DecompositionFixture = {
  id: 'build-spec-17-test-4',
  prompt: 'Implement a new feature, add tests, and review the implementation for security issues.',
  tasks: [
    {
      id: 'implement-feature',
      title: 'Implement the new feature',
      instructions: 'Implement the requested feature in the feature module.',
      acceptanceCriteria: ['The feature is implemented and the project builds.'],
      requiredCapabilities: ['code-edit'],
      complexity: 'medium',
      estimate: estimate(8000, 3000),
      files: { read: ['src/'], write: ['src/feature/'] },
      dependsOn: [],
    },
    {
      id: 'add-feature-tests',
      title: 'Add tests for the new feature',
      instructions: 'Write unit tests that cover the new feature, including edge cases.',
      acceptanceCriteria: ['Tests cover the feature and pass.'],
      requiredCapabilities: ['code-edit', 'testing'],
      complexity: 'low',
      estimate: estimate(5000, 2000),
      files: { read: ['src/feature/'], write: ['tests/feature/'] },
      dependsOn: ['implement-feature'],
    },
    {
      id: 'security-review',
      title: 'Review the implementation for security issues',
      instructions:
        'Review the new feature implementation for security issues and report findings.',
      acceptanceCriteria: [
        'Every finding cites the file it concerns.',
        'The review states its scope.',
      ],
      requiredCapabilities: ['code-read', 'security-review'],
      complexity: 'high',
      estimate: estimate(9000, 1500),
      files: { read: ['src/feature/'], write: [] },
      dependsOn: ['implement-feature'],
    },
  ],
};

/**
 * Build spec §17 Test 3 — runtime escalation: one task the planner believes is simple. The
 * escalation itself is scripted in tests (mock agents); this fixture is only the plan.
 */
export const SPEC_TEST_3_FIXTURE: DecompositionFixture = {
  id: 'build-spec-17-test-3',
  prompt: 'Update the theme color.',
  tasks: [
    {
      id: 'update-theme-color',
      title: 'Update theme color',
      instructions:
        'Change the primary theme color to the requested value wherever the theme defines it.',
      acceptanceCriteria: [
        'Components using the primary theme color render the new color.',
        'No unrelated theme tokens change.',
      ],
      requiredCapabilities: ['code-edit', 'css'],
      complexity: 'low',
      estimate: estimate(3000, 400),
      files: { read: ['src/theme/'], write: ['src/theme/tokens.css'] },
      dependsOn: [],
    },
  ],
};

export const SPEC_FIXTURES: readonly DecompositionFixture[] = [
  SPEC_SECTION_3_FIXTURE,
  SPEC_TEST_1_FIXTURE,
  SPEC_TEST_2_FIXTURE,
  SPEC_TEST_3_FIXTURE,
  SPEC_TEST_4_FIXTURE,
];
