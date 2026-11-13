/**
 * Repository-level guards for Milestone 0. These fail if the monorepo drifts:
 * a package missing from the build graph, undocumented structure, secrets in
 * .env.example, or the local CI script diverging from the GitHub workflow.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const readJson = (path: string): unknown => JSON.parse(read(path));

interface Manifest {
  name: string;
  license: string;
  private: boolean;
  scripts: Record<string, string>;
  engines?: { node?: string };
}

const workspaceDirs = ['apps', 'packages'].flatMap((group) =>
  readdirSync(new URL(`${group}/`, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${group}/${entry.name}`),
);

describe('workspace packages', () => {
  const rootTsconfig = readJson('tsconfig.json') as { references: { path: string }[] };
  const referenced = new Set(rootTsconfig.references.map((ref) => ref.path.replace(/^\.\//, '')));

  it('finds the expected packages', () => {
    expect(workspaceDirs).toContain('packages/core');
    expect(workspaceDirs).toContain('apps/cli');
    expect(workspaceDirs.length).toBeGreaterThanOrEqual(13);
  });

  it.each(workspaceDirs)('%s is a buildable, testable, documented workspace package', (dir) => {
    const manifest = readJson(`${dir}/package.json`) as Manifest;
    const leaf = dir.split('/').at(-1) ?? '';
    // VS Code extension manifests cannot use npm scopes, so the extension is `soot-vscode`.
    expect(manifest.name).toBe(dir === 'apps/vscode-extension' ? 'soot-vscode' : `@soot/${leaf}`);
    expect(manifest.license).toBe('MIT');
    expect(manifest.private).toBe(true);
    expect(manifest.scripts.build).toBeDefined();
    expect(manifest.scripts.test).toBeDefined();
    expect(existsSync(new URL(`${dir}/tsconfig.json`, root))).toBe(true);
    expect(existsSync(new URL(`${dir}/README.md`, root))).toBe(true);
    expect(referenced.has(dir)).toBe(true);
  });

  it('every tsconfig reference points at a real package', () => {
    for (const ref of referenced) expect(workspaceDirs).toContain(ref);
  });
});

describe('documentation and tracking files', () => {
  const required = [
    'README.md',
    'LICENSE',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'docs/README.md',
    'docs/project/PROJECT_STATUS.md',
    'docs/project/ROADMAP.md',
    'docs/project/TASKS.md',
    'docs/decisions/DECISIONS.md',
    'docs/project/TECHNICAL_DEBT.md',
    'docs/project/FUTURE_FEATURES.md',
    'docs/guides/architecture.md',
    'docs/guides/configuration.md',
    'docs/guides/development.md',
    'docs/guides/installation.md',
    'docs/guides/model-routing.md',
    'docs/guides/providers.md',
    'docs/guides/security.md',
    'docs/specs/build-spec.md',
    'docs/specs/project-management.md',
  ];

  it.each(required)('%s exists', (path) => {
    expect(existsSync(new URL(path, root))).toBe(true);
  });

  it('LICENSE is MIT and matches the root package.json', () => {
    expect(read('LICENSE')).toMatch(/^MIT License\n/);
    expect(read('LICENSE')).toContain('Copyright (c) 2026 the soot authors');
    expect((readJson('package.json') as Manifest).license).toBe('MIT');
  });

  it('docs/guides/architecture.md documents every workspace package', () => {
    const architecture = read('docs/guides/architecture.md');
    for (const dir of workspaceDirs) expect(architecture).toContain(`${dir}/`);
  });
});

describe('environment configuration', () => {
  const example = read('.env.example');

  it('.env.example contains no secret values', () => {
    const secretAssignments = example
      .split('\n')
      .map((line) => line.replace(/^#\s*/, '').trim())
      .filter((line) => /^[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=/.test(line))
      .filter((line) => line.split('=').slice(1).join('=').trim() !== '');
    expect(secretAssignments).toEqual([]);
  });

  it('documents every SOOT_* variable in docs/guides/configuration.md', () => {
    const vars = [...example.matchAll(/^#?\s*(SOOT_[A-Z0-9_]+)=/gm)].map((m) => m[1]);
    expect(vars.length).toBeGreaterThan(0);
    const docs = read('docs/guides/configuration.md');
    for (const name of vars) expect(docs).toContain(name);
  });

  it('.gitignore keeps real env files, state, bundles, and local overrides out of git', () => {
    const gitignore = read('.gitignore').split('\n');
    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('.env.*');
    expect(gitignore).toContain('!.env.example');
    expect(gitignore).toContain('.soot/');
    expect(gitignore).toContain('*.bundle');
    expect(gitignore).toContain('*.local.json');
  });
});

describe('toolchain pins', () => {
  it('.nvmrc Node major satisfies the engines floor', () => {
    const manifest = readJson('package.json') as Manifest;
    const floor = /^>=(\d+)/.exec(manifest.engines?.node ?? '')?.[1];
    const pinned = /^(\d+)/.exec(read('.nvmrc').trim())?.[1];
    expect(floor).toBeDefined();
    expect(pinned).toBeDefined();
    expect(Number(pinned)).toBeGreaterThanOrEqual(Number(floor));
  });

  it('local CI script and GitHub workflow run the same checks', () => {
    const steps = ['typecheck', 'lint', 'format:check', 'test', 'build'];
    const local = read('scripts/ci.sh');
    const hosted = read('.github/workflows/ci.yml');
    expect(local).toContain('pnpm install --frozen-lockfile');
    expect(hosted).toContain('pnpm install --frozen-lockfile');
    for (const step of steps) {
      expect(local).toContain(`pnpm run ${step}`);
      expect(hosted).toContain(`pnpm run ${step}`);
    }
  });
});

describe('documentation links', () => {
  it('scripts/check-doc-links.mjs reports no broken relative links', () => {
    const result = spawnSync(process.execPath, ['scripts/check-doc-links.mjs'], {
      cwd: fileURLToPath(root),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
