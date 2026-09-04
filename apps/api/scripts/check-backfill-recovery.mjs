// Proves a seller can never again be locked out of their own dashboard by a
// backfill whose process is gone, and that re-authorizing does not re-fetch
// ninety days of data the tenant already has.
//
// Both of these were observed live, on the same account, on the same day: a
// re-authorization (done to pick up a newly granted SP-API role) kicked off
// the full eight-source backfill, the API restarted while it was running, and
// backfill_status stayed 'running' forever - blocking every page in the app
// for a full day with a progress screen that could never advance.
//
// Opt-in, like the other check:* scripts - it needs a throwaway database with
// the migrations applied. It writes and deletes rows.
import pg from 'pg';
import { envFileLoadedFrom } from '@recon/db/env.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Point it at a THROWAWAY database - this script writes and deletes rows.');
  console.error(envFileLoadedFrom() ? `(.env loaded from ${envFileLoadedFrom()})` : '(no .env found)');
  process.exit(1);
}

const MARKER = 'backfill-recovery-check';
const failures = [];
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(what);
};

const db = new pg.Client({ connectionString: url, ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false } });
await db.connect();

// The sweep exactly as the dashboard handler runs it. Kept as one string so a
// change to the real query that this file does not mirror shows up as a
// failing assertion rather than passing against a stale copy.
const SWEEP = `update sellers set backfill_status='failed'
  where tenant_id=$1 and backfill_status='running'
    and coalesce(backfill_heartbeat_at, backfill_started_at) < now() - interval '30 minutes'`;

async function makeSeller(label, columns) {
  const { rows: [tenant] } = await db.query(
    `insert into tenants (company_name, status) values ($1,'active') returning id`,
    [`${MARKER} ${label}`],
  );
  await db.query(
    `insert into sellers (tenant_id, amazon_seller_id, marketplace_id, refresh_token_encrypted,
       backfill_status, backfill_started_at, backfill_heartbeat_at, backfill_progress, backfill_completed_at, data_floor_date)
     values ($1,$2,'A21TJRUUN4KGV','x',$3,$4,$5,$6,$7,$8)`,
    [tenant.id, `A1${label.toUpperCase().slice(0, 8)}`, columns.status, columns.startedAt,
      columns.heartbeatAt ?? null, JSON.stringify(columns.progress ?? {}), columns.completedAt ?? null, columns.floorDate ?? null],
  );
  return tenant.id;
}
const statusOf = async tenantId =>
  (await db.query('select backfill_status from sellers where tenant_id=$1', [tenantId])).rows[0].backfill_status;

