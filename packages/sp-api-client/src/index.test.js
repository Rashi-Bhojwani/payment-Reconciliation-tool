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

test('downloads and combines all scheduled settlement reports in the requested range', async () => {
  const calls = [];
  const client = new SpApiClient('refresh-token', { clientId: 'id', clientSecret: 'secret' });
  client.request = async (path, init = {}) => {
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    assert.match(path, /^\/reports\/2021-06-30\/reports\?/);
    return new Response(JSON.stringify({ reports: [
      { reportId: 'R1', reportDocumentId: 'D1', processingStatus: 'DONE', dataStartTime: '2026-06-27T00:00:00Z' },
      { reportId: 'R2', reportDocumentId: 'D2', processingStatus: 'DONE', dataStartTime: '2026-07-10T00:00:00Z' }
    ] }), { status: 200 });
  };
  client.downloadReportDocument = async id => ({ content: `date/time\tsettlement id\n${id}\tS1`, compressionAlgorithm: undefined });
  const range = { start: '2026-06-27T00:00:00.000Z', end: '2026-07-27T00:00:00.000Z' };
  const result = await client.fetchReport('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', '00000000-0000-4000-8000-000000000001', range);
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /createdSince=2026-06-27/);
  assert.equal(result.reportsImported, 2);
  assert.equal(result.content, 'date/time\tsettlement id\nD1\tS1\nD2\tS1');
});

test('fetches and combines every Finances listTransactions page', async () => {
  const client = new SpApiClient('refresh-token');
  const calls = [];
  client.listFinanceTransactions = async (after, before, token) => {
    calls.push({ after, before, token });
    return token ? { transactions: [{ transactionId: 'T2' }] } : { payload: { transactions: [{ transactionId: 'T1' }], nextToken: 'page-2' } };
  };
  const rows = await client.fetchFinanceTransactions('2026-07-01T00:00:00.000Z', '2026-07-28T00:00:00.000Z');
  assert.deepEqual(rows.map(row => row.transactionId), ['T1', 'T2']);
  assert.deepEqual(calls[1], { after: undefined, before: undefined, token: 'page-2' });
});
