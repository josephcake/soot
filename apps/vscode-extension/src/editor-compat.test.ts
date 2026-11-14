import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Invariants that keep one .vsix installable in VS Code and in VS Code-based editors (Cursor,
 * Windsurf) from a file or from Open VSX (M7-02…M7-04, ADR-070). These read package.json and
 * the source; they do not run any editor, so they do not show that the extension works there.
 */

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as Record<
  string,
  unknown
> & {
  name: string;
  publisher: string;
  version: string;
  type?: string;
  icon?: string;
  files: string[];
  engines: { vscode: string; node: string };
  devDependencies: Record<string, string>;
  contributes: Record<string, unknown> & {
    colors: { id: string; defaults: Record<string, string> }[];
  };
};

const sources = readdirSync(join(PKG_DIR, 'src'), { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('test-support'))
  .map((f) => ({ f, src: readFileSync(join(PKG_DIR, 'src', f), 'utf8') }));

const version = (v: string): [number, number] => {
  const m = /^\^?(\d+)\.(\d+)\.\d+$/.exec(v);
  if (m === null) throw new Error(`not a plain version: ${v}`);
  return [Number(m[1]), Number(m[2])];
};

/**
 * Every VS Code API the extension calls. All are stable (no proposed API) and type-check
 * against @types/vscode at the engines floor. Adding one here means checking it exists at the
 * floor in VS Code and in the editors the README lists.
 */
const USED_API = [
  'EventEmitter',
  'ExtensionContext',
  'ThemeColor',
  'ThemeIcon',
  'TreeDataProvider',
  'TreeItem',
  'TreeItemCollapsibleState.Expanded',
  'TreeItemCollapsibleState.None',
  'commands.registerCommand',
  'window.createOutputChannel',
  'window.registerTreeDataProvider',
  'window.showErrorMessage',
  'window.showInformationMessage',
  'window.showInputBox',
  'window.showQuickPick',
  'window.showTextDocument',
  'window.showWarningMessage',
  'workspace.getConfiguration',
  'workspace.openTextDocument',
  'workspace.workspaceFolders',
];

describe('engines floor', () => {
  it('is VS Code 1.100: the first release that loads ESM ("type": "module") extensions', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.engines.vscode).toBe('^1.100.0');
  });

  it('matches the pinned @types/vscode, so the type check rejects any newer API', () => {
    const types = pkg.devDependencies['@types/vscode'] ?? '';
    expect(types).toMatch(/^\d+\.\d+\.\d+$/); // exact pin, not a range
    expect(version(types)).toEqual(version(pkg.engines.vscode));
  });

  it('uses only the listed stable VS Code APIs, and no proposed API', () => {
    const used = new Set(
      sources.flatMap(({ src }) =>
        [...src.matchAll(/\bvscode\.([A-Za-z]+(?:\.[A-Za-z]+)?)/g)].map((m) => m[1] ?? ''),
      ),
    );
    expect([...used].sort()).toEqual([...USED_API].sort());
    expect(pkg).not.toHaveProperty('enabledApiProposals');
  });
});

describe('portable to VS Code-based editors and Open VSX', () => {
  it('has the manifest fields Open VSX and vsce read', () => {
    expect(pkg.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(pkg.publisher).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const k of ['displayName', 'description', 'license', 'repository', 'categories'])
      expect(pkg, k).toHaveProperty(k);
    expect(pkg).toHaveProperty('repository.url', 'https://github.com/josephcake/soot.git');
  });

  it('ships a 128×128 PNG icon listed in "files"', () => {
    expect(pkg.icon).toBe('media/icon.png');
    expect(pkg.files).toContain('media/icon.png');
    const png = readFileSync(join(PKG_DIR, 'media/icon.png'));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([128, 128]);
  });

  it('depends on no other extension and no runtime package', () => {
    expect(pkg).not.toHaveProperty('extensionDependencies');
    expect(pkg).not.toHaveProperty('extensionPack');
    expect(pkg).not.toHaveProperty('dependencies');
  });

  it('imports only `vscode`, Node built-ins and its own files', () => {
    for (const { f, src } of sources)
      for (const m of src.matchAll(/from '([^']+)'/g))
        expect(m[1], f).toMatch(/^(vscode|node:[a-z_/]+|\.\.?\/.+)$/);
  });

  it('contributes only standard contribution points', () => {
    expect(Object.keys(pkg.contributes).sort()).toEqual(
      ['colors', 'commands', 'configuration', 'menus', 'views'].sort(),
    );
  });
});

describe('run view colors (ADR-009 palette, ADR-070)', () => {
  const color = (id: string) => pkg.contributes.colors.find((c) => c.id === id)?.defaults;

  it('uses orange #ff7a1a and cream #e8dcc8 on dark themes, darker shades on light themes', () => {
    expect(color('soot.escalation')).toEqual({
      dark: '#ff7a1a',
      light: '#a84300',
      highContrast: '#ff7a1a',
      highContrastLight: '#a84300',
    });
    expect(color('soot.secondary')).toEqual({
      dark: '#e8dcc8',
      light: '#6b5a3e',
      highContrast: '#e8dcc8',
      highContrastLight: '#5a4a30',
    });
  });

  it('every light-theme color reads at WCAG AA (4.5:1) on white', () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const [r = 0, g = 0, b = 0] = c.map((x) =>
        x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const c of pkg.contributes.colors)
      for (const theme of ['light', 'highContrastLight'])
        expect(
          1.05 / (lum(c.defaults[theme] ?? '#ffffff') + 0.05),
          `${c.id} ${theme}`,
        ).toBeGreaterThan(4.5);
  });

  it('every ThemeColor the source uses is contributed', () => {
    const ext = sources.find((s) => s.f === 'extension.ts')?.src ?? '';
    const ids = [...ext.matchAll(/_COLOR = '([^']+)'/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(pkg.contributes.colors.map((c) => c.id).sort());
  });
});
