import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { main, type CliIo } from './cli.js';
import { loadProjectConfig } from './config.js';
import {
  detectPackageManager,
  discoverChecks,
  formatInitResult,
  InitError,
  initConfig,
} from './init-config.js';

let dir = '';
afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const tmp = () => {
  dir = mkdtempSync(join(tmpdir(), 'soot-init-'));
  return dir;
};

const write = (root: string, rel: string, body: string) => {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
};

describe('detectPackageManager', () => {
  it('returns null without package.json, and prefers the lockfile that is present', () => {
    const root = tmp();
    expect(detectPackageManager(root)).toBeNull();
    write(root, 'package.json', '{}\n');
    expect(detectPackageManager(root)).toBe('npm');
    write(root, 'package-lock.json', '{}\n');
    expect(detectPackageManager(root)).toBe('npm');
    write(root, 'yarn.lock', '\n');
    expect(detectPackageManager(root)).toBe('yarn');
    write(root, 'pnpm-lock.yaml', '\n');
    expect(detectPackageManager(root)).toBe('pnpm');
  });
});

describe('discoverChecks', () => {
  it('maps package.json test, lint and typecheck scripts through the package manager', () => {
    const root = tmp();
    write(
      root,
      'package.json',
      JSON.stringify({
        scripts: { test: 'node --test', lint: 'eslint .', typecheck: 'tsc -b', build: 'tsc' },
      }),
    );
    write(root, 'pnpm-lock.yaml', '\n');
    const d = discoverChecks(root);
    expect(d.packageManager).toBe('pnpm');
    expect(d.checks.map((c) => [c.check.name, c.check.kind, c.check.argv, c.source])).toEqual([
      ['test', 'test', ['pnpm', 'test'], 'package.json script "test"'],
      ['lint', 'lint', ['pnpm', 'lint'], 'package.json script "lint"'],
      ['typecheck', 'typecheck', ['pnpm', 'typecheck'], 'package.json script "typecheck"'],
    ]);
  });

  it('accepts type-check as a typecheck script, and skips empty scripts', () => {
    const root = tmp();
    write(
      root,
      'package.json',
      JSON.stringify({ scripts: { 'type-check': 'tsc --noEmit', test: '  ' } }),
    );
    const d = discoverChecks(root);
    expect(d.checks.map((c) => c.check.name)).toEqual(['typecheck']);
    expect(d.checks[0]?.check.argv).toEqual(['npm', 'type-check']);
  });

  it('falls back to cargo test, go test or pytest when there is no test script', () => {
    const cargo = tmp();
    write(cargo, 'Cargo.toml', '[package]\nname = "x"\n');
    expect(discoverChecks(cargo).checks.map((c) => c.check.argv)).toEqual([['cargo', 'test']]);

    dir = '';
    const go = tmp();
    write(go, 'go.mod', 'module example.com/x\n');
    expect(discoverChecks(go).checks.map((c) => c.check.argv)).toEqual([['go', 'test', './...']]);

    dir = '';
    const py = tmp();
    write(py, 'pytest.ini', '[pytest]\n');
    expect(discoverChecks(py).checks.map((c) => [c.check.argv, c.source])).toEqual([
      [['python3', '-m', 'pytest'], 'pytest config'],
    ]);

    dir = '';
    const pyFiles = tmp();
    mkdirSync(join(pyFiles, 'tests'), { recursive: true });
    write(pyFiles, 'tests/test_add.py', 'def test_add():\n    assert True\n');
    expect(discoverChecks(pyFiles).checks[0]?.source).toBe('test_*.py files');
  });

  it('does not add language-marker tests when a package.json test script exists', () => {
    const root = tmp();
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    write(root, 'Cargo.toml', '[package]\nname = "x"\n');
    write(root, 'go.mod', 'module example.com/x\n');
    expect(discoverChecks(root).checks.map((c) => c.check.argv)).toEqual([['npm', 'test']]);
  });

  it('notes a tsconfig or eslint config that has no matching script, and an empty project', () => {
    const root = tmp();
    write(root, 'tsconfig.json', '{}\n');
    write(root, 'eslint.config.js', 'export default [];\n');
    const d = discoverChecks(root);
    expect(d.checks).toEqual([]);
    expect(d.notes.join('\n')).toMatch(/tsconfig\.json/);
    expect(d.notes.join('\n')).toMatch(/ESLint config/);
    expect(d.notes.join('\n')).toMatch(/no checks discovered/);
  });
});

