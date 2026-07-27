import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSettlementContent } from './settlement-parser.js';

const header = 'date/time,settlement id,type,order id,Sku,description,quantity,marketplace,account type,fulfillment,order city,order state,order postal,product sales,shipping credits,gift wrap credits,promotional rebates,Total sales tax liable(GST before adjusting TCS),TCS-CGST,TCS-SGST,TCS-IGST,TDS (Section 194-O),selling fees,fba fees,other transaction fees,other,total,Transaction Status,Transaction Release Date';

test('preserves duplicate Amazon CSV lines and parses quoted thousands', () => {
  const line = '27/06/2026 10:00:00,S1,Service Fee,,,,,Amazon.in,Standard Orders,,,,,"1,694.07",0,0,0,0,0,0,0,0,-10,0,0,0,"1,684.07",Deferred,30/06/2026';
  const rows = parseSettlementContent(`${header}\n${line}\n${line}\n`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].product_sales, 1694.07);
  assert.equal(rows[0].total, 1684.07);
  assert.equal(rows[0].transaction_status, 'Deferred');
  assert.notEqual(rows[0].dedupe_key, rows[1].dedupe_key);
});
