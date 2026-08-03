import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReportRange, throttleRetryDelayMs } from './index.js';

test('caps a future exclusive report end before the current time', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  assert.deepEqual(
    normalizeReportRange({ start: '2026-07-01T00:00:00.000Z', end: '2026-07-28T00:00:00.000Z' }, now),
    { start: '2026-07-01T00:00:00.000Z', end: '2026-07-27T11:58:00.000Z' }
  );
});

test('preserves an already historical report range', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  const range = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };
  assert.deepEqual(normalizeReportRange(range, now), range);
});

test('rejects a range with no data available before the safe boundary', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  assert.throws(
    () => normalizeReportRange({ start: '2026-07-27T12:00:00.000Z', end: '2026-07-28T00:00:00.000Z' }, now),
    /must start before Amazon's latest available data time/
  );
});

test('a throttled report-document download waits for Amazon\'s own window to reopen', () => {
  // The live failure: six retries inside a bucket that opens once per 45s.
  const documentPath = '/reports/2021-06-30/documents/amzn1.spdoc.1.4.eu.T3PY2XYI69WPGH.1118';
  const waits = [0, 1, 2, 3, 4, 5].map(attempt => throttleRetryDelayMs({ method: 'GET', path: documentPath, attempt }));
  assert.ok(waits.every(wait => wait >= 45_000), `every retry must clear the 45s window, got ${waits.join(', ')}`);
  assert.deepEqual(waits.slice(0, 3), [45_000, 45_000, 45_000], 'no longer 2s, 4s, 8s');
});

test('Amazon asking for longer than the bucket interval wins', () => {
  const wait = throttleRetryDelayMs({ method: 'GET', path: '/reports/2021-06-30/documents/doc', attempt: 0, retryAfterSeconds: 90 });
  assert.equal(wait, 90_000);
});

test('a retry never waits longer than the cap, however Amazon answers', () => {
  assert.equal(throttleRetryDelayMs({ method: 'GET', path: '/reports/2021-06-30/documents/doc', attempt: 0, retryAfterSeconds: 3600 }), 120_000);
  assert.equal(throttleRetryDelayMs({ method: 'GET', path: '/orders/v0/orders', attempt: 20 }), 120_000);
});

test('a fast bucket still backs off exponentially rather than at its floor', () => {
  // Orders paces at 2200ms; the exponential must take over once it exceeds
  // that, or a genuinely overloaded endpoint gets hammered at a fixed rate.
  const waits = [0, 1, 2, 3].map(attempt => throttleRetryDelayMs({ method: 'GET', path: '/orders/v0/orders', attempt }));
  assert.deepEqual(waits, [2200, 4000, 8000, 16_000]);
});
