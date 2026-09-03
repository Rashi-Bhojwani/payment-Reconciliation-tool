import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/lib/rateLimiter.js';

test('a burst of calls within capacity runs immediately', async () => {
  const limiter = new RateLimiter({ op: { ratePerSecond: 100, burst: 5 } });
  const start = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => limiter.schedule('acct-1', 'op', async () => null)));
  assert.ok(Date.now() - start < 100, 'burst within capacity should not wait');
});

test('calls beyond burst capacity are serialised, not dropped or run concurrently', async () => {
  // 10 tokens/sec, burst 1: the 2nd call must wait ~100ms for a fresh token.
  const limiter = new RateLimiter({ op: { ratePerSecond: 10, burst: 1 } });
  const order = [];
  const first = limiter.schedule('acct-1', 'op', async () => order.push('first'));
  const second = limiter.schedule('acct-1', 'op', async () => order.push('second'));
  const start = Date.now();
  await Promise.all([first, second]);
  const elapsed = Date.now() - start;
  assert.deepEqual(order, ['first', 'second']);
  assert.ok(elapsed >= 80, `second call should have waited for a token (waited ${elapsed}ms)`);
});

test('different keys are independent — one seller cannot exhaust another\'s bucket', async () => {
  const limiter = new RateLimiter({ op: { ratePerSecond: 1, burst: 1 } });
  await limiter.schedule('seller-a', 'op', async () => null); // exhausts seller-a's single token
  const start = Date.now();
  await limiter.schedule('seller-b', 'op', async () => null); // seller-b has its own fresh bucket
  assert.ok(Date.now() - start < 50, 'a different key must not wait on another key\'s bucket');
});

test('updateRate raises the effective rate for subsequent calls', async () => {
  const limiter = new RateLimiter({ op: { ratePerSecond: 1, burst: 1 } });
  await limiter.schedule('acct-1', 'op', async () => null); // consumes the one token
  limiter.updateRate('acct-1', 'op', { ratePerSecond: 1000 });
  const start = Date.now();
  await limiter.schedule('acct-1', 'op', async () => null);
  assert.ok(Date.now() - start < 50, 'raised rate should let the next call through almost immediately');
});
