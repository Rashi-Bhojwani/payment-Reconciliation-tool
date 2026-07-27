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
const start = new Date(Math.min(...times)); const end = new Date(Math.max(...times) + 1);
const group = rows => rows.reduce((result, row) => { const key = `${row.type ?? ''}\u0000${row.transaction_status ?? ''}`; result[key] = (result[key] ?? 0) + Number(row.total ?? 0); return result; }, {});
const actualRows = await withTenant(tenantId, async db => (await db.query('select type,transaction_status,total from settlement_transaction_lines where tenant_id=$1 and posted_at >= $2 and posted_at < $3', [tenantId, start, end])).rows);
const expected = group(expectedRows); const actual = group(actualRows); let mismatches = 0;
for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
  const [type, status] = key.split('\u0000'); const difference = Number(actual[key] ?? 0) - Number(expected[key] ?? 0);
  if (Math.abs(difference) > 0.005) { mismatches += 1; console.error(`${type} / ${status}: CSV=${expected[key] ?? 0} DB=${actual[key] ?? 0} difference=${difference}`); }
}
console.log(`Compared ${expectedRows.length} CSV rows with ${actualRows.length} stored rows; ${mismatches} grouped mismatch(es).`);
await pool.end(); process.exitCode = mismatches ? 1 : 0;
