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

test('paginates scheduled settlement reports and keeps each document identity',async()=>{
  const client=new SpApiClient('token'); let pages=0;
  client.request=async path=>({ok:true,json:async()=>{pages++;return pages===1?{reports:[{reportId:'r1',reportDocumentId:'d1',dataStartTime:'2026-06-20T00:00:00Z',dataEndTime:'2026-07-01T00:00:00Z'}],nextToken:'next'}:{reports:[{reportId:'r2',reportDocumentId:'d2',dataStartTime:'2026-07-01T00:00:00Z',dataEndTime:'2026-07-20T00:00:00Z'}]}}});
  client.downloadReportDocument=async id=>({content:`header\n${id}`});
  const result=await client.fetchReport('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2','00000000-0000-0000-0000-000000000001',{start:'2026-06-26T18:30:00.000Z',end:'2026-07-26T18:30:00.000Z'});
  assert.equal(pages,2); assert.deepEqual(result.documents.map(x=>x.reportId),['r2','r1']);
});
