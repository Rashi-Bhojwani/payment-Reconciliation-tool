import crypto from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import { z } from 'zod';
import { assertActiveTenant, databaseUrlConfigured, pool, withTenant } from '@recon/db';
import { getSpApiEndpoint, MARKETPLACES, REPORT_TYPES, SpApiClient } from '@recon/sp-api-client';
import { secrets } from './config/secrets.js';
import { decryptSecret, encryptSecret } from './config/crypto.js';
import { startScheduler, syncRecentApiDataForTenant, syncReportForTenant } from './jobs/sync.js';

const app = Fastify({ logger: { redact: ['req.headers.authorization', 'refresh_token', 'access_token', 'password', 'passwordHash'] } });

await app.register(cors, { origin: secrets.frontendOrigin, credentials: true });
await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
await app.register(jwt, { secret: secrets.jwtSecret });

const TenantParamsSchema = z.object({ tenantId: z.string().uuid() });
const SyncParamsSchema = z.object({ tenantId: z.string().uuid(), reportType: z.enum(REPORT_TYPES) });
const AmazonCallbackSchema = z.object({ spapi_oauth_code: z.string().optional(), code: z.string().optional(), selling_partner_id: z.string().optional(), state: z.string().optional() });
const AmazonAccessTokenSchema = z.object({ sellerId: z.string().optional() });
const SellerSyncSchema = z.object({ reportTypes: z.array(z.enum(REPORT_TYPES)).default(['GET_SALES_AND_TRAFFIC_REPORT', 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2']) });
const RegisterSchema = z.object({ companyName: z.string().min(2), ownerEmail: z.string().email(), password: z.string().min(8), marketplaceId: z.string().default('A21TJRUUN4KGV') });
const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const adminId = '00000000-0000-0000-0000-000000000001';
const defaultAdminEmail = process.env.ADMIN_EMAIL ?? 'admin@reconcile.local';
const defaultAdminPassword = process.env.ADMIN_PASSWORD ?? 'Admin12345!';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120_000, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$120000$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [, iterations, salt, expected] = String(stored).split('$');
  if (!iterations || !salt || !expected || !Number.isInteger(Number(iterations))) return false;
  const hash = crypto.pbkdf2Sync(password, salt, Number(iterations), 32, 'sha256');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return expectedBuffer.length === hash.length && crypto.timingSafeEqual(expectedBuffer, hash);
}


function signAmazonState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secrets.jwtSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyAmazonState(state) {
  const [body, sig] = String(state ?? '').split('.');
  if (!body || !sig) throw Object.assign(new Error('Invalid Amazon authorization state'), { statusCode: 403 });
  const expected = crypto.createHmac('sha256', secrets.jwtSecret).update(body).digest('base64url');
  const sigBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) throw Object.assign(new Error('Invalid Amazon authorization state'), { statusCode: 403 });
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!payload.nonce || !payload.tenantId || Date.now() - Number(payload.createdAt) > 15 * 60 * 1000) throw Object.assign(new Error('Expired Amazon authorization state'), { statusCode: 403 });
  return z.object({ tenantId: z.string().uuid(), userId: z.string().uuid(), nonce: z.string(), createdAt: z.number() }).parse(payload);
}

function amazonConsentHost(marketplaceId) {
  return MARKETPLACES[marketplaceId]?.sellerCentralHost ?? 'sellercentral.amazon.in';
}

async function exchangeAmazonCode(code) {
  const token = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: secrets.lwaClientId, client_secret: secrets.lwaClientSecret, redirect_uri: secrets.redirectUri })
  });
  if (!token.ok) {
    const detail = await token.text().catch(() => '');
    throw Object.assign(new Error(`Amazon token exchange failed: ${token.status} ${detail}`), { statusCode: 502 });
  }
  return z.object({ refresh_token: z.string().min(1), access_token: z.string().optional(), expires_in: z.number().optional() }).parse(await token.json());
}


async function ensureSellerAuthSchema() {
  await pool.query(`
    alter table sellers add column if not exists seller_name text;
    alter table sellers add column if not exists seller_central_region text not null default 'IN';
    alter table sellers add column if not exists auth_status text not null default 'authorized';
    alter table sellers add column if not exists last_token_refresh_at timestamptz;
    alter table sellers add column if not exists disconnected_at timestamptz;
    create index if not exists idx_sellers_tenant_auth_status on sellers(tenant_id, auth_status, connected_at desc);
  `);
}

