import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// One Vitest project per workspace package, plus repo-level tests in tests/.
const workspaceProjects = ['apps', 'packages'].flatMap((group) =>
  readdirSync(new URL(`./${group}/`, import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) =>
      existsSync(new URL(`./${group}/${entry.name}/package.json`, import.meta.url)),
    )
    .map((entry) => ({
      extends: true as const,
      test: {
        name: `@soot/${entry.name}`,
        root: `${repoRoot}${group}/${entry.name}`,
        include: ['src/**/*.test.ts'],
      },
    })),
);

export default defineConfig({
  resolve: {
    // Resolve workspace packages to source so tests never depend on a stale dist/.
    alias: [
      // The VS Code API exists only inside the editor; extension tests use a small fake.
      {
        find: /^vscode$/,
        replacement: `${repoRoot}apps/vscode-extension/src/test-support/fake-vscode.ts`,
      },
      {
        find: /^@soot\/(cli|dashboard)$/,
        replacement: `${repoRoot}apps/$1/src/index.ts`,
      },
      {
        find: /^@soot\/(.+)$/,
        replacement: `${repoRoot}packages/$1/src/index.ts`,
      },
    ],
  },
  test: {
    // Engines built with the default environment never probe this machine's local runtimes
    // (ADR-044); tests that cover probing use a fake server and opt in.
    env: { SOOT_LOCAL_MODELS: 'off' },
    projects: [
      ...workspaceProjects,
      {
        extends: true,
        test: { name: 'repo', root: repoRoot, include: ['tests/**/*.test.ts'] },
      },
    ],
  },
});
