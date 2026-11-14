import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/lib/paginate.js';

const items = [1, 2, 3, 4, 5, 6, 7];

test('page 1 is the first page', () => {
  assert.deepEqual(paginate(items, 1, 3), { items: [1, 2, 3], page: 1, pages: 3 });
});

test('the last partial page is counted and returned', () => {
  assert.deepEqual(paginate(items, 3, 3), { items: [7], page: 3, pages: 3 });
});

test('an exact multiple has no extra page', () => {
  assert.equal(paginate([1, 2, 3, 4], 2, 2).pages, 2);
  assert.deepEqual(paginate([1, 2, 3, 4], 2, 2).items, [3, 4]);
});

test('empty input has zero pages', () => {
  assert.deepEqual(paginate([], 1, 5), { items: [], page: 1, pages: 0 });
});
