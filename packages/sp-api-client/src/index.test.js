import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReportRange, SpApiClient } from './index.js';

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

test('creates settlement reports with the explicit custom date range and never retries without it', async () => {
  const calls = [];
  const client = new SpApiClient('refresh-token', { clientId: 'id', clientSecret: 'secret' });
  client.request = async (path, init = {}) => {
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    if (path === '/reports/2021-06-30/reports') return new Response(JSON.stringify({ reportId: 'R1' }), { status: 200 });
    return new Response(JSON.stringify({ processingStatus: 'DONE', reportDocumentId: 'D1' }), { status: 200 });
  };
  client.downloadReportDocument = async () => ({ content: 'date/time\tsettlement id', compressionAlgorithm: undefined });
  const range = { start: '2026-06-27T00:00:00.000Z', end: '2026-07-27T00:00:00.000Z' };
  await client.fetchReport('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', '00000000-0000-4000-8000-000000000001', range);
  assert.equal(calls.filter(call => call.path === '/reports/2021-06-30/reports').length, 1);
  assert.equal(calls[0].body.dataStartTime, range.start);
  assert.equal(calls[0].body.dataEndTime, range.end);
});
