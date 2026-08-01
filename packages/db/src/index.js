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
const databaseUrl = "postgresql://reconciliation:Rashib123@reconciliation-db.cvi6iwyo0o2r.ap-south-1.rds.amazonaws.com:5432/postgres";
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

/** @param {string} tenantId */
export async function assertActiveTenant(tenantId) {
  const result = await pool.query('select status from tenants where id = $1', [tenantId]);
  if (result.rows[0]?.status !== 'active') {
    const status = result.rows[0]?.status ?? 'missing';
    throw Object.assign(new Error(`Tenant access denied: ${status}`), { statusCode: 403 });
  }
}
