import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || "postgresql://reconciliation:Rashib123@reconciliation-db.cvi6iwyo0o2r.ap-south-1.rds.amazonaws.com:5432/postgres";
export const databaseUrlConfigured = Boolean(databaseUrl && databaseUrl !== 'HEHE');
const databaseSslCa = process.env.DATABASE_SSL_CA && process.env.DATABASE_SSL_CA !== 'HEHE'
  ? process.env.DATABASE_SSL_CA.replaceAll('\\n', '\n')
  : undefined;

export const pool = new Pool({
  connectionString: databaseUrlConfigured ? databaseUrl : undefined,
  ssl: databaseUrlConfigured && true
    ? {
        rejectUnauthorized: false,
        ...(databaseSslCa ? { ca: databaseSslCa } : {})
      }
    : false
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