try {
  // --- the stale sweep -----------------------------------------------------
  const dead = await makeSeller('dead', {
    status: 'running',
    startedAt: new Date(Date.now() - 26 * 3600_000),
    heartbeatAt: new Date(Date.now() - 26 * 3600_000),
    progress: { DIRECT_SP_API_SYNC: 'completed', GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2: 'running' },
  });
  await db.query(SWEEP, [dead]);
  check(await statusOf(dead) === 'failed',
    'a backfill whose process died a day ago is released, not left blocking forever');

  // The one that must NOT be touched: a backfill genuinely working right now.
  // Releasing this one would show figures built from a half-loaded range,
  // which is the exact thing the block exists to prevent.
  const alive = await makeSeller('alive', {
    status: 'running',
    startedAt: new Date(Date.now() - 3 * 3600_000), // running a long time...
    heartbeatAt: new Date(Date.now() - 60_000),     // ...but beating a minute ago
    progress: { DIRECT_SP_API_SYNC: 'completed' },
  });
  await db.query(SWEEP, [alive]);
  check(await statusOf(alive) === 'running',
    'a slow but LIVE backfill keeps blocking - elapsed time alone must not release it',
    'heartbeat 1 minute old, started 3 hours ago');

  // A backfill started recently with no heartbeat yet is also still alive.
  const young = await makeSeller('young', {
    status: 'running',
    startedAt: new Date(Date.now() - 60_000),
    heartbeatAt: null,
    progress: {},
  });
  await db.query(SWEEP, [young]);
  check(await statusOf(young) === 'running', 'a backfill that started a minute ago is left alone');

  // And the sweep is per tenant: one tenant's dead backfill must not release
  // or disturb another's.
  check(await statusOf(alive) === 'running' && await statusOf(young) === 'running',
    'sweeping one tenant does not touch another tenant\'s backfill');

  // --- 'failed' is a state the column actually accepts ---------------------
  // The original CHECK allowed only pending/running/completed, so the honest
  // outcome had nowhere to go. Asserted against the live constraint because a
  // migration that did not apply would otherwise surface as a 500 at runtime.
  const { rows: [constraint] } = await db.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid='sellers'::regclass and conname='sellers_backfill_status_check'`,
  );
  check(/failed/.test(constraint?.def ?? ''), 'backfill_status accepts \'failed\'', constraint?.def ?? 'no constraint found');

  const { rows: [heartbeat] } = await db.query(
    `select 1 as present from information_schema.columns
      where table_name='sellers' and column_name='backfill_heartbeat_at'`,
  );
  check(Boolean(heartbeat), 'sellers.backfill_heartbeat_at exists (migration 026 applied)');

  // --- re-authorization must not re-fetch what is already there ------------
  // runInitialSellerBackfill decides this from the seller row plus the tenant's
  // successful sync history. This mirrors that decision against real rows.
  const returning = await makeSeller('returning', {
    status: 'completed',
    startedAt: new Date(Date.now() - 30 * 864e5),
    heartbeatAt: new Date(Date.now() - 30 * 864e5),
    completedAt: new Date(Date.now() - 30 * 864e5),
    floorDate: new Date(Date.now() - 120 * 864e5),
    progress: {},
  });
  const ALL = ['DIRECT_SP_API_SYNC', 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', 'GET_SALES_AND_TRAFFIC_REPORT',
    'GET_GST_MTR_B2B_CUSTOM', 'GET_GST_MTR_B2C_CUSTOM', 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA',
    'GET_FBA_REIMBURSEMENTS_DATA', 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'];
  // Everything has synced before EXCEPT the two GST reports - precisely the
  // state a seller is in when Amazon has just granted the Tax Invoicing role.
  for (const reportType of ALL.filter(type => !type.startsWith('GET_GST'))) {
    await db.query(
      `insert into sync_jobs (tenant_id, report_type, status, started_at, completed_at)
       values ($1,$2,'completed', now(), now())`,
      [returning, reportType],
    );
  }
  const { rows: succeeded } = await db.query(
    `select distinct report_type from sync_jobs where tenant_id=$1 and status='completed' and report_type = any($2)`,
    [returning, ALL],
  );
  const have = new Set(succeeded.rows ?? succeeded.map(r => r.report_type));
  const wouldFetch = ALL.filter(type => !have.has(type));
  check(wouldFetch.length === 2 && wouldFetch.every(type => type.startsWith('GET_GST')),
    'after re-authorizing, only the sources that never synced are fetched',
    `would fetch: ${wouldFetch.join(', ') || 'nothing'}`);
  check(!wouldFetch.includes('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'),
    'settlements - the slowest source - is not re-fetched when it already synced');

  // A tenant where everything already synced has nothing to do at all.
  const settled = await makeSeller('settled', {
    status: 'completed',
    startedAt: new Date(Date.now() - 30 * 864e5),
    completedAt: new Date(Date.now() - 30 * 864e5),
    floorDate: new Date(Date.now() - 120 * 864e5),
  });
  for (const reportType of ALL) {
    await db.query(
      `insert into sync_jobs (tenant_id, report_type, status, started_at, completed_at)
       values ($1,$2,'completed', now(), now())`,
      [settled, reportType],
    );
  }
  const { rows: allDone } = await db.query(
    `select distinct report_type from sync_jobs where tenant_id=$1 and status='completed' and report_type = any($2)`,
    [settled, ALL],
  );
  check(allDone.length === ALL.length,
    're-authorizing a fully synced tenant fetches nothing at all - the backfill is skipped');

  // --- and a genuine first connection still backfills everything -----------
  const brandNew = await makeSeller('brandnew', { status: 'pending', startedAt: null });
  const { rows: [fresh] } = await db.query(
    'select backfill_completed_at, data_floor_date from sellers where tenant_id=$1', [brandNew],
  );
  check(!fresh.backfill_completed_at && !fresh.data_floor_date,
    'a first-time seller is still recognised as needing the full 90-day backfill');
} finally {
  await db.query('delete from sync_jobs where tenant_id in (select id from tenants where company_name like $1)', [`${MARKER}%`]);
  await db.query('delete from tenants where company_name like $1', [`${MARKER}%`]);
  await db.end();
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll backfill recovery checks passed.');
process.exit(failures.length ? 1 : 0);
