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

test('paginates settlement report discovery and downloads every overlapping document',async()=>{
  const client=new SpApiClient('refresh',{baseUrl:'https://example.test'});let page=0;
  client.request=async path=>{page++;return new Response(JSON.stringify(page===1?{reports:[{reportId:'r1',reportDocumentId:'d1',dataStartTime:'2026-06-20T00:00:00Z',dataEndTime:'2026-07-01T00:00:00Z'}],nextToken:'next'}:{reports:[{reportId:'r2',reportDocumentId:'d2',dataStartTime:'2026-07-02T00:00:00Z',dataEndTime:'2026-07-26T00:00:00Z'}]}),{status:200,headers:{'content-type':'application/json'}});};
  client.downloadReportDocument=async id=>({content:`settlement-id\tamount\n${id}\t1`});
  const result=await client.fetchReport('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2','11111111-1111-1111-1111-111111111111',{start:'2026-06-27T00:00:00Z',end:'2026-07-27T00:00:00Z'});
  assert.equal(page,2);assert.deepEqual(result.reportDocuments.map(row=>row.documentId),['d2','d1']);assert.match(result.content,/d1/);assert.match(result.content,/d2/);
});
