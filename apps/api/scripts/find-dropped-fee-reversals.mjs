// Lists the specific Finance API rows dedupeRepostedTransactions dropped as
// "already counted" re-issued copies, for one tenant and one display range -
// so "why does Expenses read 81 more negative than Amazon's statement" has an
// actual transaction id behind it instead of a guess.
//
// Why this needed its own script rather than a manual CSV reconstruction:
// the dashboard fetches finance_transaction_items with 60 DAYS OF LOOKBACK
// before range.start (FINANCE_LOOKBACK_DAYS in server.js) so a deferred
// transaction's later release can be matched to its origin even when the
// origin posted before the window the user is looking at. The "Raw API data
// explorer" CSV download does not carry that lookback - it queries
// posted_date within the range only - so reconstructing the dedup from that
// export alone silently keeps rows the live calculation would have dropped,
// and comes out wrong by far more than the real gap. This script issues the
// same lookback-widened query loadDashboardCalculations does, then calls the
// real dedupeRepostedTransactions - not a re-implementation of it - so
// whatever this prints is exactly what the dashboard is doing.
//
// A dropped row with a POSITIVE amount under a fee-shaped category
// (closing_fee, referral_commission, fulfillment_fee_*, storage_fee,
// shipping_fee, ...) is the shape of a fee reversal: Amazon's own statement
// counts it as an expense credit, but it exists only on the re-issued copy
// this has to drop to avoid double-counting the fee itself - see the
// "Expenses can read more negative..." note in dashboard-calculations.js.
//
// Read-only. Nothing is deleted or changed.
//
// Usage:
//   DATABASE_URL=... node apps/api/scripts/find-dropped-fee-reversals.mjs --tenant <uuid> --from 2026-05-10 --to 2026-08-11
import pg from 'pg';
import { requireDatabaseUrl } from '@recon/db/env.js';
import { dedupeRepostedTransactions } from '../src/jobs/dashboard-calculations.js';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : null; };
const tenantId = arg('tenant');
const from = arg('from');
const to = arg('to');
if (!tenantId || !from || !to) {
  console.error('Usage: --tenant <uuid> --from YYYY-MM-DD --to YYYY-MM-DD (to is exclusive - pass the day AFTER the last day you want included)');
  process.exit(2);
}

const FINANCE_LOOKBACK_DAYS = 60; // must match server.js - this is what makes the dedup trustworthy

let connectionString;
try { connectionString = requireDatabaseUrl('the dropped fee reversal trace'); }
catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(2); }

const isLocal = /host=\/|@localhost|@127\.0\.0\.1/.test(connectionString);
const pool = new pg.Pool({ connectionString, ssl: isLocal ? false : { rejectUnauthorized: false } });

const FEE_SHAPED = /fee|commission|closing|storage|shipping|advertis|service|adjustment|other/i;

try {
  const range = { start: new Date(`${from}T00:00:00Z`).toISOString(), end: new Date(`${to}T00:00:00Z`).toISOString() };

  // Same shape as loadDashboardCalculations' financeItems query in server.js -
  // deliberately kept in lockstep with it rather than simplified, since the
  // whole point is to feed dedupeRepostedTransactions exactly what the
  // dashboard feeds it.
  const { rows } = await pool.query(`
    select fi.id source_row_id, fi.transaction_id, coalesce(ft.related_order_id, fi.order_id) order_id,
           fi.sku, fi.category, fi.amount_description, fi.amount, fi.posted_date,
           coalesce(ft.raw->>'transactionStatus', ft.raw->>'TransactionStatus') transaction_status
      from finance_transaction_items fi
      left join finance_transactions ft on ft.tenant_id = fi.tenant_id and ft.transaction_id = fi.transaction_id
     where fi.tenant_id = $1
       and fi.posted_date >= ($2::timestamptz - interval '${FINANCE_LOOKBACK_DAYS} days')
       and fi.posted_date < $3`,
    [tenantId, range.start, range.end]
  );
  console.log(`${rows.length} finance_transaction_item row(s) fetched (including ${FINANCE_LOOKBACK_DAYS}-day lookback before ${from})`);

  const nonSummary = rows.filter(row => !String(row.category ?? '').startsWith('summary_'));
  const { kept, dropped } = dedupeRepostedTransactions(nonSummary);
  console.log(`${kept.length} kept, ${dropped} dropped as re-issued copies of already-counted money\n`);
  // dedupeRepostedTransactions returns only counts, not which rows it dropped
  // - kept holds the exact same row objects (references, not copies) it was
  // given, so the complement is exactly what it discarded. Deriving this here
  // instead of changing that function's return shape keeps the production
  // dedup untouched by a diagnostic script.
  const keptSet = new Set(kept);
  const droppedRows = nonSummary.filter(row => !keptSet.has(row));

  const inRange = row => {
    const t = new Date(row.posted_date).getTime();
    return t >= new Date(range.start).getTime() && t < new Date(range.end).getTime();
  };
  const droppedInRange = (droppedRows ?? []).filter(inRange);
  console.log(`${droppedInRange.length} of those dropped row(s) posted inside ${from} - ${to} (the range actually being viewed):\n`);

  const candidates = droppedInRange
    .filter(row => Number(row.amount) > 0 && FEE_SHAPED.test(`${row.category} ${row.amount_description}`))
    .sort((a, b) => Number(b.amount) - Number(a.amount));

  if (candidates.length) {
    console.log('Positive-amount, fee-shaped dropped rows - the ones most likely to be a fee reversal Amazon still counts:');
    let total = 0;
    for (const row of candidates) {
      total += Number(row.amount);
      console.log(`  ${row.posted_date.toISOString?.() ?? row.posted_date}  ${row.transaction_status ?? '?'}  ${row.category}/${row.amount_description}  ${Number(row.amount).toFixed(2)}  order ${row.order_id ?? '(none)'}  txn ${row.transaction_id}`);
    }
    console.log(`\n  Sum of the above: ${total.toFixed(2)}`);
  } else {
    console.log('No positive-amount, fee-shaped dropped rows found in this range - the gap is not this mechanism, or the reversal is shaped differently than expected.');
  }

  if (droppedInRange.length) {
    console.log(`\nAll ${droppedInRange.length} dropped row(s) in range, for reference:`);
    for (const row of droppedInRange.sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount)))) {
      console.log(`  ${row.posted_date.toISOString?.() ?? row.posted_date}  ${row.transaction_status ?? '?'}  ${row.category}/${row.amount_description}  ${Number(row.amount).toFixed(2)}  order ${row.order_id ?? '(none)'}  txn ${row.transaction_id}`);
    }
  }
} catch (error) {
  console.error('Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