function normalizeDatabaseError(error) {
  if (error?.code === '42P01' || error?.code === '42703') {
    return Object.assign(new Error('Database schema is not migrated. Run all packages/db/migrations/*.sql files before using this endpoint.'), { statusCode: 503 });
  }
  if (error?.code === '23505') {
    return Object.assign(new Error('An account with this email already exists.'), { statusCode: 409 });
  }
  if (error?.code === '42501') {
    return Object.assign(new Error('Database row-level security blocked this operation. Verify the app user owns the schema and migrations were applied.'), { statusCode: 503 });
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(error?.code)) {
    return Object.assign(new Error('Database is unavailable. Check DATABASE_URL and network access before using this endpoint.'), { statusCode: 503 });
  }
  return error;
}

async function requireAuth(request) {
  try { return await request.jwtVerify(); } catch { throw Object.assign(new Error('Authentication required'), { statusCode: 401 }); }
}
async function requireAdmin(request) { const user = await requireAuth(request); if (user.role !== 'admin') throw Object.assign(new Error('Admin access required'), { statusCode: 403 }); return user; }
async function requireTenantUser(request, tenantId) { const user = await requireAuth(request); if (user.role === 'admin') return user; if (user.tenantId !== tenantId) throw Object.assign(new Error('Tenant access denied'), { statusCode: 403 }); return user; }


function queueInitialSellerSync(tenantId) {
  syncRecentApiDataForTenant(tenantId).catch(error => app.log.warn({ err: error, tenantId }, 'Initial Amazon direct API sync failed'));
  for (const reportType of ['GET_SALES_AND_TRAFFIC_REPORT', 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2']) {
    syncReportForTenant({ tenantId, reportType }).catch(error => app.log.warn({ err: error, tenantId, reportType }, 'Initial Amazon report sync failed'));
  }
}

function requestLog(request, error) {
  request.log.error({ error }, 'Unhandled API error');
}

app.setErrorHandler((error, _request, reply) => {
  const normalized = normalizeDatabaseError(error);
  const statusCode = normalized.statusCode ?? (normalized.name === 'ZodError' ? 400 : 500);
  if (statusCode === 500) requestLog(_request, normalized);
  reply.code(statusCode).send({ error: statusCode === 500 ? 'Internal server error' : normalized.message });
});

app.get('/health', async () => ({ ok: true }));

app.post('/api/auth/register-seller', async request => {
  const body = RegisterSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const tenant = await client.query(
      "insert into tenants(company_name, legal_name, owner_email, login_email, default_marketplace_id, status) values($1,$1,$2,$2,$3,'pending') returning id, company_name, status, plan",
      [body.companyName, body.ownerEmail, body.marketplaceId]
    );
    const tenantId = tenant.rows[0].id;
    const user = await client.query(
      "insert into users(tenant_id, email, password_hash, role, status) values($1,$2,$3,'user','active') returning id,email,role,tenant_id",
      [tenantId, body.ownerEmail, hashPassword(body.password)]
    );
    await client.query('commit');
    const token = app.jwt.sign({ sub: user.rows[0].id, email: user.rows[0].email, role: 'user', tenantId }, { expiresIn: '12h' });
    return { token, user: { id: user.rows[0].id, email: user.rows[0].email, role: user.rows[0].role, tenantId }, tenant: tenant.rows[0] };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw normalizeDatabaseError(error);
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async request => {
  const body = LoginSchema.parse(request.body);
  const result = await pool.query('select id, tenant_id, email, password_hash, role, status from users where lower(email)=lower($1)', [body.email]);
  const user = result.rows[0];
  if (!user || user.status !== 'active' || !verifyPassword(body.password, user.password_hash)) throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
  await pool.query('update users set last_login_at=now() where id=$1', [user.id]);
  const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role, tenantId: user.tenant_id }, { expiresIn: '12h' });
  return { token, user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id } };
});

app.get('/api/auth/me', async request => ({ user: await requireAuth(request) }));

