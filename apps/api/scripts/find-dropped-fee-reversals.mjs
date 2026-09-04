// Computes Expenses for one tenant+range using the REAL production pipeline
// (same finance query, same dedupeRepostedTransactions, same isFee/isWithholding
// classifiers dashboard-calculations.js itself uses - all imported, none
// reimplemented) and then explains any gap against Amazon's own statement by
// finding the specific transaction groups where deduplication's tie-break
// (keep the earliest-posted copy) disagrees with which side of the range
// boundary the money should land on.
//
// Why this exists instead of eyeballing a CSV: a first attempt at this filtered
// dropped rows by a hand-written "looks fee-shaped" keyword regex and it
// missed TCS/TDS entirely (real classification treats those as isWithholding,
// not isFee, and the keyword list never said tcs/tds) - it dumped ~600 mostly
// irrelevant rows instead of pointing at a cause. Reusing the actual
// classifiers there is no more room for that kind of miss: whatever this
// script calls Expenses IS what the dashboard calls Expenses, because it is
// the same four lines of code.
//
// Read-only. Nothing is deleted or changed.
//
// Usage:
//   DATABASE_URL=... node apps/api/scripts/find-dropped-fee-reversals.mjs \
//     --tenant <uuid> --from 2026-05-10 --to 2026-08-11 [--amazon-expenses -217915.65]
import pg from 'pg';
import { requireDatabaseUrl } from '@recon/db/env.js';
import { dedupeRepostedTransactions, isFee, isWithholding, isPrincipal, isProductGst } from '../src/jobs/dashboard-calculations.js';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : null; };
const tenantId = arg('tenant');
const from = arg('from');
const to = arg('to');
const amazonExpenses = arg('amazon-expenses');
if (!tenantId || !from || !to) {
  console.error('Usage: --tenant <uuid> --from YYYY-MM-DD --to YYYY-MM-DD (to is exclusive - pass the day AFTER the last day you want included) [--amazon-expenses -217915.65]');
  process.exit(2);
}

const FINANCE_LOOKBACK_DAYS = 60; // must match server.js - this is what makes the dedup trustworthy
// The dashboard sends a picked IST calendar day as ITS MIDNIGHT IN UTC, which
// is 5.5 hours *before* that same UTC date's midnight (see reporting-calendar.js:
// "21 Jul" travels as 2026-07-20T18:30:00.000Z). Parsing --from/--to as plain
// UTC midnight - what this script did originally - put the whole window 5.5
// hours late on both ends, which is exactly a boundary bug: it clips real
// transactions off the front of the range and pulls in ones that don't belong
// at the back. Confirmed live: it was the entire reason this script's computed
// Expenses (-216233.34) disagreed with the live dashboard's own figure
// (-217996.65) by 1763.31, though both were fed the same 10-day range - a gap
// far larger than the ~81 the real gap being hunted was ever going to be.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

let connectionString;
try { connectionString = requireDatabaseUrl('the Expenses gap trace'); }
catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(2); }

const isLocal = /host=\/|@localhost|@127\.0\.0\.1/.test(connectionString);
const pool = new pg.Pool({ connectionString, ssl: isLocal ? false : { rejectUnauthorized: false } });
const round2 = v => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const amount = row => Number(row?.amount ?? 0) || 0;

try {
  const range = { start: new Date(Date.parse(`${from}T00:00:00Z`) - IST_OFFSET_MS).toISOString(), end: new Date(Date.parse(`${to}T00:00:00Z`) - IST_OFFSET_MS).toISOString() };

  // Same shape as loadDashboardCalculations' financeItems query in server.js.
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
  console.log(`${kept.length} kept, ${dropped} dropped as re-issued copies of already-counted money`);

  const inRange = row => {
    const t = new Date(row.posted_date).getTime();
    return t >= new Date(range.start).getTime() && t < new Date(range.end).getTime();
  };
  const financeStatementRows = kept.filter(inRange);
  const expenseRows = financeStatementRows.filter(row => (isFee(row) || isWithholding(row)) && !isProductGst(row) && !isPrincipal(row));
  const expenses = round2(expenseRows.reduce((sum, row) => sum + amount(row), 0));
  console.log(`\nComputed Expenses for ${from} - ${to}: ${expenses.toFixed(2)} (${expenseRows.length} rows)`);
  if (amazonExpenses != null) {
    const diff = round2(expenses - Number(amazonExpenses));
    console.log(`Amazon's statement: ${Number(amazonExpenses).toFixed(2)}  |  diff: ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`);
  }

  // The actual mechanism worth checking: dedupeRepostedTransactions keeps the
  // EARLIEST-posted copy of a repeated line and drops the rest, then this
  // range filter is applied AFTER that choice is made. If a line's earliest
  // copy posted before `from` (inside the 60-day lookback, so it exists in
  // `rows` but gets filtered out here) while a later re-issued copy of the
  // SAME line posted inside the range, neither copy ends up counted for this
  // range - the kept one is too early, the in-range one was dropped as a
  // duplicate. If Amazon's own statement dates this line by the later
  // (release) date instead of the origin date, that is exactly a section gap
  // with no fabrication involved on either side - just two different, both
  // reasonable, dating conventions disagreeing on one line.
  const groups = new Map();
  for (const row of nonSummary) {
    if (!row.order_id) continue;
    const key = `${row.order_id}|${row.category ?? ''}|${row.amount_description ?? ''}|${amount(row)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(row);
  }
  const keptSet = new Set(kept);
  const boundaryCases = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const keptMembers = members.filter(r => keptSet.has(r));
    const droppedMembers = members.filter(r => !keptSet.has(r));
    if (!keptMembers.length || !droppedMembers.length) continue;
    const keptInRange = keptMembers.some(inRange);
    const droppedInRangeAny = droppedMembers.some(inRange);
    if (keptInRange !== droppedInRangeAny) {
      boundaryCases.push({ key, keptMembers, droppedMembers, keptInRange, droppedInRangeAny });
    }
  }

  if (boundaryCases.length) {
    console.log(`\n${boundaryCases.length} line(s) where the kept copy and a dropped copy of the SAME line fall on different sides of the range boundary - these are the specific candidates for a dating-convention gap:`);
    for (const c of boundaryCases) {
      const isExpenseLine = (isFee(c.keptMembers[0]) || isWithholding(c.keptMembers[0])) && !isProductGst(c.keptMembers[0]) && !isPrincipal(c.keptMembers[0]);
      console.log(`\n  ${c.key}  ${isExpenseLine ? '(EXPENSE line)' : '(not an Expense line)'}`);
      for (const r of c.keptMembers) console.log(`    KEPT     ${r.posted_date.toISOString?.() ?? r.posted_date}  ${r.transaction_status}  ${inRange(r) ? 'IN RANGE' : 'outside range (lookback)'}  txn ${r.transaction_id}`);
      for (const r of c.droppedMembers) console.log(`    DROPPED  ${r.posted_date.toISOString?.() ?? r.posted_date}  ${r.transaction_status}  ${inRange(r) ? 'IN RANGE' : 'outside range'}  txn ${r.transaction_id}`);
    }
  } else {
    console.log('\nNo line has its kept and dropped copies split across the range boundary - the gap (if any) is not this mechanism.');
  }
} catch (error) {
  console.error('Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
