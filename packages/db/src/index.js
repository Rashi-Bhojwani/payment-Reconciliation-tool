import pg from 'pg';
import { loadDotEnv } from './env.js';

loadDotEnv();

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

/** @param {string} tenantId */
export async function assertActiveTenant(tenantId) {
  const result = await pool.query('select status from tenants where id = $1', [tenantId]);
  if (result.rows[0]?.status !== 'active') {
    const status = result.rows[0]?.status ?? 'missing';
    throw Object.assign(new Error(`Tenant access denied: ${status}`), { statusCode: 403 });
  }
}
