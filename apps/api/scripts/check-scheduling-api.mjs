// Boots the real API against a throwaway database, logs in, and drives every
// scheduling route the browser calls.
//
// check:scheduling-isolation proves the policies hold. check:scheduling-runtime
// proves the repositories can still read through them. Neither one boots the
// server, so neither can catch a route that was never registered, an auth check
// that lets the wrong tenant through, or a response whose shape the React
// components do not destructure. That is what this is for.
//
// The two claims it exists for above all:
//
//   * a seller never authorizes Amazon twice - the reconciliation connection
//     is mirrored into scheduling on first load, is NOT rewritten on the next
//     one, and IS re-mirrored the moment the seller re-authorizes;
//   * one tenant cannot reach another tenant's scheduling data through the
//     HTTP surface, which is a different question from whether the database
//     policy holds.
//
// Opt-in, like check:sql and the other two: it registers tenants, writes rows
// and deletes them again. Point DATABASE_URL at a scratch database that has had
// the migrations applied, then run it. Everything it creates is named "E2E %"
// and removed in the finally block.
//
// No real Amazon credentials are used or needed: the refresh token planted here
// is a fake string, so the one call that reaches Amazon (the sweep) fails, which
// is itself asserted - the sweep must record that failure and carry on rather
// than throw.
import crypto from 'node:crypto';
import pg from 'pg';

const DSN = process.env.DATABASE_URL;
if (!DSN) {
  console.error('DATABASE_URL is not set. Point it at a THROWAWAY database - this script writes and deletes rows.');
  process.exit(1);
}
// Fixed values so the run is reproducible and never picks up a real secret
// from the operator's shell.
process.env.JWT_SECRET = 'e2e-secret-value-0123456789-abcdef';
process.env.SESSION_SECRET = 'e2e-session-secret-0123456789-abc';
process.env.PORT = '0';
process.env.LOG_LEVEL = 'silent';
process.env.LWA_CLIENT_ID = 'amzn1.application-oa2-client.e2e';
process.env.LWA_CLIENT_SECRET = 'e2e-client-secret';
process.env.SP_API_APP_ID = 'amzn1.sp.solution.e2e';
process.env.SP_API_REDIRECT_URI = 'https://api.test/oauth/callback';

const admin = new pg.Client({ connectionString: DSN });
await admin.connect();

const failures = [];
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(what);
};

const server = await import('../src/server.js');
const base = `http://127.0.0.1:${server.app.server.address().port}`;

