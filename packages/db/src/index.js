import pg from 'pg';

// node-postgres's default DATE (OID 1082) parser builds a JS Date using the
// server process's LOCAL system timezone (new Date(year, month-1, day)),
// then callers serialize it with .toISOString() (UTC) - so the exact same
// stored SQL date renders differently depending on what timezone the Node
// process happens to run in. Confirmed directly: on an IST machine, SQL
// DATE '2026-07-25' serializes as "2026-07-24T18:30:00.000Z" - silently
// shifted a day earlier as far as any UTC-based reader (`new Date(...,
// {timeZone:'UTC'})`, a raw string compare, etc.) is concerned. A backend
// that behaves differently in dev (often non-UTC) versus production (often
// UTC) for date-only columns - return_date, invoice_date,
// reimbursement_date, snapshot_date, and settlement payouts grouped by
// date(posted_date) - is exactly the kind of bug that "works on my machine"
// and then doesn't. Returning the raw "YYYY-MM-DD" string instead removes
// the timezone conversion entirely, so every environment behaves the same.
pg.types.setTypeParser(1082, value => value);

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
export const databaseUrlConfigured = Boolean(databaseUrl && databaseUrl !== 'HEHE');
export const pool = new Pool({
  connectionString: databaseUrlConfigured ? databaseUrl : undefined,
  ssl: databaseUrlConfigured ? { rejectUnauthorized: false } : false
});

/**
 * Runs DB work with the Postgres RLS tenant context set for the checked-out client.
 * @template T
 * @param {string} tenantId
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTenant(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('select set_config($1,$2,false)', ['app.current_tenant_id', tenantId]);
    return await fn(client);
  } finally {
    await client.query("select set_config('app.current_tenant_id','',false)").catch(() => undefined);
    client.release();
  }
}

/**
 * Same tenant context as withTenant, but the whole callback runs inside one
 * Postgres transaction, so no other connection can observe a partially applied
 * write set.
 *
 * This matters for any sync that refreshes a table by deleting rows and
 * re-inserting them. Without a transaction those are separate autocommitted
 * statements, and a dashboard request landing between the delete and the
 * insert reads a table with rows missing - producing money figures that are
 * silently, invisibly wrong for the duration of the sync. Observed live: the
 * same tenant and date range reported 4038 finance rows on one render and
 * 1426 on the next, because finance_transaction_items was mid-refresh.
 *
 * set_config's third argument is true here so the tenant setting is scoped to
 * the transaction and is released by COMMIT/ROLLBACK rather than lingering on
 * a pooled connection.
 * @template T
 * @param {string} tenantId
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTenantTransaction(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1,$2,true)', ['app.current_tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.query("select set_config('app.current_tenant_id','',false)").catch(() => undefined);
    client.release();
  }
}

/** @param {string} tenantId */
export async function assertActiveTenant(tenantId) {
  const result = await pool.query('select status from tenants where id = $1', [tenantId]);
  if (result.rows[0]?.status !== 'active') {
    const status = result.rows[0]?.status ?? 'missing';
    throw Object.assign(new Error(`Tenant access denied: ${status}`), { statusCode: 403 });
  }
}