app.post('/api/dev/bootstrap', async () => {
  const tenant = await pool.query("insert into tenants(company_name, owner_email, login_email, status) values('Demo Seller','demo@example.com','demo@example.com','pending') returning id, company_name, status, plan");
  const tenantId = tenant.rows[0].id;
  await pool.query("insert into users(tenant_id,email,password_hash,role,status) values($1,$2,$3,'user','active') on conflict(email) do nothing", [tenantId, `demo+${tenantId}@example.com`, hashPassword('password123')]);
  if (process.env.TEST_SELLER_REFRESH_TOKEN && process.env.TEST_SELLER_REFRESH_TOKEN !== 'HEHE') {
    await pool.query('insert into sellers(tenant_id, amazon_seller_id, marketplace_id, refresh_token_encrypted) values($1,$2,$3,$4)', [tenantId, process.env.TEST_SELLER_ID ?? 'TEST', process.env.TEST_MARKETPLACE_ID ?? 'A21TJRUUN4KGV', encryptSecret(process.env.TEST_SELLER_REFRESH_TOKEN)]);
  }
  return tenant.rows[0];
});

app.get('/api/auth/amazon/start', async (request, reply) => {
  const user = await requireAuth(request);
  const query = z.object({ tenantId: z.string().uuid(), json: z.coerce.boolean().default(false) }).parse(request.query);
  await requireTenantUser(request, query.tenantId);
  const tenant = (await pool.query('select default_marketplace_id from tenants where id=$1', [query.tenantId])).rows[0];
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });
  if (!secrets.spApiAppId || !secrets.lwaClientId || !secrets.lwaClientSecret) throw Object.assign(new Error('Amazon SP-API credentials are not configured'), { statusCode: 503 });
  const state = signAmazonState({ tenantId: query.tenantId, userId: user.sub, nonce: crypto.randomUUID(), createdAt: Date.now() });
  const url = new URL(`https://${amazonConsentHost(tenant.default_marketplace_id)}/apps/authorize/consent`);
  url.searchParams.set('application_id', secrets.spApiAppId);
  url.searchParams.set('state', state);
  url.searchParams.set('version', 'beta');
  if (query.json) return { url: url.toString(), expiresInMinutes: 15 };
  return reply.redirect(url.toString());
});

async function handleAmazonCallback(request, reply) {
  const query = AmazonCallbackSchema.parse(request.query);
  const code = query.spapi_oauth_code ?? query.code;
  if (!code) return reply.code(400).send({ error: 'Missing authorization code' });
  const state = verifyAmazonState(query.state);
  const tenant = (await pool.query('select id, company_name, default_marketplace_id from tenants where id=$1', [state.tenantId])).rows[0];
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });
  const body = await exchangeAmazonCode(code);
  const marketplace = tenant.default_marketplace_id ?? 'A21TJRUUN4KGV';
  const sellerId = query.selling_partner_id ?? `SELLER-${state.tenantId}`;
  const sellerName = tenant.company_name;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`insert into sellers(tenant_id, amazon_seller_id, seller_name, marketplace_id, seller_central_region, refresh_token_encrypted, auth_status, connected_at, last_token_refresh_at)
      values($1,$2,$3,$4,$5,$6,'authorized',now(),now())
      on conflict(tenant_id, amazon_seller_id) do update set seller_name=excluded.seller_name, marketplace_id=excluded.marketplace_id, seller_central_region=excluded.seller_central_region,
        refresh_token_encrypted=excluded.refresh_token_encrypted, auth_status='authorized', connected_at=now(), last_token_refresh_at=now(), disconnected_at=null`,
      [state.tenantId, sellerId, sellerName, marketplace, MARKETPLACES[marketplace]?.region ?? 'IN', encryptSecret(body.refresh_token)]);
    await client.query("update tenants set status='active', approved_at=coalesce(approved_at, now()) where id=$1 and status='pending'", [state.tenantId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  queueInitialSellerSync(state.tenantId);
  return reply.redirect(`${secrets.frontendOrigin}/seller?tenantId=${state.tenantId}&connected=1&auth=complete`);
}

for (const callbackPath of ['/api/auth/amazon/callback', '/oauth/callback']) {
  app.route({ method: ['GET', 'POST'], url: callbackPath, handler: handleAmazonCallback });
}

app.get('/api/tenants/:tenantId/amazon/access-token', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  const query = AmazonAccessTokenSchema.parse(request.query);
  await requireTenantUser(request, tenantId);
  await assertActiveTenant(tenantId);
  const seller = (await pool.query(`select id, amazon_seller_id, marketplace_id, refresh_token_encrypted from sellers
    where tenant_id=$1 and auth_status='authorized' and ($2::text is null or amazon_seller_id=$2) order by connected_at desc limit 1`, [tenantId, query.sellerId ?? null])).rows[0];
  if (!seller) throw Object.assign(new Error('Amazon seller is not connected'), { statusCode: 404 });
  const client = new SpApiClient(decryptSecret(seller.refresh_token_encrypted), { clientId: secrets.lwaClientId, clientSecret: secrets.lwaClientSecret, baseUrl: getSpApiEndpoint(seller.marketplace_id) });
  const token = await client.getAccessToken();
  await pool.query('update sellers set last_token_refresh_at=now() where id=$1', [seller.id]);
  return { accessToken: token.accessToken, expiresAt: token.expiresAt, expiresIn: token.expiresIn, sellerId: seller.amazon_seller_id, marketplaceId: seller.marketplace_id };
});

