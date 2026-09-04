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
//
// THE SECOND THING THIS FILE DOES is bind a tenant to the connection a query
// runs on. See withSchedulingTenant() and query() below - in the standalone
// tool that was unnecessary, and here it is the difference between a
// repository returning the right rows and returning none at all.
import { AsyncLocalStorage } from 'node:async_hooks';
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

// The connection the current tenant scope is bound to, if any. AsyncLocalStorage
// rather than a parameter because the alternative was threading a client
// argument through forty ported files that already work.
const tenantScope = new AsyncLocalStorage();

// Every table migration 025 protects with a row-level security policy. The
// policy reads `app.current_tenant_id`, which is a per-CONNECTION setting - so
// a query that runs on an unbound pooled connection matches nothing.
//
// That is the failure this list exists to catch. FORCE ROW LEVEL SECURITY
// means an unbound query does not error, it succeeds and returns ZERO ROWS:
// an empty orders page, a "no shipments" screen, a sync that silently decides
// there is nothing to sync. Wrong-and-quiet is the worst possible shape for
// this bug, so an unbound query against one of these tables is turned into a
// loud error instead.
//
// `marketplaces` (a four-row global lookup) and `audit_logs` (deliberately
// unprotected so entries outlive the tenant they describe) are absent on
// purpose - those are legitimately readable with no tenant bound.
const RLS_PROTECTED_TABLES =
  /\b(marketplace_accounts|marketplace_connection_requests|order_items|orders|package_items|packages|shipments)\b/i;

function assertTenantBound(text) {
  if (tenantScope.getStore()) return;
  if (!RLS_PROTECTED_TABLES.test(text)) return;
  throw new Error(
    'Scheduling query touched a tenant-scoped table with no tenant bound. ' +
    'Row-level security would have returned zero rows rather than failing, so this ' +
    'is raised instead. Wrap the call in withSchedulingTenant(tenantId, ...), or pass ' +
    'an explicit client that is already bound.',
  );
}

/**
 * Run a query.
 *
 * Resolution order, and each step is deliberate:
 *  1. an explicit `client` - a caller inside a transaction, already bound;
 *  2. the client withSchedulingTenant() bound for this async context, which
 *     is what every repository call from a route or job actually uses;
 *  3. the raw pool, for the two tables that carry no tenant at all.
 */
export function query(text, params, client) {
  if (client) return client.query(text, params);
  const scope = tenantScope.getStore();
  if (scope) return scope.client.query(text, params);
  assertTenantBound(text);
  return pool.query(text, params);
}

/**
 * Run `fn` inside a transaction, passing it the dedicated client.
 * Commits on resolve, rolls back on throw, always releases.
 *
 * Inside a withSchedulingTenant scope this reuses that scope's already-bound
 * connection rather than checking out a second one. It has to: a fresh
 * connection would carry no `app.current_tenant_id`, so every write in the
 * transaction would be rejected by the same policies the surrounding reads
 * pass. Reusing it is safe because the scope owns that connection exclusively
 * for its whole lifetime, and nothing in the ported code nests one
 * transaction inside another.
 */
export async function withTransaction(fn) {
  const scope = tenantScope.getStore();
  if (scope) {
    // One connection means one transaction at a time. Two overlapping
    // withTransaction calls on the same scope would issue BEGIN inside an open
    // transaction (Postgres warns and ignores it) and then the first COMMIT
    // would commit BOTH - so a rollback in the second would silently roll back
    // nothing. Nothing in the ported services does this: every one of them
    // walks its work with a sequential `for ... of await` loop. This is here so
    // that if that ever changes, it changes with an error rather than with
    // occasional half-written data.
    if (scope.inTransaction) {
      throw new Error(
        'A scheduling transaction is already open on this tenant scope. Two overlapping transactions cannot share one connection - run them sequentially, or give the second its own scope.',
      );
    }
    scope.inTransaction = true;
    await scope.client.query('BEGIN');
    try {
      const result = await fn(scope.client);
      await scope.client.query('COMMIT');
      return result;
    } catch (error) {
      await scope.client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      scope.inTransaction = false;
    }
  }

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
 * Scheduling's equivalent of @recon/db's withTenant: binds one connection to
 * one tenant for the duration of `fn`, so the row-level policies from
 * migration 025 admit that tenant's rows and only that tenant's rows.
 *
 * The repositories all take sellerId as their first argument and put it in the
 * WHERE clause, so this is a second, independent line of defence rather than
 * the only one - a repository function that forgot its sellerId returns
 * nothing here instead of another tenant's orders.
 *
 * Re-entrant: a nested call for the SAME tenant reuses the bound connection
 * instead of checking out a second one and deadlocking against a transaction
 * the outer scope may be holding. A nested call for a DIFFERENT tenant is a
 * bug - it would mean one request is trying to act as two tenants - and is
 * refused rather than silently reinterpreted.
 */
export async function withSchedulingTenant(tenantId, fn) {
  if (!tenantId) throw new Error('withSchedulingTenant requires a tenant id');
  const existing = tenantScope.getStore();
  if (existing) {
    if (existing.tenantId !== tenantId) {
      throw new Error(
        `Refusing to switch scheduling tenant scope from ${existing.tenantId} to ${tenantId} mid-request.`,
      );
    }
    return fn(existing.client);
  }

  const client = await pool.connect();
  // A checked-out client, held for as long as fn runs - which for an order
  // sync is minutes. Same reasoning as withTransaction above: without this
  // listener a dropped connection is an uncaught 'error' event and takes the
  // process down.
  const onError = (error) => {
    log.error({ err: error, tenantId }, 'tenant-scoped connection dropped');
  };
  client.on('error', onError);
  try {
    await client.query('select set_config($1,$2,false)', ['app.current_tenant_id', tenantId]);
    return await tenantScope.run({ tenantId, client, inTransaction: false }, () => fn(client));
  } finally {
    // Clearing a GUC on a live connection means setting it to the empty
    // string; there is no "unset". The policies in migration 025 compare
    // `seller_id::text` to this value precisely so that '' is an ordinary
    // non-match on the next borrower of this connection rather than a cast
    // error - see the comment on that migration's policy block.
    await client.query("select set_config('app.current_tenant_id','',false)").catch(() => undefined);
    client.removeListener('error', onError);
    client.release();
  }
}

/** The tenant bound to the current async context, if any. */
export function currentSchedulingTenant() {
  return tenantScope.getStore()?.tenantId ?? null;
}

export async function closePool() {
  await pool.end();
}

export default pool;