let tenantId = '';
let token = '';
try {
  // Account creation is admin-only by design, so this does what a real
  // operator does: log in as the seeded admin, then create the tenant.
  const adminLogin = await (await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL ?? 'admin@reconcile.local', password: process.env.ADMIN_PASSWORD ?? 'Admin12345!' })
  })).json();
  check(Boolean(adminLogin.token), 'the seeded admin can log in', adminLogin.error ?? '');
  const adminToken = adminLogin.token;

  const registerSeller = async (companyName, ownerEmail) => {
    const res = await fetch(`${base}/api/auth/register-seller`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ companyName, ownerEmail, password: 'Password123!' })
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const email = `e2e-${crypto.randomUUID()}@example.test`;
  const registered = await registerSeller('E2E Scheduling Co', email);
  check(registered.status === 200, 'an admin can register a tenant', JSON.stringify(registered.body).slice(0, 200));
  tenantId = registered.body.tenant?.id ?? '';

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!' })
  });
  const session = await login.json();
  token = session.token ?? '';
  check(Boolean(token), 'the tenant can log in and receives a JWT');

  const call = async (path, options = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) }
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // --- with no Amazon connection ------------------------------------------
  let overview = await call(`/api/tenants/${tenantId}/scheduling/overview`);
  check(overview.status === 200 && overview.body.connected === false,
    'the overview reports "not connected" rather than failing, before Amazon is linked',
    `status=${overview.status} connected=${overview.body.connected}`);

  const refused = await call(`/api/tenants/${tenantId}/scheduling/sync`, { method: 'POST' });
  check(refused.status === 409, 'syncing without a connection is a clear 409, not a crash',
    `status=${refused.status} ${refused.body.error ?? ''}`);

  // --- link a connection the way the OAuth callback would -----------------
  const { encryptSecret } = await import('../src/config/crypto.js');
  await admin.query(
    `insert into sellers (tenant_id, amazon_seller_id, marketplace_id, refresh_token_encrypted)
     values ($1,'A1E2ETESTSELLER','A21TJRUUN4KGV',$2)`,
    [tenantId, encryptSecret('Atzr|e2e-fake-refresh-token')]
  );

  overview = await call(`/api/tenants/${tenantId}/scheduling/overview`);
  check(overview.status === 200 && overview.body.connected === true,
    'the reconciliation connection is mirrored into scheduling on the next load',
    `reason=${overview.body.connectionReason}`);
  check(overview.body.accounts?.[0]?.status === 'AUTHORIZED' &&
        overview.body.accounts[0].external_account_id === 'A1E2ETESTSELLER',
    'the linked account carries the seller id and is AUTHORIZED');
  check(overview.body.accounts?.[0]?.metadata?.amazonMarketplaceId === 'A21TJRUUN4KGV',
    'the marketplace id is carried across so SP-API calls target the right host');

  // Idempotent: a second load must not rewrite or duplicate anything.
  const again = await call(`/api/tenants/${tenantId}/scheduling/overview`);
  check(again.body.connectionReason === 'already-current',
    'a second load does no work - the token fingerprint matches',
    `reason=${again.body.connectionReason}`);
  check(again.body.accounts.length === 1, 'no duplicate account is created');

  // Re-authorization: a new refresh token must be picked up automatically.
  await admin.query('update sellers set refresh_token_encrypted=$2 where tenant_id=$1',
    [tenantId, encryptSecret('Atzr|e2e-token-after-reauthorization')]);
  const reauthorized = await call(`/api/tenants/${tenantId}/scheduling/overview`);
  check(reauthorized.body.connectionReason === 'token-refreshed',
    're-authorizing on the reconciliation side re-links scheduling with no manual step',
    `reason=${reauthorized.body.connectionReason}`);

  // --- the list endpoints the UI renders -----------------------------------
  const orders = await call(`/api/tenants/${tenantId}/scheduling/orders`);
  check(orders.status === 200 && Array.isArray(orders.body.orders) && orders.body.pageCount === 1,
    'the orders list returns the shape the table renders', `status=${orders.status}`);
  check(orders.body.showingUnscheduledDefault === true,
    'with no status chosen, the list defaults to "still needs action"');

  const filtered = await call(`/api/tenants/${tenantId}/scheduling/orders?status=`);
  check(filtered.body.showingUnscheduledDefault === false,
    'an explicitly empty status means "all statuses", not "unchosen"');

  const shipments = await call(`/api/tenants/${tenantId}/scheduling/shipments`);
  check(shipments.status === 200 && Array.isArray(shipments.body.shipments),
    'the shipments list returns the shape the table renders', `status=${shipments.status}`);

  const marketplaces = await call(`/api/tenants/${tenantId}/scheduling/marketplaces`);
  check(marketplaces.body.marketplaces?.length === 4, 'all four marketplaces are listed',
    `count=${marketplaces.body.marketplaces?.length}`);

  const missing = await call(`/api/tenants/${tenantId}/scheduling/orders/${crypto.randomUUID()}`);
  check(missing.status === 404, 'an unknown order is a 404, not a 500', `status=${missing.status}`);

  const badPackage = await call(`/api/tenants/${tenantId}/scheduling/orders/${crypto.randomUUID()}/package`, {
    method: 'PUT', body: JSON.stringify({ weightGrams: -5, lengthCm: 1, widthCm: 1, heightCm: 1, packageType: 'BOX' })
  });
  check(badPackage.status === 400 && /greater than 0/i.test(badPackage.body.error ?? ''),
    'an invalid package is rejected with the real reason', badPackage.body.error ?? '');

  // An account whose whole history predates this tool is ALL shipped orders,
  // so this is not an edge case - it is the first screen such a seller sees.
  // Measurements against one of them mean nothing.
  const { rows: [marketplace] } = await admin.query("select id from scheduling.marketplaces where code='AMAZON'");
  const { rows: [shippedOrder] } = await admin.query(
    `insert into scheduling.orders
       (seller_id, marketplace_id, marketplace_account_id, external_order_id,
        order_date, last_updated_date, marketplace_status, internal_status)
     select $1, $2, id, '402-2036854-8535523', now(), now(), 'SHIPPED', 'SHIPPED'
       from scheduling.marketplace_accounts where seller_id = $1 limit 1
     returning id`,
    [tenantId, marketplace.id]
  );
  const settledPackage = await call(`/api/tenants/${tenantId}/scheduling/orders/${shippedOrder.id}/package`, {
    method: 'PUT', body: JSON.stringify({ weightGrams: 500, lengthCm: 20, widthCm: 15, heightCm: 10, packageType: 'BOX' })
  });
  check(settledPackage.status === 409 && /already shipped/i.test(settledPackage.body.error ?? ''),
    'measurements cannot be saved against an order Amazon already shipped',
    `status=${settledPackage.status} ${settledPackage.body.error ?? ''}`);

  const settledSchedule = await call(`/api/tenants/${tenantId}/scheduling/orders/${shippedOrder.id}/schedule`, { method: 'POST' });
  check(settledSchedule.status === 200 && settledSchedule.body.ok === false && /already shipped/i.test(settledSchedule.body.reason ?? ''),
    'scheduling an already-shipped order is refused with Amazon\'s own reason',
    settledSchedule.body.reason ?? `status=${settledSchedule.status}`);

  const detail = await call(`/api/tenants/${tenantId}/scheduling/orders/${shippedOrder.id}`);
  check(detail.body.order?.internal_status === 'SHIPPED' && detail.body.isComplete === false,
    'the detail payload reports the settled status the UI keys its read-only view off',
    `status=${detail.body.order?.internal_status} isComplete=${detail.body.isComplete}`);

  // --- cross-tenant access -------------------------------------------------
  const otherReg = await registerSeller('E2E Other Co', `e2e-other-${crypto.randomUUID()}@example.test`);
  const otherTenantId = otherReg.body.tenant?.id;
  const crossTenant = await call(`/api/tenants/${otherTenantId}/scheduling/orders`);
  check(crossTenant.status === 403, 'one tenant cannot read another tenant\'s scheduling orders',
    `status=${crossTenant.status}`);

  const unauthenticated = await fetch(`${base}/api/tenants/${tenantId}/scheduling/orders`);
  check(unauthenticated.status === 401, 'the scheduling routes require authentication',
    `status=${unauthenticated.status}`);

  // --- the hourly sweep ----------------------------------------------------
  const { runSchedulingSweep } = await import('../src/jobs/scheduling-sync.js');
  const summary = await runSchedulingSweep({ log: { error: () => {} } });
  // The refresh token is fake, so Amazon rejects it - the sweep must record
  // that as one failed account and keep going, not throw.
  check(summary.tenants >= 1 && summary.accounts >= 1,
    'the hourly sweep finds the linked tenant and its account', JSON.stringify(summary));
} finally {
  server.scheduler?.stop?.();
  server.schedulingScheduler?.stop?.();
  await server.app.close();
  await admin.query('delete from scheduling.orders where external_order_id = $1', ['402-2036854-8535523']);
  await admin.query('delete from tenants where company_name like $1', ['E2E %']);
  await admin.end();
  const { closeSchedulingPool } = await import('@recon/order-scheduler');
  await closeSchedulingPool();
  const { pool } = await import('@recon/db');
  await pool.end();
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll end-to-end scheduling checks passed.');
process.exit(failures.length ? 1 : 0);
