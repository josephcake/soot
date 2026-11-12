import { readFileSync } from 'node:fs';

interface PackageManifest {
  name: string;
  version: string;
}

function isManifest(value: unknown): value is PackageManifest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.version === 'string';
}

function readManifest(): PackageManifest {
  // Both src/ (tests) and dist/ (build output) sit one level below the package root.
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (!isManifest(raw)) {
    throw new Error('@intelligent-agent-router/core: package.json is missing name or version');
  }
  return raw;
}

const manifest = readManifest();

/** npm package name of the core package, read from its package.json. */
export const PACKAGE_NAME: string = manifest.name;

/** Version of the core package, read from its package.json. */
export const PACKAGE_VERSION: string = manifest.version;