app.get('/api/admin/tenants', async request => {
  await requireAdmin(request);
  const result = await pool.query(`select t.id, t.company_name, t.owner_email, t.login_email, t.status, t.plan, t.created_at, t.approved_at,
      s.seller_name, s.amazon_seller_id, s.marketplace_id, s.auth_status, s.connected_at as amazon_connected_at, s.last_token_refresh_at, exists(select 1 from sellers s2 where s2.tenant_id = t.id) as amazon_connected,
      (select max(completed_at) from sync_jobs sj where sj.tenant_id = t.id and sj.status = 'completed') as last_successful_sync,
      (select count(*) from users u where u.tenant_id = t.id and u.status='active') as user_count
    from tenants t left join lateral (select * from sellers s where s.tenant_id=t.id order by connected_at desc limit 1) s on true order by t.created_at desc`);
  return { tenants: result.rows };
});

app.post('/api/admin/tenants/:tenantId/grant-access', async request => { await requireAdmin(request); const { tenantId } = TenantParamsSchema.parse(request.params); return (await pool.query("update tenants set status='active', approved_at=now(), approved_by_admin_id=$2 where id=$1 returning id,status,approved_at", [tenantId, adminId])).rows[0]; });
app.post('/api/admin/tenants/:tenantId/reject', async request => { await requireAdmin(request); const { tenantId } = TenantParamsSchema.parse(request.params); return (await pool.query("update tenants set status='suspended' where id=$1 returning id,status", [tenantId])).rows[0]; });
app.post('/api/admin/tenants/:tenantId/revoke-access', async request => { await requireAdmin(request); const { tenantId } = TenantParamsSchema.parse(request.params); return (await pool.query("update tenants set status='suspended' where id=$1 returning id,status", [tenantId])).rows[0]; });
app.post('/api/admin/tenants/:tenantId/sync/:reportType', async request => { await requireAdmin(request); return syncReportForTenant(SyncParamsSchema.parse(request.params)); });


app.post('/api/tenants/:tenantId/sync', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  await requireTenantUser(request, tenantId);
  await assertActiveTenant(tenantId);
  const body = SellerSyncSchema.parse(request.body ?? {});
  const results = [];
  try {
    const result = await syncRecentApiDataForTenant(tenantId);
    results.push({ reportType: 'DIRECT_SP_API_SYNC', status: 'completed', ...result });
  } catch (error) {
    results.push({ reportType: 'DIRECT_SP_API_SYNC', status: 'failed', error: error instanceof Error ? error.message : 'unknown error' });
  }
  for (const reportType of body.reportTypes) {
    try {
      const result = await syncReportForTenant({ tenantId, reportType });
      results.push({ reportType, status: 'completed', ...result });
    } catch (error) {
      results.push({ reportType, status: 'failed', error: error instanceof Error ? error.message : 'unknown error' });
    }
  }
  return { results };
});

