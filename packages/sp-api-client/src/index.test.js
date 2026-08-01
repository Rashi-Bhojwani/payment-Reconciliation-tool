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

test('preserves settlement document boundaries when merging reports', async () => {
  const client = new SpApiClient('refresh-token', { clientId: 'id', clientSecret: 'secret' });
  client.request = async () => new Response(JSON.stringify({ reports: [
    { reportId: 'report-1', reportDocumentId: 'document-1', dataStartTime: '2026-06-01T00:00:00.000Z', dataEndTime: '2026-06-15T00:00:00.000Z' },
    { reportId: 'report-2', reportDocumentId: 'document-2', dataStartTime: '2026-06-16T00:00:00.000Z', dataEndTime: '2026-06-30T00:00:00.000Z' }
  ] }), { status: 200 });
  client.downloadReportDocument = async reportDocumentId => ({ content: `header\nidentical\tline`, compressionAlgorithm: undefined, reportDocumentId });

  const report = await client.fetchReport(
    'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
    '00000000-0000-4000-8000-000000000001',
    { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' }
  );

  assert.deepEqual(report.documents.map(document => document.reportDocumentId), ['document-2', 'document-1']);
  assert.equal(report.documents[0].content, 'header\nidentical\tline');
  assert.equal(report.content, 'header\nidentical\tline\nidentical\tline');
});
