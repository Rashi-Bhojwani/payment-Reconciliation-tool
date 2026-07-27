import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { pool, withTenant } from '@recon/db';
import { parseSettlementContent } from './settlement-parser.js';

const [tenantArg, csvPath] = process.argv.slice(2);
const tenantId = z.string().uuid().parse(tenantArg);
if (!csvPath) throw new Error('Usage: node verify-against-csv.js <tenant-id> <seller-export.csv>');
const expectedRows = parseSettlementContent(await readFile(csvPath, 'utf8'));
if (!expectedRows.length) throw new Error('CSV has no transaction rows');
const times = expectedRows.map(row => new Date(row.posted_at).getTime()).filter(Number.isFinite);
if (times.length !== expectedRows.length) throw new Error('CSV contains an unparseable date/time value');
const start = new Date(Math.min(...times)); const end = new Date(Math.max(...times) + 1);
const amountFields = ['product_sales','shipping_credits','gift_wrap_credits','promotional_rebates','total_sales_tax_liable','tcs_cgst','tcs_sgst','tcs_igst','tds_194o','selling_fees','fba_fees','other_transaction_fees','other','total'];
const group = rows => rows.reduce((result, row) => {
  const groupKey = `${row.type ?? ''}\u0000${row.transaction_status ?? ''}`;
  for (const field of amountFields) { const key = `${groupKey}\u0000${field}`; result[key] = (result[key] ?? 0) + Number(row[field] ?? 0); }
  return result;
}, {});
const actualRows = await withTenant(tenantId, async db => (await db.query(`select type,transaction_status,${amountFields.join(',')} from settlement_transaction_lines where tenant_id=$1 and posted_at >= $2 and posted_at < $3`, [tenantId, start, end])).rows);
const expected = group(expectedRows); const actual = group(actualRows); let mismatches = 0;
for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
  const [type, status, field] = key.split('\u0000'); const difference = Number(actual[key] ?? 0) - Number(expected[key] ?? 0);
  if (Math.abs(difference) > 0.005) { mismatches += 1; console.error(`${type} / ${status} / ${field}: CSV=${expected[key] ?? 0} DB=${actual[key] ?? 0} difference=${difference}`); }
}
if (expectedRows.length !== actualRows.length) { mismatches += 1; console.error(`row count: CSV=${expectedRows.length} DB=${actualRows.length}`); }
console.log(`Compared ${expectedRows.length} CSV rows with ${actualRows.length} stored rows; ${mismatches} grouped mismatch(es).`);
await pool.end(); process.exitCode = mismatches ? 1 : 0;
