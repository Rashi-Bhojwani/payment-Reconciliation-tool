// Removes settlement rows stored more than once because Amazon's settlement
// reports are rolling windows: one fetch could merge several documents that
// each carried the same settlement, and the ordinal tiebreak in source_key
// gave every copy a different identity, so the upsert could not collapse
// them. See the commit that added dropRepeatedSettlements.
//
// Duplication is NOT uniform, and assuming it was is what made the first
// version of this script fail. Across many syncs a settlement got imported
// repeatedly, and each time the upsert silently absorbed whichever copies
// happened to land on an ordinal they had used before while leaving the rest.
// Measured on a real account: settlements sitting at 1.0080x, 1.0121x,
// 1.0601x, 1.4361x, 1.5049x and 2.0466x of their true value - and one at
// exactly 2.0000x whose individual rows were still not evenly doubled.
//
// So nothing is assumed. Amazon states each settlement's total on its header
// row, and a settlement's lines sum to it exactly - verified across 52
// settlements in five real documents, to the paisa. This tries the repairs
// that could be right, checks each against that total, and keeps only the one
// that balances. A settlement it cannot balance is reported untouched, never
// guessed at.
//
// Every settlement is repaired inside its own savepoint, so one that cannot
// be fixed neither blocks the others nor leaves anything half-done.
//
// Usage:
//   DATABASE_URL=... node apps/api/scripts/repair-duplicated-settlements.mjs
//   DATABASE_URL=... node apps/api/scripts/repair-duplicated-settlements.mjs --apply
//   ... --tenant <uuid>          limit to one account
//   ... --apply --refetch-rest   also clear settlements that cannot be repaired
//                                locally, so the next sync re-imports them
// Without --apply it only reports.
import pg from 'pg';

const apply = process.argv.includes('--apply');
const refetchRest = process.argv.includes('--refetch-rest');
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

// Everything source_key is built from except the ordinal. Two rows agreeing on
// all of it are exactly the rows the ordinal was invented to keep apart - so
// they are also exactly the rows a repeated import could have duplicated.
const IDENTITY = `settlement_id, order_id, amount_type, amount_description, amount, posted_date,
  raw->>'transaction-type', raw->>'order-item-code', raw->>'merchant-order-item-id',
  raw->>'merchant-adjustment-item-id', raw->>'shipment-id', raw->>'adjustment-id',
  raw->>'sku', raw->>'quantity-purchased', raw->>'promotion-id', raw->>'posted-date-time'`;

const isLocal = /host=\/|@localhost|@127\.0\.0\.1/.test(connectionString);
const pool = new pg.Pool({ connectionString, ssl: isLocal ? false : { rejectUnauthorized: false } });
const client = await pool.connect();

const storedTotal = async (tenantId, settlementId) => money((await client.query(
  'select round(sum(amount)::numeric, 2) total from settlement_rows where tenant_id=$1 and settlement_id=$2',
  [tenantId, settlementId]
)).rows[0]?.total);

// Keep `keepExpr` copies of every identical group, delete the rest.
const trimTo = (tenantId, settlementId, keepExpr) => client.query(`
  with ranked as (
    select id,
           row_number() over (partition by ${IDENTITY} order by id) copy_number,
           count(*)     over (partition by ${IDENTITY}) copies_present
      from settlement_rows
     where tenant_id = $1 and settlement_id = $2
  )
  delete from settlement_rows
   where id in (select id from ranked where copy_number > ${keepExpr})`, [tenantId, settlementId]);

