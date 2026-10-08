import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter } from '../src/net/RateLimiter.js';

test('token bucket allows burst then refills over time', () => {
  let now = 0;
  const rl = new RateLimiter(10, 3, () => now);
  assert.ok(rl.tryConsume());
  assert.ok(rl.tryConsume());
  assert.ok(rl.tryConsume());
  assert.ok(!rl.tryConsume());
  now += 100; // 10/s -> 1 token per 100ms
  assert.ok(rl.tryConsume());
  assert.ok(!rl.tryConsume());
});
