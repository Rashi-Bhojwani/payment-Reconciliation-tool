// Finds gst_invoices rows whose stored invoice_type ('b2b'/'b2c') disagrees
// with what the row's own raw data says it should be, and optionally fixes
// them. Exists because assertGstInvoiceTypeMatchesContent (sync.js) only
// guards uploads made AFTER it shipped - anything imported earlier, when the
// upload feature trusted whichever button was clicked with no check at all,
// could already be mislabeled and nothing would have said so.
//
// The signal is the same one the live guard uses: a B2B invoice legally
// requires the buyer's GSTIN, a B2C (consumer) invoice never has one -
// confirmed against a real Seller Central Merchant Tax Report, where every
// B2B row carries a populated Customer Bill To Gstid. A row whose raw data
// has neither GSTID column at all (a report shape this has never seen) is
// left alone, never guessed at - same rule as the live check.
//
// Usage:
//   DATABASE_URL=... node apps/api/scripts/audit-gst-invoice-types.mjs
//   DATABASE_URL=... node apps/api/scripts/audit-gst-invoice-types.mjs --apply
//   ... --tenant <uuid>          limit to one account
// Without --apply it only reports.
import pg from 'pg';
import { requireDatabaseUrl } from '@recon/db/env.js';

const apply = process.argv.includes('--apply');
const tenantArg = process.argv.indexOf('--tenant');
const onlyTenant = tenantArg > -1 ? process.argv[tenantArg + 1] : null;
let connectionString;
try {
  connectionString = requireDatabaseUrl('the GST invoice type audit');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}

const isLocal = /host=\/|@localhost|@127\.0\.0\.1/.test(connectionString);
const pool = new pg.Pool({ connectionString, ssl: isLocal ? false : { rejectUnauthorized: false } });
const client = await pool.connect();

// Every casing/hyphenation seen in a real download or plausible from an API
// report - mirrors GSTID_FIELD_NAMES/hasColumn in sync.js exactly, just
// expressed as jsonb key lookups instead of pick() over a parsed object.
const GSTID_KEYS = ['Customer Bill To Gstid', 'customer-bill-to-gstid', 'customer bill to gstid', 'Customer Ship To Gstid', 'customer-ship-to-gstid', 'customer ship to gstid'];

try {
  const rows = await client.query(`
    select id, tenant_id, invoice_type, order_id, invoice_date, raw
      from gst_invoices
     where ($1::uuid is null or tenant_id = $1::uuid)`, [onlyTenant]);

  let unverifiable = 0;
  const mismatched = [];
  for (const row of rows.rows) {
    const rawKeys = new Set(Object.keys(row.raw ?? {}));
    const presentKey = GSTID_KEYS.find(key => rawKeys.has(key));
    if (!presentKey) { unverifiable += 1; continue; }
    const hasGstid = String(row.raw[presentKey] ?? '').trim() !== '';
    const expectedType = hasGstid ? 'b2b' : 'b2c';
    if (expectedType !== row.invoice_type) mismatched.push({ ...row, expectedType });
  }

  console.log(`${rows.rowCount} gst_invoices row(s) examined${onlyTenant ? ` for tenant ${onlyTenant.slice(0, 8)}` : ''}`);
  console.log(`  ${unverifiable} have no GSTID column in their raw data at all - left alone, can't verify`);
  console.log(`  ${rows.rowCount - unverifiable - mismatched.length} already match their own data`);
  console.log(`  ${mismatched.length} mislabeled\n`);

  for (const row of mismatched) {
    console.log(`  !     ${row.order_id ?? '(no order id)'}  ${row.invoice_date ?? '(no date)'}  stored as ${row.invoice_type}, raw data says ${row.expectedType}`);
  }

  if (mismatched.length && apply) {
    await client.query('begin');
    for (const row of mismatched) {
      await client.query('update gst_invoices set invoice_type=$2 where id=$1', [row.id, row.expectedType]);
    }
    await client.query('commit');
    console.log(`\nAPPLIED: relabeled ${mismatched.length} row(s).`);
  } else if (mismatched.length) {
    console.log('\nDry run - nothing changed. Re-run with --apply to relabel these to what their own data says.');
  }
} catch (error) {
  console.error('Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
