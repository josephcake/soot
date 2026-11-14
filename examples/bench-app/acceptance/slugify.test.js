import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/feature/slugify.js';

test('lowercases and joins words with hyphens', () => {
  assert.equal(slugify('Hello World!'), 'hello-world');
});

test('collapses separators and trims hyphens', () => {
  assert.equal(slugify('  --Soot   is__fast--  '), 'soot-is-fast');
});

test('strips accents', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
});

test('keeps digits and returns empty for no word characters', () => {
  assert.equal(slugify('Top 10 tips'), 'top-10-tips');
  assert.equal(slugify('!!!'), '');
});
