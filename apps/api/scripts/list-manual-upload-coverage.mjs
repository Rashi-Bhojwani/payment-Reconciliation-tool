// Finds gaps in monthly manual uploads (Settlements, GST B2B, GST B2C, etc.)
// by checking which calendar months actually have a completed
// source='manual_upload' sync_jobs row against every month in a requested
// window - so "which file did I forget" is a lookup instead of a memory
// exercise across 18+ separate uploads.
//
// Usage:
//   DATABASE_URL=... node apps/api/scripts/list-manual-upload-coverage.mjs --tenant <uuid>
//   ... --from 2025-08 --to 2026-04     (defaults to the last 12 months)
//   ... --report-type GET_GST_MTR_B2B_CUSTOM   (defaults to all 5 uploadable types)
import pg from 'pg';
import { requireDatabaseUrl } from '@recon/db/env.js';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : null; };
const tenantId = arg('tenant');
if (!tenantId) { console.error('Usage: --tenant <uuid> [--from YYYY-MM] [--to YYYY-MM] [--report-type TYPE]'); process.exit(2); }

const UPLOADABLE_REPORT_TYPES = ['GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', 'GET_GST_MTR_B2B_CUSTOM', 'GET_GST_MTR_B2C_CUSTOM', 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', 'GET_FBA_REIMBURSEMENTS_DATA'];
const reportTypes = arg('report-type') ? [arg('report-type')] : UPLOADABLE_REPORT_TYPES;

const now = new Date();
const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
const parseMonth = (value, fallback) => value ? new Date(`${value}-01T00:00:00Z`) : fallback;
const from = parseMonth(arg('from'), defaultFrom);
const to = parseMonth(arg('to'), now);

const months = [];
for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); d <= to; d.setUTCMonth(d.getUTCMonth() + 1)) {
  months.push(new Date(d));
}
const monthLabel = d => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' });
const monthKey = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

let connectionString;
try { connectionString = requireDatabaseUrl('the manual upload coverage check'); }
catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(2); }

const isLocal = /host=\/|@localhost|@127\.0\.0\.1/.test(connectionString);
const pool = new pg.Pool({ connectionString, ssl: isLocal ? false : { rejectUnauthorized: false } });

try {
  for (const reportType of reportTypes) {
    // A month counts as covered if any manual_upload's range fully contains
    // that calendar month - matches how the app itself decides "already
    // downloaded" elsewhere (findReusableSync's containment check), so this
    // reports the same thing the app would actually reuse.
    const rows = (await pool.query(
      `select range_start, range_end from sync_jobs
       where tenant_id=$1 and report_type=$2 and status='completed' and source='manual_upload'
       order by range_start`,
      [tenantId, reportType]
    )).rows;

    console.log(`\n${reportType} - ${rows.length} manual upload(s) on record`);
    let missing = 0;
    for (const month of months) {
      const monthStart = month;
      const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
      const covered = rows.some(row => new Date(row.range_start) <= monthStart && new Date(row.range_end) >= monthEnd);
      if (!covered) { console.log(`  MISSING  ${monthLabel(month)} (${monthKey(month)})`); missing += 1; }
    }
    if (!missing) console.log('  All months in range are covered.');
  }
} catch (error) {
  console.error('Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
