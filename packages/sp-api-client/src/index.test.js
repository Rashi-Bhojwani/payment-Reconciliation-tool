import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReportRange, reportRequestRange } from './index.js';

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

test('converts the half-open UI range to an inclusive Sales and Traffic date range', () => {
  const now = Date.parse('2026-07-30T12:00:00.000Z');
  assert.deepEqual(
    reportRequestRange(
      'GET_SALES_AND_TRAFFIC_REPORT',
      { start: '2026-07-01T18:30:00.000Z', end: '2026-07-08T18:30:00.000Z' },
      'A21TJRUUN4KGV',
      now
    ),
    {
      start: '2026-07-02',
      end: '2026-07-08',
      coverageStart: '2026-07-01T18:30:00.000Z',
      coverageEnd: '2026-07-08T18:30:00.000Z'
    }
  );
});
