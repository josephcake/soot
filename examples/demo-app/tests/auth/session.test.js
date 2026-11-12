import test from 'node:test';
import assert from 'node:assert/strict';
import { isExpired } from '../../src/auth/session.js';

test('regression: a token is expired exactly at its expiry time', () => {
  assert.equal(isExpired({ expiresAt: 100 }, 100), true);
  assert.equal(isExpired({ expiresAt: 100 }, 99), false);
});