describe('initConfig', () => {
  it('writes a valid soot.config.json, sets allowedExecutables, and omits decomposer by default', () => {
    const root = tmp();
    write(
      root,
      'package.json',
      JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }),
    );
    write(root, 'pnpm-lock.yaml', '\n');
    const result = initConfig({ root });
    expect(result.wrote).toBe(true);
    expect(result.path).toBe(join(root, 'soot.config.json'));
    const raw = JSON.parse(readFileSync(result.path, 'utf8')) as Record<string, unknown>;
    expect(raw).toEqual({
      version: 1,
      checks: [
        { name: 'test', kind: 'test', argv: ['pnpm', 'test'] },
        { name: 'lint', kind: 'lint', argv: ['pnpm', 'lint'] },
      ],
      allowedExecutables: ['pnpm'],
    });
    expect(raw).not.toHaveProperty('decomposer');
    const loaded = loadProjectConfig(result.path);
    expect(loaded.config.decomposer).toBeUndefined();
    expect(loaded.policy.allowedExecutables).toEqual(['pnpm']);
    expect(formatInitResult(result, root)).toMatch(/Decomposer: not set/);
  });

  it('writes decomposer only when asked, for auto or a model reference, and rejects a bad ref', () => {
    const root = tmp();
    write(root, 'package.json', '{}\n');
    const auto = initConfig({ root, decomposer: 'auto', force: true });
    expect(JSON.parse(readFileSync(auto.path, 'utf8'))).toMatchObject({
      decomposer: { model: 'auto' },
    });
    expect(formatInitResult(auto, root)).toMatch(/Decomposer: auto/);
    initConfig({ root, decomposer: 'deepseek/deepseek-flash', force: true });
    expect(JSON.parse(readFileSync(join(root, 'soot.config.json'), 'utf8'))).toMatchObject({
      decomposer: { model: 'deepseek/deepseek-flash' },
    });
    expect(() => initConfig({ root, decomposer: 'deepseek', force: true })).toThrow(InitError);
    expect(() => initConfig({ root, decomposer: 'not a model', force: true })).toThrow(
      /provider\/modelId/,
    );
  });

  it('refuses an existing file unless --force, and refuses a missing folder', () => {
    const root = tmp();
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    initConfig({ root });
    const first = readFileSync(join(root, 'soot.config.json'), 'utf8');
    expect(() => initConfig({ root })).toThrow(/already exists/);
    expect(readFileSync(join(root, 'soot.config.json'), 'utf8')).toBe(first);
    write(
      root,
      'package.json',
      JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }),
    );
    initConfig({ root, force: true });
    const again = JSON.parse(readFileSync(join(root, 'soot.config.json'), 'utf8')) as {
      checks: unknown[];
    };
    expect(again.checks).toHaveLength(2);
    expect(() => initConfig({ root: join(root, 'no-such') })).toThrow(/not a folder/);
  });

  it('never writes a key, and produces no decomposer field in the default file text', () => {
    const root = tmp();
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    const result = initConfig({ root });
    const text = readFileSync(result.path, 'utf8');
    expect(text).not.toMatch(/apiKey|API_KEY|sk-/);
    expect(text).not.toMatch(/decomposer/);
    expect(existsSync(join(root, 'models.json'))).toBe(false);
  });
});

function cli(cwd: string): { io: CliIo; out: { stdout: string; stderr: string } } {
  const out = { stdout: '', stderr: '' };
  const env: Record<string, string | undefined> = {
    HOME: cwd,
    PATH: process.env.PATH,
    SOOT_DATA_DIR: join(cwd, '.soot-state'),
    SOOT_LOG_LEVEL: 'silent',
  };
  return {
    out,
    io: {
      stdout: (text) => {
        out.stdout += text;
      },
      stderr: (text) => {
        out.stderr += text;
      },
      stdin: Readable.from([]),
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env,
      cwd,
    },
  };
}

describe('soot init (CLI)', () => {
  it('writes the file and --json omits decomposer by default; --decomposer is only for init', async () => {
    const root = tmp();
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    const { io, out } = cli(root);
    expect(await main(['init', '--json'], io)).toBe(0);
    const body = JSON.parse(out.stdout) as { ok: boolean; decomposer: string | null };
    expect(body.ok).toBe(true);
    expect(body.decomposer).toBeNull();
    expect(JSON.parse(readFileSync(join(root, 'soot.config.json'), 'utf8'))).not.toHaveProperty(
      'decomposer',
    );
    const again = cli(root);
    expect(await main(['models', '--decomposer', 'auto'], again.io)).toBe(1);
    expect(again.out.stderr).toMatch(/--decomposer is only for soot init/);
  });

  it('honours --repo and --decomposer auto', async () => {
    const root = tmp();
    const proj = join(root, 'app');
    mkdirSync(proj);
    write(proj, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    const { io, out } = cli(root);
    expect(await main(['init', '--repo', 'app', '--decomposer', 'auto', '--json'], io)).toBe(0);
    const body = JSON.parse(out.stdout) as { decomposer: string; path: string };
    expect(body.decomposer).toBe('auto');
    expect(body.path).toBe(join(proj, 'soot.config.json'));
  });
});
