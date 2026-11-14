import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('page title reads HELLO WORLD', () => {
  const html = readFileSync('src/pages/index.html', 'utf8');
  assert.match(html, /<title>HELLO WORLD<\/title>/);
  assert.match(html, /<h1 id="title">HELLO WORLD<\/h1>/);
});
