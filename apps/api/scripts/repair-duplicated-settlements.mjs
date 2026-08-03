// Removes settlement rows that were stored more than once because Amazon's
// settlement reports are rolling windows: one fetch could merge several
// documents that each contained the same settlement, and the ordinal tiebreak
// in source_key gave every copy a different identity, so the upsert could not
// collapse them. See the commit that added dropRepeatedSettlements.
//
// This repairs data already written. It does not need Amazon: the duplicate
// copies are byte-identical, so the excess can be identified and removed
// locally, with no SP-API quota spent and no risk of a settlement Amazon no
// longer serves being lost to a delete-then-refetch.
//
// Amazon's own checksum decides what is correct. A settlement's lines sum
// exactly to the total-amount on its header row - verified across 52
// settlements in five real documents, to the paisa. So:
//
//   * a settlement whose rows already sum to its header total is left
//     untouched, whatever it looks like;
//   * a settlement whose rows sum to an exact integer multiple d of its
//     header total was imported d times, and exactly one copy in d of every
//     identical group is kept;
//   * anything else is reported and skipped, never guessed at.
//
// Everything runs in one transaction and every repaired settlement is
// re-checked against its header total before commit. If a single one does not
// balance afterwards, the whole run rolls back and nothing changes.
//
// Usage:
//   DATABASE_URL=... node apps/api/scripts/repair-duplicated-settlements.mjs [--tenant <uuid>]
//   DATABASE_URL=... node apps/api/scripts/repair-duplicated-settlements.mjs --apply
//
// Without --apply it only reports. Read the report before applying.
import pg from 'pg';

const apply = process.argv.includes('--apply');
const tenantArg = process.argv.indexOf('--tenant');
const onlyTenant = tenantArg > -1 ? process.argv[tenantArg + 1] : null;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Set DATABASE_URL to the database holding settlement_rows.');
  process.exit(2);
}

const money = value => Number(value ?? 0);
const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;
const inr = value => value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// RDS needs SSL; a local socket or localhost does not offer it at all.
const isLocal = /host=\/|@localhost|@127\.0\.0\.1/.test(connectionString);
const pool = new pg.Pool({ connectionString, ssl: isLocal ? false : { rejectUnauthorized: false } });
const client = await pool.connect();

try {
  await client.query('begin');

  // The header row is the one that STATES a total-amount. It is not the row
  // with an empty transaction-type: real money rows leave that blank too
  // (FBAInboundTransportationFee and its CGST/SGST), and reading their empty
  // total as zero would condemn a perfectly balanced settlement.
  const settlements = await client.query(`
    select tenant_id, settlement_id,
           count(*) row_count,
           round(sum(amount)::numeric, 2) rows_total,
           round(max(coalesce(nullif(raw->>'total-amount',''), nullif(raw->>'total amount',''), nullif(raw->>'totalAmount',''))::numeric), 2) header_total
      from settlement_rows
     where settlement_id is not null and settlement_id <> ''
       and ($1::uuid is null or tenant_id = $1::uuid)
     group by tenant_id, settlement_id
    having max(coalesce(nullif(raw->>'total-amount',''), nullif(raw->>'total amount',''), nullif(raw->>'totalAmount',''))::numeric) is not null
     order by tenant_id, settlement_id`, [onlyTenant]);

  const repairable = [];
  const unexplained = [];
  for (const row of settlements.rows) {
    const header = money(row.header_total);
    const stored = money(row.rows_total);
    if (Math.abs(stored - header) <= 0.01) continue;
    // How many times over was it stored? Only an exact integer multiple is a
    // duplication this script understands.
    const copies = header === 0 ? 0 : Math.round(stored / header);
    if (copies >= 2 && Math.abs(stored - copies * header) <= 0.01) repairable.push({ ...row, copies, header, stored });
    else unexplained.push({ ...row, header, stored });
  }

  console.log(`${settlements.rowCount} settlement(s) examined${onlyTenant ? ` for tenant ${onlyTenant.slice(0, 8)}` : ''}`);
  console.log(`  ${settlements.rowCount - repairable.length - unexplained.length} already balance against Amazon's document total`);
  console.log(`  ${repairable.length} stored a whole number of times over`);
  console.log(`  ${unexplained.length} out of balance for some other reason - these are NOT touched\n`);

  for (const row of unexplained) {
    console.log(`  ! ${row.settlement_id}  Amazon ${inr(row.header)}  stored ${inr(row.stored)}  (not an exact multiple - left alone)`);
  }
  if (unexplained.length) console.log();

  let deletedTotal = 0;
  let reclaimed = 0;
  for (const row of repairable) {
    // Identical copies differ only by source_key, so group on everything that
    // describes the line itself and keep the first 1-in-d of each group.
    const deleted = await client.query(`
      with ranked as (
        select id, row_number() over (
                 partition by tenant_id, settlement_id, order_id, amount_type, amount_description, amount, posted_date, raw
                 order by id
               ) copy_number,
               count(*) over (
                 partition by tenant_id, settlement_id, order_id, amount_type, amount_description, amount, posted_date, raw
               ) copies_present
          from settlement_rows
         where tenant_id = $1 and settlement_id = $2
      )
      delete from settlement_rows
       where id in (select id from ranked where copy_number > copies_present / $3)
      returning amount`, [row.tenant_id, row.settlement_id, row.copies]);

    const check = await client.query(
      'select round(sum(amount)::numeric, 2) rows_total from settlement_rows where tenant_id=$1 and settlement_id=$2',
      [row.tenant_id, row.settlement_id]
    );
    const after = money(check.rows[0]?.rows_total);
    const balanced = Math.abs(after - row.header) <= 0.01;
    console.log(`  ${balanced ? 'ok' : 'FAIL'}  ${row.settlement_id}  stored ${inr(row.stored)} (${row.copies}x)  ->  ${inr(after)}  Amazon ${inr(row.header)}  [-${deleted.rowCount} rows]`);
    if (!balanced) {
      await client.query('rollback');
      console.error(`\nAborted: ${row.settlement_id} does not balance after de-duplication. Nothing was changed.`);
      process.exit(1);
    }
    deletedTotal += deleted.rowCount;
    reclaimed += round2(row.stored - after);
  }

  console.log(`\n${deletedTotal} duplicate row(s) would be removed, clearing ${inr(round2(reclaimed))} of money this tool invented.`);

  if (apply) {
    await client.query('commit');
    console.log('APPLIED. Every repaired settlement now matches Amazon\'s own document total.');
  } else {
    await client.query('rollback');
    console.log('Dry run - nothing changed. Re-run with --apply to keep these deletions.');
  }
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  console.error('Failed, nothing changed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
