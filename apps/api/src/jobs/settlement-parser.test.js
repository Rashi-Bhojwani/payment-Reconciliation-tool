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

test('normalizes classic V2 settlement component lines without double-counting its header total', () => {
  const classicHeader = 'settlement-id\tsettlement-start-date\tsettlement-end-date\tdeposit-date\ttotal-amount\tcurrency\ttransaction-type\torder-id\tmerchant-order-id\tadjustment-id\tshipment-id\tmarketplace-name\tamount-type\tamount-description\tamount\tfulfillment-id\tposted-date\tposted-date-time\torder-item-code\tsku\tquantity-purchased';
  const summary = 'S1\t19.07.2026\t24.07.2026\t26.07.2026\t1684.07\tINR';
  const sale = 'S1\t\t\t\t\t\tOrder\tORDER-1\t\t\tSHIP-1\tAmazon.in\tItemPrice\tPrincipal\t1694.07\tAFN\t23.07.2026\t23.07.2026 18:21:50 UTC\tITEM-1\tSKU-1\t1';
  const fee = 'S1\t\t\t\t\t\tOrder\tORDER-1\t\t\tSHIP-1\tAmazon.in\tItemFees\tCommission\t-10\tAFN\t23.07.2026\t23.07.2026 18:21:50 UTC\tITEM-1\tSKU-1\t1';
  const rows = parseSettlementContent(`${classicHeader}\n${summary}\n${sale}\n${fee}\n`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].product_sales, 1694.07);
  assert.equal(rows[1].selling_fees, -10);
  assert.equal(rows.reduce((sum, row) => sum + row.total, 0), 1684.07);
  assert.equal(rows[0].raw_row['amount-description'], 'Principal');
});
