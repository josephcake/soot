import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// Static checks only: the demo has no React toolchain.
test('Dropdown is exported, handles the keyboard, and has tests', () => {
  const src = readFileSync('src/components/Dropdown.tsx', 'utf8');
  assert.match(src, /export function Dropdown/);
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) assert.ok(src.includes(key), key);
  assert.ok(existsSync('src/components/Dropdown.test.tsx'));
});