app.get('/api/tenants/:tenantId/dashboard', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params); await requireTenantUser(request, tenantId); await assertActiveTenant(tenantId);
  return withTenant(tenantId, async client => {
    const amazonAuth = (await pool.query("select amazon_seller_id, marketplace_id, auth_status, connected_at, last_token_refresh_at from sellers where tenant_id=$1 and auth_status='authorized' order by connected_at desc limit 1", [tenantId])).rows[0] ?? null;
    const kpis = (await client.query(`select coalesce(sum(amount),0) net_settled, coalesce(sum(case when amount > 0 then amount else 0 end),0) earnings, coalesce(sum(case when amount < 0 then amount else 0 end),0) deductions from settlement_rows`)).rows[0];
    const orders = (await client.query(`select count(*) orders, coalesce(sum(total_amount),0) order_value from orders`)).rows[0];
    const products = (await client.query(`select asin, sum(units_ordered) units, sum(ordered_product_sales) sales, avg(featured_offer_percentage) buy_box from sales_traffic_daily group by asin order by sales desc nulls last limit 20`)).rows;
    const trend = (await client.query(`select date, sum(ordered_product_sales) sales, sum(units_ordered) units, sum(sessions) sessions from sales_traffic_daily group by date order by date desc limit 90`)).rows.reverse();
    const payments = (await client.query(`select settlement_id, date(posted_date) posted_date, sum(amount) net_amount, count(*) lines from settlement_rows group by settlement_id,date(posted_date) order by date(posted_date) desc nulls last limit 50`)).rows;
    const jobs = (await client.query('select report_type,status,started_at,completed_at,error_message,s3_key from sync_jobs order by started_at desc nulls last limit 10')).rows;
    const inventory = (await client.query('select sku, fulfillable_quantity, snapshot_date from inventory_snapshots order by snapshot_date desc, fulfillable_quantity desc nulls last limit 50')).rows;
    const returns = (await client.query('select order_id, return_reason, disposition, status, return_date from returns order by return_date desc nulls last limit 50')).rows;
    const reimbursements = (await client.query('select sku, amount, reason, reimbursement_date from reimbursements order by reimbursement_date desc nulls last limit 50')).rows;
    const invoices = (await client.query('select invoice_type, order_id, taxable_value, cgst, sgst, igst, invoice_date from gst_invoices order by invoice_date desc nulls last limit 50')).rows;
    const orderItems = (await client.query('select amazon_order_id, asin, sku, title, quantity_ordered, item_price, item_tax from order_items order by quantity_ordered desc nulls last limit 50')).rows;
    const financeTransactions = (await client.query('select transaction_id, transaction_type, posted_date, total_amount, currency, related_order_id from finance_transactions order by posted_date desc nulls last limit 50')).rows;
    const hasImportedData = Number(orders.orders ?? 0) > 0 || Number(kpis.net_settled ?? 0) !== 0 || products.length > 0 || payments.length > 0 || inventory.length > 0;
    return { amazonAuth, hasImportedData, kpis, orders, products, trend, payments, jobs, inventory, returns, reimbursements, invoices, orderItems, financeTransactions };
  });
});

// Backward-compatible report endpoints for existing clients.
app.get('/api/tenants/:tenantId/summary', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  await requireTenantUser(request, tenantId);
  await assertActiveTenant(tenantId);
  return withTenant(tenantId, async client => ({
    settlementTotal: (await client.query('select coalesce(sum(amount),0) total from settlement_rows')).rows[0].total,
    grossSales: (await client.query("select coalesce(sum(amount),0) total from settlement_rows where amount_type ilike '%principal%' or amount_description ilike '%principal%'")).rows[0].total,
    fees: (await client.query("select coalesce(sum(amount),0) total from settlement_rows where amount < 0 and (amount_type ilike '%fee%' or amount_description ilike '%fee%')")).rows[0].total,
    feeLeaks: (await client.query('select count(*) count from fee_leak_flags')).rows[0].count,
    recentJobs: (await client.query('select report_type,status,started_at,completed_at,error_message,s3_key from sync_jobs order by started_at desc nulls last limit 10')).rows
  }));
});


app.setNotFoundHandler(async (request, reply) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/oauth/callback' || pathname === '/api/auth/amazon/callback') {
    return handleAmazonCallback(request, reply);
  }
  return reply.code(404).send({ message: `Route ${request.method}:${request.url} not found`, error: 'Not Found', statusCode: 404 });
});

if (!databaseUrlConfigured) {
  app.log.warn('DATABASE_URL is not configured. Create .env from .env.example or export DATABASE_URL before running npm run dev.');
} else {
  await ensureSellerAuthSchema()
    .catch(error => app.log.warn({ err: normalizeDatabaseError(error) }, 'Seller auth schema self-check skipped; run migrations before Amazon authorization'));
  await pool.query("insert into users(id,email,password_hash,role,status) values($1,$2,$3,'admin','active') on conflict(email) do nothing", [adminId, defaultAdminEmail, hashPassword(defaultAdminPassword)])
    .catch(error => app.log.warn({ err: normalizeDatabaseError(error) }, 'Admin seed skipped; run migrations before first login'));
}

startScheduler();
await app.listen({ port: 4000, host: '0.0.0.0' });
