import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv,randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
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

test('decrypts then decompresses encrypted Amazon report documents',async()=>{const key=randomBytes(32),iv=randomBytes(16),plain='a\tb\n1\t2\n';const cipher=createCipheriv('aes-256-cbc',key,iv);const encrypted=Buffer.concat([cipher.update(gzipSync(Buffer.from(plain))),cipher.final()]);const client=new SpApiClient('token');client.request=async()=>({ok:true,json:async()=>({url:'https://example.test/document',compressionAlgorithm:'GZIP',encryptionDetails:{standard:'AES',key:key.toString('base64'),initializationVector:iv.toString('base64')}})});const originalFetch=globalThis.fetch;globalThis.fetch=async()=>({ok:true,arrayBuffer:async()=>encrypted});try{const result=await client.downloadReportDocument('document');assert.equal(result.content,plain);}finally{globalThis.fetch=originalFetch;}});

test('requests subsequent Order Items pages with the stable order identifier',async()=>{const client=new SpApiClient('token');let requested='';client.request=async path=>{requested=path;return{ok:true,json:async()=>({payload:{OrderItems:[]}})}};await client.listOrderItemsByNextToken('ORDER-1','NEXT TOKEN');assert.match(requested,/ORDER-1\/orderItems\?NextToken=NEXT%20TOKEN/);});
