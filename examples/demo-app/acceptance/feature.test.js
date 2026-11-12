import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/feature/slugify.js';

test('the feature is implemented', () => {
  assert.equal(slugify('Hello World!'), 'hello-world');
});
