/*
 * Fixture git repositories for Milestone 5 tests: a tiny TypeScript app with real checks
 * (node --test, tsc, a lint script) created in a temp directory per test. Git runs with an
 * isolated config (no global or system config) so the box's settings cannot leak in.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildTaskGraph, type Task } from '@soot/task-graph';
import type { CheckCommand, CommandPolicy } from './commands.js';

export const NODE = process.execPath;
const require = createRequire(import.meta.url);
export const TSC = require.resolve('typescript/bin/tsc');

export const FILES: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "fixture-app", "private": true, "type": "module" }\n',
  'tsconfig.json':
    '{ "compilerOptions": { "strict": true, "noEmit": true, "module": "nodenext", "target": "es2022", "allowImportingTsExtensions": true, "types": [] }, "include": ["src"] }\n',
  'src/title.ts': "export const PAGE_TITLE: string = 'Hello';\n",
  'src/button.ts':
    "export const PRIMARY_COLOR: string = 'blue';\nexport const SECONDARY_COLOR: string = 'gray';\n",
  'src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  'src/legacy.ts': "export const LEGACY = 'old';\n",
  'test/math.test.ts':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.ts';\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5);\n});\n",
  'acceptance/title.test.ts':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { PAGE_TITLE } from '../src/title.ts';\n\ntest('title is HELLO WORLD', () => {\n  assert.equal(PAGE_TITLE, 'HELLO WORLD');\n});\n",
  'acceptance/button.test.ts':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { PRIMARY_COLOR, SECONDARY_COLOR } from '../src/button.ts';\n\ntest('primary is purple, secondary unchanged', () => {\n  assert.equal(PRIMARY_COLOR, 'purple');\n  assert.equal(SECONDARY_COLOR, 'gray');\n});\n",
  'scripts/lint.mjs': [
    "import { readdirSync, readFileSync } from 'node:fs';",
    'const bad = [];',
    "for (const f of readdirSync('src')) {",
    "  const text = readFileSync(`src/${f}`, 'utf8');",
    '  if (/console\\.log|debugger/.test(text)) bad.push(f);',
    '}',
    "if (bad.length > 0) { console.error(`lint: forbidden statement in ${bad.join(', ')}`); process.exit(1); }",
    "console.log('lint: ok');",
    '',
  ].join('\n'),
  'README.md': '# fixture-app\n',
};

export interface FixtureRepo {
  readonly root: string;
  readonly dataDir: string;
  readonly gitEnv: NodeJS.ProcessEnv;
  readonly git: (...args: string[]) => string;
  readonly write: (path: string, content: string) => void;
  readonly dispose: () => void;
}

export function createFixtureRepo(files: Readonly<Record<string, string>> = FILES): FixtureRepo {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'soot-m5-')));
  const root = join(top, 'repo');
  const dataDir = join(top, 'data');
  mkdirSync(root);
  const emptyConfig = join(top, 'gitconfig');
  writeFileSync(emptyConfig, '');
  const gitEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: top,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture User',
    GIT_AUTHOR_EMAIL: 'user@fixture.test',
    GIT_COMMITTER_NAME: 'Fixture User',
    GIT_COMMITTER_EMAIL: 'user@fixture.test',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8' }).trim();
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  git('init', '--quiet', '-b', 'main');
  for (const [path, content] of Object.entries(files)) write(path, content);
  git('add', '--all');
  git('commit', '--quiet', '-m', 'fixture: initial commit');
  return {
    root,
    dataDir,
    gitEnv,
    git,
    write,
    dispose: () => {
      rmSync(top, { recursive: true, force: true });
    },
  };
}

export const POLICY: CommandPolicy = { allowedExecutables: [NODE] };

export const CHECKS: readonly CheckCommand[] = [
  { name: 'test', kind: 'test', argv: [NODE, '--test', 'test/**/*.test.ts'] },
  { name: 'typecheck', kind: 'typecheck', argv: [NODE, TSC, '-p', 'tsconfig.json'] },
  { name: 'lint', kind: 'lint', argv: [NODE, 'scripts/lint.mjs'] },
];

export const acceptance = (file: string): CheckCommand => ({
  name: `acceptance:${file}`,
  kind: 'acceptance',
  argv: [NODE, '--test', `acceptance/${file}`],
});

export function writeTask(id: string, write: string[], overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    instructions: `Do ${id}.`,
    acceptanceCriteria: [`${id} is done`],
    requiredCapabilities: ['code-edit'],
    complexity: 'low',
    estimate: { inputTokens: 2000, outputTokens: 300, costUsd: null },
    files: { read: [], write },
    dependsOn: [],
    ...overrides,
  };
}

export const graphOf = (...tasks: Task[]) => buildTaskGraph(tasks);
