// The scheduling tool's Postgres access, pointed at this platform's database.
//
// THE SEARCH PATH IS THE WHOLE POINT OF THIS FILE.
// Every ported repository queries unqualified table names - `FROM orders`,
// `FROM packages`, `FROM shipments`. Those tables now live in the
// `scheduling` schema (see migration 025), and `orders` also exists in
// `public` as something completely different: reconciliation's six-column
// order row. So this pool sets `search_path = scheduling, public` on every
// connection, and unqualified names resolve to the scheduling tables while
// cross-schema references (public.tenants, public.users) still work by
// being written out in full.
//
// That is why this is a SEPARATE pool rather than reusing @recon/db's. On a
// shared pool the same search_path would apply to reconciliation's queries
// too, and `select ... from orders` in the dashboard would silently start
// reading scheduling.orders - a 25-column table with none of the columns it
// expects. Two pools to one database costs a handful of connections and
// removes that failure mode entirely.
import pg from 'pg';
import { config } from '../config.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('db');

// Return NUMERIC as a string rather than a lossy JS float. Money and weights
// are handed to decimal.js, never to Number(). (pg type OID 1700 = numeric)
pg.types.setTypeParser(1700, (value) => value);
// BIGINT (OID 20) as string too - audit_logs.id is a bigserial.
pg.types.setTypeParser(20, (value) => value);

export const pool = new pg.Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'order-scheduling',
  // Set per-connection by the server, so it survives pool recycling - doing
  // it once at startup would only configure whichever connection happened to
  // be open at the time.
  options: '-c search_path=scheduling,public',
  // TCP keepalive - a real production sync crashed the server with
  // "Connection terminated unexpectedly" after a connection was held open for
  // several minutes (order sync's per-account advisory lock; see
  // orderSyncService.js). A long-idle TCP connection over a home network,
  // VPN, or NAT is a common thing to get silently dropped by a router or
  // firewall with no FIN/RST either side sees in time; keepalive probes keep
  // it visibly alive (or fail fast and reconnect) instead of going silently
  // stale until a write finally reveals it's dead.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

pool.on('error', (error) => {
  // An idle client blew up; pg replaces it. Log, never crash the process.
  log.error({ err: error }, 'idle postgres client error');
});

/** Run a query on the pool (or on `client` when inside a transaction). */
export function query(text, params, client) {
  return (client ?? pool).query(text, params);
}

/**
 * Run `fn` inside a transaction, passing it the dedicated client.
 * Commits on resolve, rolls back on throw, always releases.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  // Same crash class as orderSyncService.js's sync lock: a checked-out client
  // isn't covered by pool.on('error', ...) above (idle clients only) - an
  // unhandled 'error' event on it crashes the whole process, not just this
  // transaction. Named and explicitly removed below: pg-pool reuses the same
  // underlying Client across many checkouts, so an anonymous listener added
  // on every call and never removed accumulates forever - Node warns past 10
  // and it's a real (if slow) leak in a long-running server.
  const onError = (error) => {
    log.error({ err: error }, 'transaction connection dropped mid-transaction');
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.removeListener('error', onError);
    client.release();
  }
}

/**
 * Scheduling's equivalent of @recon/db's withTenant: binds a connection to one
 * tenant for the duration of `fn`, so the row-level policies from migration
 * 025 can enforce isolation.
 *
 * The repositories all take sellerId as their first argument and put it in the
 * WHERE clause, so this is a second, independent line of defence rather than
 * the only one - a repository function that forgot its sellerId would return
 * nothing here instead of another tenant's orders.
 */
export async function withSchedulingTenant(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('select set_config($1,$2,false)', ['app.current_tenant_id', tenantId]);
    return await fn(client);
  } finally {
    await client.query("select set_config('app.current_tenant_id','',false)").catch(() => undefined);
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}

export default pool;
