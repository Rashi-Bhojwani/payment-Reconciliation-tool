import assert from 'node:assert/strict';
import test from 'node:test';
import { marketplaceCalendarRange, normalizeReportRange } from './index.js';

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

test('converts India inclusive calendar selection to the required half-open instants',()=>{
  assert.deepEqual(marketplaceCalendarRange('2026-06-27','2026-07-27','A21TJRUUN4KGV'),{start:'2026-06-26T18:30:00.000Z',end:'2026-07-26T18:30:00.000Z',timezone:'Asia/Kolkata',localStart:'2026-06-27',localEndExclusive:'2026-07-27'});
});

test('uses IANA daylight-saving offsets rather than a fixed marketplace offset',()=>{
  const winter=marketplaceCalendarRange('2026-01-01','2026-01-02','A1F83G8C2ARO7P');
  const summer=marketplaceCalendarRange('2026-07-01','2026-07-02','A1F83G8C2ARO7P');
  assert.equal(winter.start,'2026-01-01T00:00:00.000Z');
  assert.equal(summer.start,'2026-06-30T23:00:00.000Z');
});
