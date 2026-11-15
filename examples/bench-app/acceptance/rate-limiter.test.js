import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/lib/rate-limiter.js';

const clock = (start = 0) => {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
};

test('allows a burst up to capacity, then refuses', () => {
  const c = clock();
  const rl = createRateLimiter({ capacity: 3, refillPerSecond: 1, now: c.now });
  assert.deepEqual(
    [rl.tryTake('a'), rl.tryTake('a'), rl.tryTake('a'), rl.tryTake('a')],
    [true, true, true, false],
  );
});

test('refills continuously and never above capacity', () => {
  const c = clock();
  const rl = createRateLimiter({ capacity: 2, refillPerSecond: 2, now: c.now });
  rl.tryTake('a');
  rl.tryTake('a');
  assert.equal(rl.tryTake('a'), false);
  c.advance(500);
  assert.equal(rl.tryTake('a'), true);
  assert.equal(rl.tryTake('a'), false);
  c.advance(60_000);
  assert.equal(rl.tryTake('a'), true);
  assert.equal(rl.tryTake('a'), true);
  assert.equal(rl.tryTake('a'), false);
});

test('keys are independent', () => {
  const c = clock();
  const rl = createRateLimiter({ capacity: 1, refillPerSecond: 1, now: c.now });
  assert.equal(rl.tryTake('a'), true);
  assert.equal(rl.tryTake('b'), true);
  assert.equal(rl.tryTake('a'), false);
});

test('takes a cost and reports when the next token is available', () => {
  const c = clock();
  const rl = createRateLimiter({ capacity: 4, refillPerSecond: 2, now: c.now });
  assert.equal(rl.tryTake('a', 3), true);
  assert.equal(rl.tryTake('a', 2), false);
  assert.equal(rl.retryAfterMs('a', 2), 500);
  assert.equal(rl.retryAfterMs('a', 1), 0);
});

test('rejects a cost above capacity and bad options', () => {
  const rl = createRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => 0 });
  assert.throws(() => rl.tryTake('a', 3), RangeError);
  assert.throws(() => createRateLimiter({ capacity: 0, refillPerSecond: 1 }), RangeError);
  assert.throws(() => createRateLimiter({ capacity: 1, refillPerSecond: 0 }), RangeError);
});
