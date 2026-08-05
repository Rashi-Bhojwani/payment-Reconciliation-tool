// Must come first: index.js reads process.env.DATABASE_URL at module load, so
// the .env has to be in place before that line runs. Importing this here means
// every consumer - the API, migrate.js, and any standalone script - gets the
// same configuration without having to remember to load it.
import { databaseUrl as configuredDatabaseUrl } from './env.js';
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
// configuredDatabaseUrl() returns null for a placeholder as well as for a
// missing value, so a checkout that still carries the sample value fails the
// same way as one with nothing set, instead of failing deep inside the driver.
const databaseUrl = configuredDatabaseUrl();
export const databaseUrlConfigured = Boolean(databaseUrl);

// node-postgres waits FOREVER for a free connection by default: pool.connect()
// returns a promise that simply never settles once all `max` clients are
// checked out. A request that hits that never sends a response and never logs
// an error - the browser tab just spins. That is not hypothetical here: the
// Amazon OAuth callback checks out a client to store the refresh token at the
// same moment the newly authorized seller's first background sync is running,
// so the one request a seller cannot afford to lose is the one most likely to
// queue. A bounded wait turns an invisible hang into an error we can redirect
// on and a message we can show.
const positiveEnvInt = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
export const poolSettings = {
  max: positiveEnvInt('DATABASE_POOL_MAX', 10),
  idleTimeoutMillis: positiveEnvInt('DATABASE_POOL_IDLE_TIMEOUT_MS', 30_000),
  connectionTimeoutMillis: positiveEnvInt('DATABASE_POOL_CONNECTION_TIMEOUT_MS', 15_000)
};
export const pool = new Pool({
  connectionString: databaseUrlConfigured ? databaseUrl : undefined,
  ssl: databaseUrlConfigured ? { rejectUnauthorized: false } : false,
  ...poolSettings
});
// An idle client that dies (a dropped tunnel, a database restart) emits 'error'
// on the pool. Without a listener that is an unhandled 'error' event, which
// takes the whole API process down.
pool.on('error', error => {
  console.error('[db] idle client error:', error?.message ?? error);
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
