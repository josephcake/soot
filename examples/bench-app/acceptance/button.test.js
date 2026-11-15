import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('primary button is purple; secondary unchanged', () => {
  const css = readFileSync('src/styles/button.css', 'utf8');
  assert.match(css, /\.btn-primary\s*\{\s*background:\s*purple;/);
  assert.match(css, /\.btn-secondary\s*\{\s*background:\s*gray;/);
});
