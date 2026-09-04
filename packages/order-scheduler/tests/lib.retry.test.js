import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, fullJitterBackoff } from '../src/lib/retry.js';

test('succeeds without retrying when the first attempt succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retries a retryable error up to maxAttempts, then throws', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        const error = new Error('throttled');
        error.retryable = true;
        throw error;
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    ),
    /throttled/,
  );
  assert.equal(calls, 3, 'should attempt exactly maxAttempts times, not retry-storm past it');
});

test('a non-retryable error is thrown immediately, without retrying', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        const error = new Error('bad request');
        error.retryable = false;
        throw error;
      },
      { maxAttempts: 5, baseDelayMs: 1 },
    ),
    /bad request/,
  );
  assert.equal(calls, 1, 'a non-retryable error must not be retried at all');
});

test('recovers if a later attempt succeeds', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error('transient');
        error.retryable = true;
        throw error;
      }
      return 'recovered';
    },
    { maxAttempts: 5, baseDelayMs: 1 },
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
});

test('honours a server-specified Retry-After delay over the computed backoff', async () => {
  let calls = 0;
  const timestamps = [];
  await assert.rejects(
    withRetry(
      async () => {
        timestamps.push(Date.now());
        calls += 1;
        const error = new Error('throttled');
        error.retryable = true;
        error.retryAfterMs = 40;
        throw error;
      },
      { maxAttempts: 2, baseDelayMs: 1, retryAfterMs: (e) => e.retryAfterMs },
    ),
  );
  assert.equal(calls, 2);
  assert.ok(timestamps[1] - timestamps[0] >= 35, 'should have waited close to the requested 40ms');
});

test('fullJitterBackoff never exceeds the exponential cap and stays non-negative', () => {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    for (let i = 0; i < 20; i += 1) {
      const delay = fullJitterBackoff(attempt, 100, 10_000);
      assert.ok(delay >= 0);
      assert.ok(delay <= Math.min(10_000, 100 * 2 ** (attempt - 1)));
    }
  }
});

test('retries never exceed maxDelayMs regardless of attempt count (no unbounded backoff)', () => {
  const delay = fullJitterBackoff(20, 500, 20_000);
  assert.ok(delay <= 20_000);
});
