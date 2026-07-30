import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReportRange, SpApiClient, completedReportCoversRequest } from './index.js';

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

test('treats an Amazon-cancelled empty report as a successful zero-row result', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const responses = [
    new Response(JSON.stringify({ reportId: 'report-empty' }), { status: 202 }),
    new Response(JSON.stringify({ processingStatus: 'CANCELLED' }), { status: 200 })
  ];
  globalThis.fetch = async () => responses.shift();

  const client = new SpApiClient('refresh-token', { clientId: 'client', clientSecret: 'secret' });
  client.cachedToken = { accessToken: 'access-token', expiresAt: Date.now() + 3600_000 };
  const result = await client.fetchReport(
    'GET_SALES_AND_TRAFFIC_REPORT',
    '11111111-1111-4111-8111-111111111111',
    { start: '2026-07-01T00:00:00.000Z', end: '2026-07-02T00:00:00.000Z' }
  );

  assert.equal(result.reportId, 'report-empty');
  assert.equal(result.reportDocumentId, null);
  assert.equal(result.content, '');
  assert.equal(result.empty, true);
  assert.equal(result.processingStatus, 'CANCELLED');
  assert.equal(result.coverageComplete, true);
  assert.equal(result.cancelledNoData, true);
});


test('accepts date-only GST coverage for an IST half-open application range', () => {
  const requestRange = {
    start: '2026-07-21',
    end: '2026-07-29',
    coverageStart: '2026-07-20T18:30:00.000Z',
    coverageEnd: '2026-07-29T18:30:00.000Z'
  };
  assert.equal(
    completedReportCoversRequest('GET_GST_MTR_B2B_CUSTOM', requestRange, '2026-07-21', '2026-07-29'),
    true
  );
});