try {
  await client.query('begin');

  // The header row is the one that STATES a total-amount. Not the one with an
  // empty transaction-type: real money rows leave that blank too
  // (FBAInboundTransportationFee and its CGST/SGST), and reading their empty
  // total as zero condemns a perfectly balanced settlement.
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

  const broken = settlements.rows
    .map(row => ({ ...row, header: money(row.header_total), stored: money(row.rows_total) }))
    .filter(row => Math.abs(row.stored - row.header) > 0.01);

  console.log(`${settlements.rowCount} settlement(s) examined${onlyTenant ? ` for tenant ${onlyTenant.slice(0, 8)}` : ''}`);
  console.log(`  ${settlements.rowCount - broken.length} already match Amazon's document total`);
  console.log(`  ${broken.length} do not\n`);

  const repaired = [];
  const stuck = [];
  let deletedTotal = 0;

  for (const row of broken) {
    const { tenant_id: tenantId, settlement_id: settlementId, header, stored } = row;

    if (stored < header - 0.01) {
      stuck.push({ ...row, why: 'holds LESS than Amazon states - rows are missing, not duplicated' });
      continue;
    }

    // Candidate repairs, least destructive first. Each is checked against
    // Amazon's own total and abandoned if it does not land exactly.
    const copies = header === 0 ? 0 : Math.round(stored / header);
    const strategies = [
      ['one copy of each identical line', '1'],
      ...(copies >= 2 ? [[`one copy in ${copies} of each identical line`, `copies_present / ${copies}`]] : [])
    ];

    let fixed = null;
    for (const [label, keepExpr] of strategies) {
      await client.query('savepoint attempt');
      const deleted = await trimTo(tenantId, settlementId, keepExpr);
      const after = await storedTotal(tenantId, settlementId);
      if (Math.abs(after - header) <= 0.01) {
        await client.query('release savepoint attempt');
        fixed = { label, deleted: deleted.rowCount, after };
        break;
      }
      await client.query('rollback to savepoint attempt');
    }

    if (fixed) {
      repaired.push({ ...row, ...fixed });
      deletedTotal += fixed.deleted;
      console.log(`  ok    ${settlementId}  ${inr(stored)} -> ${inr(fixed.after)}  (Amazon ${inr(header)})  -${fixed.deleted} rows, kept ${fixed.label}`);
    } else {
      const spread = await client.query(`
        select copies_present, count(*) groups from (
          select count(*) copies_present from settlement_rows
           where tenant_id=$1 and settlement_id=$2 group by ${IDENTITY}
        ) t group by copies_present order by copies_present`, [tenantId, settlementId]);
      const shape = spread.rows.map(r => `${r.groups} group(s) x${r.copies_present}`).join(', ');
      stuck.push({ ...row, why: `no de-duplication lands on ${inr(header)}; copies per identical line: ${shape}` });
    }
  }

  if (stuck.length) {
    console.log(`\n${stuck.length} settlement(s) could not be repaired locally and were left untouched:`);
    for (const row of stuck) console.log(`  !     ${row.settlement_id}  Amazon ${inr(row.header)}  stored ${inr(row.stored)}\n          ${row.why}`);
  }

  const reclaimed = round2(repaired.reduce((sum, row) => sum + (row.stored - row.after), 0));
  console.log(`\n${repaired.length} settlement(s) repaired, ${deletedTotal} duplicate row(s) removed, ${inr(reclaimed)} of invented money cleared.`);

  if (refetchRest && stuck.length) {
    let cleared = 0;
    for (const row of stuck) {
      const deleted = await client.query('delete from settlement_rows where tenant_id=$1 and settlement_id=$2', [row.tenant_id, row.settlement_id]);
      cleared += deleted.rowCount;
    }
    // Clearing this cache costs nothing but a re-examination: documents are
    // immutable, and re-importing one writes back the identical rows.
    const tenants = [...new Set(stuck.map(row => row.tenant_id))];
    for (const tenantId of tenants) {
      await client.query("delete from processed_report_documents where tenant_id=$1 and report_type='GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'", [tenantId]);
    }
    console.log(`--refetch-rest: cleared ${cleared} row(s) across ${stuck.length} unrepairable settlement(s); the next settlement sync will re-import them cleanly.`);
  } else if (stuck.length) {
    console.log('Re-run with --apply --refetch-rest to clear those and let the next sync re-import them from Amazon.');
  }

  if (apply) {
    await client.query('commit');
    console.log('APPLIED.');
  } else {
    await client.query('rollback');
    console.log('Dry run - nothing changed. Re-run with --apply to keep this.');
  }
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  console.error('Failed, nothing changed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
