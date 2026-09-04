// Test database lifecycle for the DB-backed scheduling tests.
//
// Unlike the standalone tool's version, this does NOT run migrations: the
// platform owns its schema and `npm run db:migrate` applies all 25 files at
// once. These tests assume that has been done and check for it, because
// "relation scheduling.orders does not exist" thirty frames deep is a much
// worse message than saying so up front.
//
// It truncates only the `scheduling` schema plus the tenants and users rows
// these tests create. Reconciliation's own tables are never touched - a
// scratch database usually holds both, and a scheduling test has no business
// deleting settlement rows.
import pg from 'pg';

const url = process.env.DATABASE_URL;

// A second, plain connection alongside the package's own pool. Fixtures need
// to write `public.tenants` and `public.users`, which the scheduling pool's
// search_path and tenant binding are not for, and truncation has to happen
// with no tenant bound at all.
export const admin = new pg.Client({ connectionString: url });
let connected = false;

// Ordered so a truncate is legible; CASCADE handles the rest. `marketplaces`
// is deliberately absent - it is the four-row global lookup seeded by
// migration 025, not per-test state, and truncating it would break every
// foreign key into it and require re-seeding before every single test.
const SCHEDULING_TABLES = [
  'scheduling.audit_logs',
  'scheduling.shipments',
  'scheduling.package_items',
  'scheduling.packages',
  'scheduling.order_items',
  'scheduling.orders',
  'scheduling.marketplace_account_sync_state',
  'scheduling.marketplace_connection_requests',
  'scheduling.marketplace_account_credentials',
  'scheduling.marketplace_accounts',
];

// Every tenant these tests create is named with this prefix, so cleanup can
// be precise instead of "delete from tenants".
export const TEST_TENANT_PREFIX = 'sched-test';

export async function resetDatabase() {
  if (!url) {
    throw new Error('DATABASE_URL is not set. These tests need a THROWAWAY database with `npm run db:migrate` already applied.');
  }
  if (!connected) {
    await admin.connect();
    connected = true;
    const { rows } = await admin.query("select to_regclass('scheduling.orders') as present");
    if (!rows[0].present) {
      throw new Error('The scheduling schema is missing. Run `npm run db:migrate` against this DATABASE_URL first.');
    }
  }
  await admin.query(`TRUNCATE ${SCHEDULING_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  await admin.query('delete from users where email like $1', [`${TEST_TENANT_PREFIX}%`]);
  await admin.query('delete from tenants where company_name like $1', [`${TEST_TENANT_PREFIX}%`]);
}

export async function closeDatabase() {
  await resetDatabase().catch(() => {});
  if (connected) await admin.end().catch(() => {});
  const { closePool } = await import('../../src/db/pool.js');
  await closePool().catch(() => {});
}
