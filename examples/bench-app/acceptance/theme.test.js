import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('--brand is renamed to --accent everywhere, values unchanged', () => {
  const css = readFileSync('src/styles/theme.css', 'utf8');
  assert.ok(!css.includes('--brand'), 'no --brand left');
  assert.match(css, /--accent:\s*#ff7a1a;/);
  assert.equal((css.match(/var\(--accent\)/g) ?? []).length, 2);
  assert.match(css, /--surface:\s*#111111;/);
  assert.match(css, /--text:\s*#e8dcc8;/);
});
