import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/lib/duration.js';

test('parses single and combined units into seconds', () => {
  assert.equal(parseDuration('45s'), 45);
  assert.equal(parseDuration('2m'), 120);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('1d2h3m4s'), 93784);
});

test('rejects malformed input with a RangeError', () => {
  for (const bad of ['', '10', 'h', '1x', '1h1h', '30m1h', '-5s', '1.5h', ' 1h']) {
    assert.throws(() => parseDuration(bad), RangeError, JSON.stringify(bad));
  }
});

test('rejects non-strings with a TypeError', () => {
  assert.throws(() => parseDuration(5), TypeError);
});
