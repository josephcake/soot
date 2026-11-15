import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/lib/paginate.js';

test('paginate returns an object with items', () => {
  assert.ok(Array.isArray(paginate([1, 2, 3], 1, 2).items));
});
