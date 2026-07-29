import crypto from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import { z } from 'zod';
import { assertActiveTenant, databaseUrlConfigured, pool, withTenant } from '@recon/db';
import { getSpApiEndpoint, marketplaceCalendarRange, MARKETPLACES, REPORT_TYPES, SpApiClient } from '@recon/sp-api-client';
import { secrets } from './config/secrets.js';
import { decryptSecret, encryptSecret } from './config/crypto.js';
import { startScheduler, syncRecentApiDataForTenant, syncReportForTenant } from './jobs/sync.js';
import { categorizeFinanceLabel } from './jobs/finance-components.js';
import { calculateDashboardMetrics } from './jobs/dashboard-calculations.js';
import { runFeeAuditForTenant } from './jobs/fee-audit.js';

const app = Fastify({ logger: { redact: ['req.headers.authorization', 'refresh_token', 'access_token', 'password', 'passwordHash'] }, trustProxy: true });

await app.register(cors, { origin: secrets.frontendOrigin, credentials: true });
await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
await app.register(jwt, { secret: secrets.jwtSecret });
app.addContentTypeParser(/^application\/x-www-form-urlencoded(?:;.*)?$/, { parseAs: 'string' }, (_request, body, done) => {
  try { done(null, Object.fromEntries(new URLSearchParams(body))); }
  catch (error) { done(error); }
});

const TenantParamsSchema = z.object({ tenantId: z.string().uuid() });
const SyncParamsSchema = z.object({ tenantId: z.string().uuid(), reportType: z.enum(REPORT_TYPES) });
const SellerSyncParamsSchema = z.object({ tenantId: z.string().uuid(), reportType: z.enum([...REPORT_TYPES, 'DIRECT_SP_API_SYNC']) });
const AmazonCallbackSchema = z.object({ spapi_oauth_code: z.string().optional(), code: z.string().optional(), selling_partner_id: z.string().optional(), state: z.string().optional(), amazon_state: z.string().optional(), redirect_uri: z.string().url().optional(), error: z.string().optional(), error_description: z.string().optional() });
const AmazonAccessTokenSchema = z.object({ sellerId: z.string().optional() });
const DateRangeSchema = z.object({ start: z.string().datetime(), end: z.string().datetime() });
const DashboardQuerySchema = z.object({ start: z.string().datetime().optional(), end: z.string().datetime().optional(), startDate:z.string().date().optional(), endDateExclusive:z.string().date().optional() });
const SellerSyncSchema = z.object({ reportTypes: z.array(z.enum(REPORT_TYPES)).default(['GET_SALES_AND_TRAFFIC_REPORT', 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2']), range: DateRangeSchema.optional() });
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

function requestOrigin(request) {
  const forwardedProto = request.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim();
  const forwardedHost = request.headers['x-forwarded-host']?.toString().split(',')[0]?.trim();
  const proto = forwardedProto || request.protocol || 'http';
  const host = forwardedHost || request.headers.host;
  return host ? `${proto}://${host}` : '';
}

function amazonCallbackUrl(request) {
  if (secrets.redirectUri) return secrets.redirectUri;
  const origin = secrets.publicApiOrigin || requestOrigin(request);
  if (!origin) throw Object.assign(new Error('Amazon OAuth redirect URL is not configured. Set SP_API_REDIRECT_URI to the exact Redirect URI registered for your SP-API application.'), { statusCode: 503 });
  return `${origin.replace(/\/$/, '')}/oauth/callback`;
}

function validateAmazonRedirectUrl(redirectUri) {
  let url;
  try { url = new URL(redirectUri); }
  catch { throw Object.assign(new Error('Amazon OAuth redirect URL is invalid. Set SP_API_REDIRECT_URI to an absolute URL registered for your SP-API application.'), { statusCode: 503 }); }
  if (!['https:', 'http:'].includes(url.protocol)) throw Object.assign(new Error('Amazon OAuth redirect URL must use http or https.'), { statusCode: 503 });
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw Object.assign(new Error('Amazon OAuth redirect URL must use HTTPS outside local development.'), { statusCode: 503 });
  return url.toString();
}

async function exchangeAmazonCode(code, redirectUri) {
  const token = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: secrets.lwaClientId, client_secret: secrets.lwaClientSecret, redirect_uri: redirectUri })
  });
  if (!token.ok) {
    const detail = await token.text().catch(() => '');
    throw Object.assign(new Error(`Amazon token exchange failed: ${token.status} ${detail}`), { statusCode: 502 });
  }
  return z.object({ refresh_token: z.string().min(1), access_token: z.string().optional(), expires_in: z.number().optional() }).parse(await token.json());
}


const TENANT_DATA_TABLES = ['orders', 'settlement_rows', 'settlement_report_documents', 'gst_invoices', 'returns', 'reimbursements', 'inventory_snapshots', 'sales_traffic_daily', 'fee_leak_flags', 'generated_reports', 'order_items', 'finance_transactions', 'finance_transaction_items', 'fee_estimates'];

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

async function ensureTenantDataIsolationSchema() {
  for (const table of TENANT_DATA_TABLES) {
    await pool.query(`alter table ${table} enable row level security`);
    await pool.query(`alter table ${table} force row level security`);
  }
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



function asMoney(value) {
  const parsed = Number(String(value ?? '').replace(/[,₹$]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function textOrNull(value) { return value == null || String(value).trim() === '' ? null : String(value).trim(); }


function directMoneyValue(value) {
  if (!value || typeof value !== 'object') return undefined;
  return value.chargeAmount ?? value.ChargeAmount ?? value.feeAmount ?? value.FeeAmount ?? value.amount ?? value.Amount ?? value.currencyAmount ?? value.CurrencyAmount;
}

function hasNestedMoney(value) {
  if (Array.isArray(value)) return value.some(hasNestedMoney);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(nested => {
    if (!nested || typeof nested !== 'object') return false;
    if (directMoneyValue(nested) != null) return true;
    return hasNestedMoney(nested);
  });
}

function isAggregateComponent(label) {
  return /total|summary|breakdown|list|amount$/i.test(String(label ?? ''));
}

function componentCategory(label) {
  const normalized = String(label ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['principal', 'itemprice', 'productcharges', 'productcharge', 'itemcharge'].some(key => normalized.includes(key))) return 'principal';
  if (normalized.includes('shipping') && normalized.includes('tax')) return 'shipping_tax';
  if (normalized.includes('shipping')) return 'shipping';
  if (normalized.includes('giftwrap') && normalized.includes('tax')) return 'gift_wrap_tax';
  if (normalized.includes('giftwrap')) return 'gift_wrap';
  if (normalized.includes('promotion') || normalized.includes('discount')) return 'promotion';
  if (normalized.includes('commission') || normalized.includes('referral')) return normalized.includes('refund') ? 'refund_commission' : 'commission';
  if (normalized.includes('fbaperunit') || normalized.includes('fulfillment') || normalized.includes('fbaweight') || normalized.includes('weightbased')) return 'fba_fee';
  if (normalized.includes('tax') || normalized.includes('tcs') || normalized.includes('tds')) return 'tax';
  if (normalized.includes('refund') || normalized.includes('return')) return 'refund';
  if (normalized.includes('reimbursement') || normalized.includes('safet') || normalized.includes('chargebackrecovery')) return 'reimbursement';
  if (normalized.includes('fee') || normalized.includes('charge')) return 'other_fee';
  return 'other_adjustment';
}

function financeComponentRows(row) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  const rows = [];
  function walk(value, context = {}) {
    if (Array.isArray(value)) return value.forEach(item => walk(item, context));
    if (!value || typeof value !== 'object') return;
    const label = textOrNull(value.chargeType ?? value.ChargeType ?? value.feeType ?? value.FeeType ?? value.type ?? value.Type ?? value.description ?? value.Description ?? value.name ?? value.Name ?? context.label ?? row.transaction_type);
    const money = directMoneyValue(value);
    const amount = typeof money === 'object' && money ? asMoney(money.currencyAmount ?? money.CurrencyAmount ?? money.amount ?? money.Amount) : asMoney(money);
    const hasMoney = money != null && Number.isFinite(amount) && amount !== 0 && !(hasNestedMoney(value) && isAggregateComponent(label));
    if (hasMoney) {
      rows.push({
        posted_date: row.posted_date,
        transaction_id: row.transaction_id,
        related_order_id: row.related_order_id,
        transaction_type: row.transaction_type,
        component: label ?? 'Transaction amount',
        category: componentCategory(label ?? row.transaction_type),
        amount,
        currency: row.currency ?? value.currencyCode ?? value.CurrencyCode ?? 'INR',
        source: 'Finances API'
      });
    }
    for (const [key, nested] of Object.entries(value)) {
      if (nested && typeof nested === 'object') walk(nested, { label: label ?? key });
    }
  }
  walk(raw);
  if (!rows.length && Number(row.total_amount ?? 0) !== 0) {
    rows.push({ posted_date: row.posted_date, transaction_id: row.transaction_id, related_order_id: row.related_order_id, transaction_type: row.transaction_type, component: row.transaction_type ?? 'Transaction total', category: componentCategory(row.transaction_type), amount: Number(row.total_amount ?? 0), currency: row.currency ?? 'INR', source: 'Finances API total' });
  }
  return rows;
}

function settlementComponentRows(rows) {
  return rows.map(row => ({
    posted_date: row.posted_date,
    transaction_id: row.settlement_id,
    related_order_id: row.order_id,
    transaction_type: row.amount_type,
    component: row.amount_description ?? row.amount_type ?? 'Settlement amount',
    category: componentCategory(`${row.amount_type ?? ''} ${row.amount_description ?? ''}`),
    amount: Number(row.amount ?? 0),
    currency: 'INR',
    source: 'Settlement report'
  }));
}

function summarizeComponents(rows) {
  const byCategory = new Map();
  for (const row of rows) byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + Number(row.amount ?? 0));
  return Object.fromEntries(byCategory.entries());
}

function buildOrderPaymentRows(orders, settlementRows, financeRows) {
  const settlementByOrder = new Map();
  for (const component of settlementComponentRows(settlementRows)) {
    if (!component.related_order_id) continue;
    const rows = settlementByOrder.get(component.related_order_id) ?? [];
    rows.push(component);
    settlementByOrder.set(component.related_order_id, rows);
  }
  const financeByOrder = new Map();
  for (const transaction of financeRows) {
    for (const component of financeComponentRows(transaction)) {
      if (!component.related_order_id) continue;
      const rows = financeByOrder.get(component.related_order_id) ?? [];
      rows.push(component);
      financeByOrder.set(component.related_order_id, rows);
    }
  }
  return orders.map(order => {
    // Settlement reports are the final accounting record. Finance API events
    // are used only while an order has no settlement lines, preventing the
    // same Amazon money movement from being counted twice.
    const components = settlementByOrder.get(order.amazon_order_id) ?? financeByOrder.get(order.amazon_order_id) ?? [];
    const amount = categories => components.filter(row => categories.includes(row.category)).reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
    const componentTotal = components.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
    const orderGross = amount(['principal']) || Number(order.item_value ?? 0) + Number(order.item_tax ?? 0) - Number(order.promotion_discount ?? 0) || Number(order.total_amount ?? 0);
    const deductions = components.filter(row => Number(row.amount) < 0).reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0);
    const credits = components.filter(row => Number(row.amount) > 0 && row.category !== 'principal').reduce((sum, row) => sum + Number(row.amount), 0);
    return {
      amazon_order_id: order.amazon_order_id,
      order_date: order.order_date,
      status: order.status,
      product: order.product,
      asin: order.asin,
      sku: order.sku,
      package_weight: order.package_weight,
      package_dimensions: order.package_dimensions,
      fulfillment: order.fulfillment_channel === 'AFN' ? 'FBA' : order.fulfillment_channel === 'MFN' ? 'FBM' : (order.fulfillment_channel ?? 'Unknown'),
      gross_sales: orderGross,
      referral_fee: Math.abs(amount(['commission', 'refund_commission'])),
      fulfillment_fee: Math.abs(amount(['fba_fee'])),
      shipping_and_tax: Math.abs(amount(['shipping', 'shipping_tax', 'tax'])),
      refunds: Math.abs(amount(['refund'])),
      other_deductions: Math.abs(amount(['other_fee', 'other_adjustment'])),
      total_deductions: deductions,
      credits,
      seller_receivable: components.length ? componentTotal : orderGross,
      payment_status: settlementByOrder.has(order.amazon_order_id) ? 'Settled' : financeByOrder.has(order.amazon_order_id) ? 'Finance posted' : 'Awaiting payment data',
      source: settlementByOrder.has(order.amazon_order_id) ? 'Settlement report' : financeByOrder.has(order.amazon_order_id) ? 'Finances API' : 'Orders API',
      components
    };
  });
}

function queueInitialSellerSync(tenantId) {
  // Keep the authorization callback fast and safe: mark the seller connected
  // first, then do only a small direct-API warmup in the background. Report
  // pulls remain page/date scoped from the UI so a newly connected account is
  // not hit with multiple report-generation requests immediately.
  syncRecentApiDataForTenant(tenantId, { days: 7 }).catch(error => app.log.warn({ err: error, tenantId }, 'Initial Amazon direct API sync failed'));
}


async function recordSyntheticReportSync(tenantId, reportType, s3Key = 'fallback://direct-sp-api') {
  await pool.query(
    `insert into sync_jobs(tenant_id, report_type, status, started_at, completed_at, s3_key)
     values($1,$2,'completed',now(),now(),$3)`,
    [tenantId, reportType, s3Key]
  );
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

// Admin-only: creates a seller tenant + its first login user. There is no
// public/self-serve signup route any more — account creation is entirely in
// admin hands. Note this intentionally does NOT sign/return a session token:
// the admin stays logged in as themself, they aren't switched into the new
// seller's account.
app.post('/api/auth/register-seller', async request => {
  const admin = await requireAdmin(request);
  const body = RegisterSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const tenant = await client.query(
      `insert into tenants(company_name, legal_name, owner_email, login_email, default_marketplace_id, status, approved_at, approved_by_admin_id)
       values($1,$1,$2,$2,$3,'active', now(), $4) returning id, company_name, status, plan`,
      [body.companyName, body.ownerEmail, body.marketplaceId, admin.sub]
    );
    const tenantId = tenant.rows[0].id;
    const user = await client.query(
      "insert into users(tenant_id, email, password_hash, role, status) values($1,$2,$3,'user','active') returning id,email,role,tenant_id",
      [tenantId, body.ownerEmail, hashPassword(body.password)]
    );
    await client.query('commit');
    return { user: { id: user.rows[0].id, email: user.rows[0].email, role: user.rows[0].role, tenantId }, tenant: tenant.rows[0] };
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
  const redirectUri = validateAmazonRedirectUrl(amazonCallbackUrl(request));
  const url = new URL(`https://${amazonConsentHost(tenant.default_marketplace_id)}/apps/authorize/consent`);
  url.searchParams.set('application_id', secrets.spApiAppId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('version', 'beta');
  if (query.json) return { url: url.toString(), expiresInMinutes: 15 };
  return reply.redirect(url.toString());
});

async function handleAmazonCallback(request, reply) {
  const query = AmazonCallbackSchema.parse({ ...(request.body && typeof request.body === 'object' ? request.body : {}), ...request.query });
  let state;
  try { state = verifyAmazonState(query.state ?? query.amazon_state); }
  catch (error) {
    return reply.redirect(`${secrets.frontendOrigin}/login?amazon=error&message=${encodeURIComponent(error instanceof Error ? error.message : 'Invalid Amazon authorization state')}`);
  }
  if (query.error) return reply.redirect(`${secrets.frontendOrigin}/seller?tenantId=${state.tenantId}&amazon=error&message=${encodeURIComponent(query.error_description ?? query.error)}`);
  const code = query.spapi_oauth_code ?? query.code;
  if (!code) return reply.redirect(`${secrets.frontendOrigin}/seller?tenantId=${state.tenantId}&amazon=error&message=${encodeURIComponent('Missing authorization code from Amazon')}`);
  const tenant = (await pool.query('select id, company_name, default_marketplace_id from tenants where id=$1', [state.tenantId])).rows[0];
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });
  let body;
  try { body = await exchangeAmazonCode(code, validateAmazonRedirectUrl(query.redirect_uri ?? amazonCallbackUrl(request))); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Amazon token exchange failed';
    return reply.redirect(`${secrets.frontendOrigin}/seller?tenantId=${state.tenantId}&amazon=error&message=${encodeURIComponent(message)}`);
  }

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

app.route({
  method: 'POST',
  url: '/oauth/callback',
  handler: handleAmazonCallback
});


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

app.post('/api/tenants/:tenantId/sync/:reportType', async request => {
  const params = SellerSyncParamsSchema.parse(request.params);
  const body = z.object({ range: DateRangeSchema.optional(), startDate:z.string().date().optional(), endDateExclusive:z.string().date().optional() }).parse(request.body ?? {});
  await requireTenantUser(request, params.tenantId);
  await assertActiveTenant(params.tenantId);
  if(body.startDate&&body.endDateExclusive) body.range=await requestedMarketplaceRange(params.tenantId,body);
  if (params.reportType === 'DIRECT_SP_API_SYNC') {
    // Keep an interactive sync bounded. Fetching 1,000 order-item and catalog
    // records serially can take well over half an hour at Amazon's rate limits.
    // Subsequent syncs continue incrementally from the last completion.
    const result = await syncRecentApiDataForTenant(params.tenantId, { range: body.range, maxOrderPages: 2, maxOrderItems: 20 });
    return { reportType: params.reportType, status: 'completed', ...result };
  }
  const directFirstReports = new Set(['GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', 'GET_FBA_REIMBURSEMENTS_DATA']);
  if (directFirstReports.has(params.reportType)) {
    const familyOptions = params.reportType === 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'
      ? { includeOrders: false, includeFinance: false, includeInventory: true }
      : params.reportType === 'GET_FBA_REIMBURSEMENTS_DATA'
        ? { includeOrders: false, includeFinance: true, includeInventory: false }
        : { includeOrders: false, includeFinance: true, includeInventory: false };
    const fallback = await syncRecentApiDataForTenant(params.tenantId, { range: body.range, ...familyOptions });
    await recordSyntheticReportSync(params.tenantId, params.reportType);
    return { reportType: params.reportType, status: 'completed', fallback: 'DIRECT_SP_API_SYNC', ...fallback };
  }
  try {
    const result = await syncReportForTenant({ ...params, range: body.range });
    return { reportType: params.reportType, status: 'completed', ...result };
  } catch (error) {
    const directFallbackReports = new Set(['GET_SALES_AND_TRAFFIC_REPORT', 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', 'GET_FBA_REIMBURSEMENTS_DATA']);
    if (directFallbackReports.has(params.reportType)) {
      try {
        const fallback = await syncRecentApiDataForTenant(params.tenantId, { range: body.range });
        await recordSyntheticReportSync(params.tenantId, params.reportType);
        return { reportType: params.reportType, status: 'completed', fallback: 'DIRECT_SP_API_SYNC', warning: error instanceof Error ? error.message : 'Report sync failed', ...fallback };
      } catch {
        // Return the original report error below; it is usually more actionable than a secondary fallback failure.
      }
    }
    return { reportType: params.reportType, status: 'failed', error: error instanceof Error ? error.message : 'Report sync failed' };
  }
});

app.post('/api/tenants/:tenantId/sync', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  await requireTenantUser(request, tenantId);
  await assertActiveTenant(tenantId);
  const body = SellerSyncSchema.parse(request.body ?? {});
  const results = [];
  try {
    const result = await syncRecentApiDataForTenant(tenantId, { range: body.range, maxOrderPages: 2, maxOrderItems: 20 });
    results.push({ reportType: 'DIRECT_SP_API_SYNC', status: 'completed', ...result });
  } catch (error) {
    results.push({ reportType: 'DIRECT_SP_API_SYNC', status: 'failed', error: error instanceof Error ? error.message : 'unknown error' });
  }
  for (const reportType of body.reportTypes) {
    try {
      const result = await syncReportForTenant({ tenantId, reportType, range: body.range });
      results.push({ reportType, status: 'completed', ...result });
    } catch (error) {
      results.push({ reportType, status: 'failed', error: error instanceof Error ? error.message : 'unknown error' });
    }
  }
  return { results };
});

const DASHBOARD_METRICS = ['netSales','netQty','orders','returns','settled','deductions','reimbursements','drr','feeImpact','returnRate','refundValueRate','gstValue','income','expenses','tax','transfers','gst'];
const CalculationParamsSchema = z.object({ tenantId: z.string().uuid(), metric: z.enum(DASHBOARD_METRICS) });
const OrderDetailParamsSchema = z.object({ tenantId: z.string().uuid(), orderId: z.string().min(1) });
const FEE_CATEGORIES = ['referral_commission', 'fulfillment_fee_per_order', 'fulfillment_fee_per_unit', 'fulfillment_fee_weight', 'shipping_fee', 'gift_wrap_fee', 'closing_fee', 'digital_services_fee', 'storage_fee', 'chargeback', 'tax'];
function requestedRange(query) { const parsed = DashboardQuerySchema.parse(query); return { start: parsed.start ?? new Date(Date.now() - 30 * 864e5).toISOString(), end: parsed.end ?? new Date().toISOString() }; }
async function requestedMarketplaceRange(tenantId,query){const parsed=DashboardQuerySchema.parse(query);if(!parsed.startDate||!parsed.endDateExclusive)return requestedRange(query);const marketplaceId=(await pool.query("select marketplace_id from sellers where tenant_id=$1 and auth_status='authorized' order by connected_at desc limit 1",[tenantId])).rows[0]?.marketplace_id??'A21TJRUUN4KGV';return marketplaceCalendarRange(parsed.startDate,parsed.endDateExclusive,marketplaceId);}
function groupCalculationRows(rows) {
  const grouped = new Map();
  for (const row of rows) { const key = row.category; const current = grouped.get(key) ?? { category: key, label: key.replaceAll('_', ' '), amount: 0, count: 0 }; current.amount += Number(row.amount ?? 0); current.count += 1; grouped.set(key, current); }
  return [...grouped.values()];
}

async function loadDashboardCalculations(db, tenantId, range) {
  const schemaWarnings=[];
  const optionalSourceQuery=async(sql,params,source)=>{try{return await db.query(sql,params);}catch(error){if(!['42P01','42703'].includes(error?.code))throw error;schemaWarnings.push({source,code:error.code,missing:error.column??error.table??'unknown identifier',message:error.message});return{rows:[],rowCount:0};}};
  const [orders,orderItems,returns,settlementRows,settlementHeaders,financeItems,financeTransactions,reimbursements,gstInvoices,reportDocumentsResult]=await Promise.all([
    db.query('select id source_row_id,amazon_order_id,status,order_date,total_amount,raw from orders where tenant_id=$1 and order_date >= $2 and order_date < $3',[tenantId,range.start,range.end]),
    db.query(`select oi.id source_row_id,oi.amazon_order_id,oi.asin,oi.sku,oi.title,oi.quantity_ordered,oi.item_price,oi.promotion_discount,oi.raw,o.status,o.order_date from order_items oi join orders o on o.tenant_id=oi.tenant_id and o.amazon_order_id=oi.amazon_order_id where oi.tenant_id=$1 and o.order_date >= $2 and o.order_date < $3`,[tenantId,range.start,range.end]),
    db.query('select id source_row_id,order_id,return_date,return_reason,disposition,status,quantity,raw from returns where tenant_id=$1 and return_date >= $2::date and return_date < $3::date',[tenantId,range.start,range.end]),
    optionalSourceQuery(`select id source_row_id,settlement_id,order_id,amount_type,amount_description,amount,amount_minor,currency,posted_date,raw,source_report_id,source_document_id,source_line_id,
      coalesce(raw->>'transaction-type',raw->>'transaction type',raw->>'transactionType') parent_transaction_type
      from settlement_rows where tenant_id=$1 and posted_date >= $2 and posted_date < $3`,[tenantId,range.start,range.end],'settlement_rows_exact_ledger'),
    db.query(`select settlement_id,coalesce(raw->>'deposit-date',raw->>'deposit date',raw->>'depositDate') deposit_date,coalesce(nullif(raw->>'total-amount',''),nullif(raw->>'total amount',''),nullif(raw->>'totalAmount','')) total_amount,coalesce(raw->>'transaction-type',raw->>'transaction type') transaction_type,raw from settlement_rows where tenant_id=$1 and coalesce(raw->>'deposit-date',raw->>'deposit date',raw->>'depositDate','')<>''`,[tenantId]),
    db.query(`select fi.id source_row_id,fi.transaction_id,fi.order_id,fi.sku,fi.asin,fi.category,fi.amount_description,fi.amount,fi.currency,fi.posted_date,fi.raw,
      ft.transaction_type parent_transaction_type,
      coalesce(ft.raw->>'accountType',ft.raw->>'AccountType',ft.raw#>>'{sellingPartnerMetadata,accountType}') account_type
      from finance_transaction_items fi left join finance_transactions ft on ft.tenant_id=fi.tenant_id and ft.transaction_id=fi.transaction_id
      where fi.tenant_id=$1 and fi.posted_date >= $2 and fi.posted_date < $3`,[tenantId,range.start,range.end]),
    db.query('select transaction_id,transaction_type,posted_date,total_amount,currency,related_order_id,raw from finance_transactions where tenant_id=$1 and posted_date >= $2 and posted_date < $3',[tenantId,range.start,range.end]),
    db.query('select amount,reason,sku,reimbursement_date from reimbursements where tenant_id=$1 and reimbursement_date >= $2::date and reimbursement_date < $3::date',[tenantId,range.start,range.end]),
    db.query('select id source_row_id,invoice_type,order_id,cgst,sgst,igst,taxable_value,invoice_date,raw from gst_invoices where tenant_id=$1 and invoice_date >= $2::date and invoice_date < $3::date',[tenantId,range.start,range.end]),
    optionalSourceQuery('select report_id,report_document_id,marketplace_id,data_start_time,data_end_time,created_time,imported_at from settlement_report_documents where tenant_id=$1 and data_end_time>$2 and data_start_time<$3 order by data_start_time',[tenantId,range.start,range.end],'settlement_report_documents')
  ]);
  const reportDocuments=reportDocumentsResult.rows;
  return calculateDashboardMetrics({orders:orders.rows,orderItems:orderItems.rows,returns:returns.rows,settlementRows:settlementRows.rows,settlementHeaders:settlementHeaders.rows,financeItems:financeItems.rows,financeTransactions:financeTransactions.rows,reimbursements:reimbursements.rows,gstInvoices:gstInvoices.rows,reportDocuments,coverageRequired:true,schemaWarnings},range);
}

app.get('/api/tenants/:tenantId/calculations/:metric', async request => {
  const {tenantId,metric}=CalculationParamsSchema.parse(request.params); const range=await requestedMarketplaceRange(tenantId,request.query);
  await requireTenantUser(request,tenantId); await assertActiveTenant(tenantId);
  return withTenant(tenantId,async db=>{
    const calculated=await loadDashboardCalculations(db,tenantId,range);
    const detail=calculated.metrics[metric]??calculated.statement[metric];
    const rows=detail.rows??[];
    return {metric,total:detail.value,unit:detail.unit,status:detail.status,formula:detail.formula,source:detail.source,range:detail.range,diagnostics:detail.diagnostics,components:detail.components,rows,columns:rows.length?[...new Set(rows.flatMap(row=>Object.keys(row).filter(key=>key!=='raw')))].slice(0,14):[]};
  });
});

app.get('/api/tenants/:tenantId/transactions', async request => {
  const { tenantId }=TenantParamsSchema.parse(request.params); const range=requestedRange(request.query); await requireTenantUser(request,tenantId); await assertActiveTenant(tenantId);
  return withTenant(tenantId,async db=>{
    const rows=(await db.query(`with item_titles as (select amazon_order_id,string_agg(distinct title,', ') product_details from order_items where tenant_id=$1 group by amazon_order_id), components as (
      select transaction_id,count(*) filter(where category like 'summary_%') summary_lines,
        sum(amount) filter(where category='summary_product_charges') summary_product_charges,
        sum(amount) filter(where category='summary_promotional_rebates') summary_promotional_rebates,
        sum(amount) filter(where category='summary_amazon_fees') summary_amazon_fees,
        sum(amount) filter(where category='summary_other') summary_other,
        sum(amount) filter(where category in ('item_price','shipping_charge','gift_wrap') and amount>0) leaf_product_charges,
        sum(amount) filter(where category='promotion') leaf_promotions,
        sum(amount) filter(where amount<0 and category=any($4)) leaf_amazon_fees,
        sum(amount) filter(where category not like 'summary_%') leaf_total
      from finance_transaction_items where tenant_id=$1 group by transaction_id)
      select ft.transaction_id,ft.posted_date,coalesce(ft.raw->>'transactionStatus',ft.raw->>'TransactionStatus','Unknown') transaction_status,
        coalesce(ft.raw->>'accountType',ft.raw->>'AccountType',ft.raw#>>'{sellingPartnerMetadata,accountType}','Amazon transactions') account_type,
        ft.transaction_type,coalesce(ft.related_order_id,'---') order_id,coalesce(it.product_details,ft.raw->>'description',ft.transaction_type) product_details,
        case when coalesce(c.summary_lines,0)>0 then coalesce(c.summary_product_charges,0) else coalesce(c.leaf_product_charges,0) end product_charges,
        case when coalesce(c.summary_lines,0)>0 then coalesce(c.summary_promotional_rebates,0) else coalesce(c.leaf_promotions,0) end promotional_rebates,
        case when coalesce(c.summary_lines,0)>0 then coalesce(c.summary_amazon_fees,0) else coalesce(c.leaf_amazon_fees,0) end amazon_fees,
        coalesce(c.summary_other,coalesce(ft.total_amount,0)-case when coalesce(c.summary_lines,0)>0 then coalesce(c.summary_product_charges,0) else coalesce(c.leaf_product_charges,0) end-case when coalesce(c.summary_lines,0)>0 then coalesce(c.summary_promotional_rebates,0) else coalesce(c.leaf_promotions,0) end-case when coalesce(c.summary_lines,0)>0 then coalesce(c.summary_amazon_fees,0) else coalesce(c.leaf_amazon_fees,0) end) other,
        coalesce(ft.total_amount,c.leaf_total,0) total
      from finance_transactions ft left join components c on c.transaction_id=ft.transaction_id left join item_titles it on it.amazon_order_id=ft.related_order_id
      where ft.tenant_id=$1 and ft.posted_date >= $2 and ft.posted_date < $3 order by ft.posted_date desc,ft.transaction_id`,[tenantId,range.start,range.end,FEE_CATEGORIES])).rows;
    return {transactions:rows,count:rows.length,columns:['posted_date','transaction_status','account_type','transaction_type','order_id','product_details','product_charges','promotional_rebates','amazon_fees','other','total']};
  });
});

app.get('/api/tenants/:tenantId/orders-reconciliation', async request => {
  const { tenantId }=TenantParamsSchema.parse(request.params); const range=requestedRange(request.query); await requireTenantUser(request,tenantId); await assertActiveTenant(tenantId);
  return withTenant(tenantId,async db=>{
    const orders=(await db.query(`with scoped_order_ids as (
        select amazon_order_id from orders where tenant_id=$1 and order_date >= $2 and order_date < $3
        union select related_order_id from finance_transactions where tenant_id=$1 and related_order_id is not null and posted_date >= $2 and posted_date < $3),
      scoped_orders as (select ids.amazon_order_id,o.order_date,coalesce(o.status,'Payment posted') status,o.fulfillment_channel,o.total_amount from scoped_order_ids ids left join orders o on o.tenant_id=$1 and o.amazon_order_id=ids.amazon_order_id),
      item_totals as (select amazon_order_id,sum(item_price) gross_item_price,sum(quantity_ordered) units,string_agg(distinct title,', ') product from order_items where tenant_id=$1 group by amazon_order_id),
      latest_settlements as (select distinct on (line.order_id) line.order_id,line.settlement_id,
        header.settlement_start_date,header.settlement_end_date,header.deposit_date,header.settlement_total,header.settlement_currency
        from settlement_rows line
        left join lateral (
          select coalesce(raw->>'settlement-start-date',raw->>'settlement start date',raw->>'settlementStartDate') settlement_start_date,
            coalesce(raw->>'settlement-end-date',raw->>'settlement end date',raw->>'settlementEndDate') settlement_end_date,
            coalesce(raw->>'deposit-date',raw->>'deposit date',raw->>'depositDate') deposit_date,
            coalesce(raw->>'total-amount',raw->>'total amount',raw->>'totalAmount') settlement_total,
            coalesce(raw->>'currency',raw->>'Currency') settlement_currency
          from settlement_rows settlement_header
          where settlement_header.tenant_id=line.tenant_id and settlement_header.settlement_id=line.settlement_id
            and coalesce(raw->>'deposit-date',raw->>'deposit date',raw->>'depositDate','')<>''
          limit 1
        ) header on true
        where line.tenant_id=$1 and line.order_id is not null and line.settlement_id is not null
        -- An order can also appear in a different settlement as an Easy Ship or
        -- adjustment charge. Prefer the settlement containing the actual Order
        -- proceeds instead of simply choosing the latest charge row.
        order by line.order_id,
          case when lower(coalesce(line.raw->>'transaction-type',line.raw->>'transaction type',line.raw->>'transactionType',''))='order' then 0
               when lower(coalesce(line.amount_type,''))='itemprice' then 0 else 1 end,
          line.posted_date desc nulls last,line.settlement_id desc),
      chosen_transactions as (select distinct on (related_order_id) transaction_id,related_order_id,total_amount,posted_date,transaction_type,raw,
        coalesce(raw->>'transactionStatus',raw->>'TransactionStatus','Unknown') transaction_status
        from finance_transactions where tenant_id=$1 and related_order_id is not null
        order by related_order_id,
          case when regexp_replace(lower(coalesce(transaction_type,'')),'[^a-z]','','g')='orderpayment' then 0 else 1 end,
          case when lower(coalesce(raw->>'transactionStatus',raw->>'TransactionStatus',''))='released' then 0 else 1 end,
          posted_date desc),
      -- The transaction header is Amazon's authoritative order association. Some
      -- item breakdown nodes omit order_id, so filtering on fi.order_id can drop
      -- otherwise valid Order Payment summary lines and produce a mixed payout.
      fees as (select ct.related_order_id order_id,count(*) fee_lines,
      sum(fi.amount) filter(where fi.category='referral_commission' and fi.amount<0) referral_commission,sum(fi.amount) filter(where fi.category like 'fulfillment_fee%' and fi.amount<0) fulfillment_fee,sum(fi.amount) filter(where fi.category='shipping_fee' and fi.amount<0) shipping_fee,sum(fi.amount) filter(where fi.category='closing_fee' and fi.amount<0) closing_fee,
      sum(fi.amount) filter(where fi.category in ('gift_wrap_fee','digital_services_fee','storage_fee','chargeback','adjustment','other') and fi.amount<0) other_fees,sum(fi.amount) filter(where fi.category='promotion') promotion,sum(fi.amount) filter(where fi.category='refund') refund,sum(fi.amount) filter(where fi.category='reimbursement') reimbursement,
      sum(fi.amount) filter(where fi.category='shipping_charge') shipping_charge,sum(fi.amount) filter(where fi.category='tax') tax,
      sum(fi.amount) filter(where fi.category in ('item_price','shipping_charge','gift_wrap') and fi.amount>0) finance_gross,
      sum(fi.amount) filter(where fi.category='summary_product_charges') summary_product_charges,
      sum(fi.amount) filter(where fi.category='summary_promotional_rebates') summary_promotional_rebates,
      sum(fi.amount) filter(where fi.category='summary_amazon_fees') summary_amazon_fees,
      sum(fi.amount) filter(where fi.category='summary_other') summary_other,
      count(*) filter(where fi.category like 'summary_%') summary_lines,
      sum(fi.amount) filter(where fi.category not like 'summary_%') leaf_total,max(ct.total_amount) transaction_header_total,max(ct.posted_date) transaction_date,
      bool_or(regexp_replace(lower(coalesce(ct.transaction_type,'')),'[^a-z]','','g')='orderpayment') is_order_payment,
      bool_or(lower(ct.transaction_status)='released') payment_released,
      max(ct.transaction_status) transaction_status,
      max(ct.posted_date) filter(where lower(ct.transaction_status)='released') payout_date_time,
      sum(abs(fi.amount)) filter(where fi.amount<0 and fi.category=any($4)) total_deductions
      from finance_transaction_items fi join chosen_transactions ct on ct.transaction_id=fi.transaction_id
      where fi.tenant_id=$1 group by ct.related_order_id)
      select o.amazon_order_id,o.order_date,f.transaction_date,o.status,o.fulfillment_channel,i.product,coalesce(i.units,0) units,
      s.settlement_id,s.settlement_start_date,s.settlement_end_date,s.deposit_date,s.settlement_total,s.settlement_currency,
      case when coalesce(f.is_order_payment,false) then coalesce(nullif(f.summary_product_charges,0),nullif(f.finance_gross,0),nullif(i.gross_item_price,0),o.total_amount,0) else coalesce(nullif(i.gross_item_price,0),o.total_amount,0) end gross_item_price,
      abs(coalesce(f.referral_commission,0)) referral_commission,abs(coalesce(f.fulfillment_fee,0)) fulfillment_fee,abs(coalesce(f.shipping_fee,0)) shipping_fee,abs(coalesce(f.closing_fee,0)) closing_fee,abs(coalesce(f.other_fees,0)) other_fees,case when coalesce(f.summary_lines,0)>0 then coalesce(f.summary_promotional_rebates,0) else coalesce(f.promotion,0) end promotion,coalesce(f.refund,0) refund,coalesce(f.reimbursement,0) reimbursement,case when coalesce(f.summary_lines,0)>0 then abs(coalesce(f.summary_amazon_fees,0)) else coalesce(f.total_deductions,0) end total_deductions,
      case when coalesce(f.is_order_payment,false) then coalesce(f.summary_other,f.transaction_header_total-coalesce(nullif(f.summary_product_charges,0),f.finance_gross,0)-coalesce(f.summary_promotional_rebates,f.promotion,0)-coalesce(f.summary_amazon_fees,-f.total_deductions,0)) else 0 end other_amount,f.transaction_header_total,
      case when coalesce(f.is_order_payment,false) then f.transaction_header_total else null end net_payout,coalesce(f.is_order_payment,false) "hasFeeData",
      (s.deposit_date is not null or coalesce(f.payment_released,false)) payment_received,
      case when s.deposit_date is not null then 'Deposit initiated by Amazon' when coalesce(f.payment_released,false) then 'Released by Amazon' when coalesce(f.is_order_payment,false) then coalesce(f.transaction_status,'Not released') else 'Awaiting payment data' end payout_status,
      coalesce(s.deposit_date,f.payout_date_time::text) payout_date_time
      from scoped_orders o left join item_totals i on i.amazon_order_id=o.amazon_order_id left join fees f on f.order_id=o.amazon_order_id left join latest_settlements s on s.order_id=o.amazon_order_id order by "hasFeeData" desc,f.transaction_date desc nulls last,o.order_date desc`,[tenantId,range.start,range.end,FEE_CATEGORIES])).rows;
    const hasFinanceItems=orders.some(order=>order.hasFeeData);
    if (!hasFinanceItems) {
      const settlement=(await db.query(`select line.order_id,line.settlement_id,line.amount_type,line.amount_description,line.amount,line.posted_date,
        coalesce(line.raw->>'transaction-type',line.raw->>'transaction type',line.raw->>'transactionType') transaction_type,
        metadata.deposit_date
        from settlement_rows line
        left join lateral (
          select coalesce(raw->>'deposit-date',raw->>'deposit date',raw->>'depositDate') deposit_date
          from settlement_rows header
          where header.tenant_id=line.tenant_id and header.settlement_id=line.settlement_id
            and coalesce(raw->>'deposit-date',raw->>'deposit date',raw->>'depositDate','')<>''
          limit 1
        ) metadata on true
        where line.tenant_id=$1 and line.order_id is not null`,[tenantId])).rows;
      const byOrder=new Map(); for(const row of settlement){const list=byOrder.get(row.order_id)??[];list.push({...row,category:categorizeFinanceLabel(`${row.amount_type} ${row.amount_description}`)});byOrder.set(row.order_id,list);}
      for (const order of orders) {
        const lines=byOrder.get(order.amazon_order_id)??[]; if(!lines.length) continue;
        const sum=predicate=>lines.filter(predicate).reduce((total,line)=>total+Number(line.amount),0);
        order.referral_commission=Math.abs(sum(line=>line.category==='referral_commission'&&Number(line.amount)<0));
        order.fulfillment_fee=Math.abs(sum(line=>line.category.startsWith('fulfillment_fee')&&Number(line.amount)<0));
        order.shipping_fee=Math.abs(sum(line=>line.category==='shipping_fee'&&Number(line.amount)<0));
        order.closing_fee=Math.abs(sum(line=>line.category==='closing_fee'&&Number(line.amount)<0));
        order.other_fees=Math.abs(sum(line=>['gift_wrap_fee','digital_services_fee','storage_fee','chargeback','adjustment','other'].includes(line.category)&&Number(line.amount)<0));
        order.promotion=sum(line=>line.category==='promotion'); order.refund=sum(line=>line.category==='refund'); order.reimbursement=sum(line=>line.category==='reimbursement');
        order.total_deductions=lines.filter(line=>FEE_CATEGORIES.includes(line.category)&&Number(line.amount)<0).reduce((total,line)=>total+Math.abs(Number(line.amount)),0);
        const settlementGross=sum(line=>['item_price','shipping_charge','gift_wrap'].includes(line.category)&&Number(line.amount)>0); if(settlementGross) order.gross_item_price=settlementGross;
        order.net_payout=lines.reduce((total,line)=>total+Number(line.amount),0); order.other_amount=order.net_payout-Number(order.gross_item_price)-Number(order.promotion)+order.total_deductions;
        const payoutLine=lines.find(line=>String(line.transaction_type??'').toLowerCase()==='order'||String(line.amount_type??'').toLowerCase()==='itemprice')??lines[0];
        const payoutSettlementId=payoutLine?.settlement_id??order.settlement_id??null;
        const depositDate=lines.find(line=>line.settlement_id===payoutSettlementId&&line.deposit_date)?.deposit_date??null;
        order.settlement_id=payoutSettlementId;
        order.hasFeeData=true; order.feeSource='Settlement report';
        order.payment_received=Boolean(depositDate); order.payout_date_time=depositDate??null;
        order.payout_status=depositDate?'Deposit initiated by Amazon':'Settlement recorded; deposit date unavailable';
      }
    }
    return {orders,source:hasFinanceItems?'Finances API':'Settlement report fallback'};
  });
});

app.get('/api/tenants/:tenantId/orders-reconciliation/:orderId', async request => {
  const {tenantId,orderId}=OrderDetailParamsSchema.parse(request.params); await requireTenantUser(request,tenantId); await assertActiveTenant(tenantId);
  return withTenant(tenantId,async db=>{
    const order=(await db.query('select * from orders where tenant_id=$1 and amazon_order_id=$2',[tenantId,orderId])).rows[0]??null;
    const items=(await db.query('select asin,sku,title,quantity_ordered,item_price,item_tax,promotion_discount,package_weight,weight_unit,package_dimensions from order_items where tenant_id=$1 and amazon_order_id=$2',[tenantId,orderId])).rows;
    // Match detail lines through the canonical transaction header: item breakdown
    // order identifiers are optional in Amazon's Finances response.
    let fees=(await db.query(`with chosen as (select transaction_id from finance_transactions where tenant_id=$1 and related_order_id=$2 order by
      case when regexp_replace(lower(coalesce(transaction_type,'')),'[^a-z]','','g')='orderpayment' then 0 else 1 end,
      case when lower(coalesce(raw->>'transactionStatus',raw->>'TransactionStatus',''))='released' then 0 else 1 end,posted_date desc limit 1)
      select fi.transaction_id,fi.category,fi.amount_description,fi.amount,fi.currency,fi.posted_date,fi.raw from finance_transaction_items fi join chosen c on c.transaction_id=fi.transaction_id where fi.tenant_id=$1 order by fi.posted_date,fi.category`,[tenantId,orderId])).rows;
    let source='Finances API';
    if(!fees.length){source='Settlement report';fees=(await db.query("select settlement_id transaction_id,amount_type,amount_description,amount,'INR' currency,posted_date,raw from settlement_rows where tenant_id=$1 and order_id=$2 order by posted_date",[tenantId,orderId])).rows.map(row=>({...row,category:categorizeFinanceLabel(`${row.amount_type} ${row.amount_description}`)}));}
    return {order,items,fees,source};
  });
});

app.post('/api/tenants/:tenantId/fee-audit',async request=>{const {tenantId}=TenantParamsSchema.parse(request.params);await requireTenantUser(request,tenantId);await assertActiveTenant(tenantId);const body=z.object({range:DateRangeSchema.optional(),varianceThreshold:z.number().min(0).optional()}).parse(request.body??{});return runFeeAuditForTenant(tenantId,body);});
app.get('/api/tenants/:tenantId/fee-leaks',async request=>{const {tenantId}=TenantParamsSchema.parse(request.params);const range=requestedRange(request.query);await requireTenantUser(request,tenantId);await assertActiveTenant(tenantId);return withTenant(tenantId,async db=>{const flags=(await db.query('select order_id,sku,category,source,expected_fee,actual_fee,variance,flagged_at,resolved from fee_leak_flags where tenant_id=$1 and flagged_at >= $2 and flagged_at < $3 order by abs(variance) desc',[tenantId,range.start,range.end])).rows;return{flags,totalOvercharged:flags.filter(row=>Number(row.variance)>0).reduce((sum,row)=>sum+Number(row.variance),0)};});});

app.get('/api/tenants/:tenantId/dashboard', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params); await requireTenantUser(request, tenantId); await assertActiveTenant(tenantId);
  const range = await requestedMarketplaceRange(tenantId,request.query);
  const start = new Date(range.start);
  const end = new Date(range.end);
  const sellerRow = (await pool.query(`select seller_name, amazon_seller_id, marketplace_id, auth_status, connected_at, last_token_refresh_at from sellers
    where tenant_id=$1 and auth_status='authorized' order by connected_at desc limit 1`, [tenantId])).rows[0] ?? null;
  const seller = sellerRow
    ? { connected: true, sellerName: sellerRow.seller_name, sellerId: sellerRow.amazon_seller_id, marketplaceId: sellerRow.marketplace_id, authStatus: sellerRow.auth_status, connectedAt: sellerRow.connected_at, lastTokenRefreshAt: sellerRow.last_token_refresh_at }
    : { connected: false };
  return withTenant(tenantId, async client => {
    // Requests interrupted by a process restart or disconnected client can
    // leave a running row behind after imported data was committed. Persist
    // the timeout so all pages agree and the stale state does not live forever.
    await client.query(
      `update sync_jobs
       set status='failed', completed_at=coalesce(completed_at, started_at + interval '6 minutes'),
           error_message=coalesce(error_message, 'Sync stopped before completion. Please retry.')
       where tenant_id=$1 and status='running' and started_at < now() - interval '6 minutes'`,
      [tenantId]
    );
    const amazonAuth = (await pool.query("select amazon_seller_id, marketplace_id, auth_status, connected_at, last_token_refresh_at from sellers where tenant_id=$1 and auth_status='authorized' order by connected_at desc limit 1", [tenantId])).rows[0] ?? null;
    const kpis = (await client.query(`select coalesce(sum(amount),0) net_settled, coalesce(sum(case when amount > 0 then amount else 0 end),0) earnings, coalesce(sum(case when amount < 0 then amount else 0 end),0) deductions from settlement_rows where tenant_id=$1 and posted_date >= $2 and posted_date < $3`, [tenantId, start, end])).rows[0];
    const orders = (await client.query(`select count(*) orders, coalesce(sum(total_amount),0) order_value from orders where tenant_id=$1 and order_date >= $2 and order_date < $3`, [tenantId, start, end])).rows[0];
    const businessReportRows = (await client.query(`
      with scoped as (
        select * from sales_traffic_daily
        where tenant_id=$1 and date >= $2::date and date < $3::date
      ), daily as (
        select date,
          coalesce(sum(ordered_product_sales),0) ordered_product_sales,
          coalesce(sum(ordered_product_sales_b2b),0) ordered_product_sales_b2b,
          coalesce(sum(units_ordered),0) units_ordered,
          coalesce(sum(units_ordered_b2b),0) units_ordered_b2b,
          coalesce(sum(total_order_items),0) total_order_items,
          coalesce(sum(total_order_items_b2b),0) total_order_items_b2b,
          coalesce(avg(nullif(average_sales_per_order_item,0)),0) average_sales_per_order_item,
          coalesce(avg(nullif(average_sales_per_order_item_b2b,0)),0) average_sales_per_order_item_b2b,
          coalesce(avg(nullif(average_units_per_order_item,0)),0) average_units_per_order_item,
          coalesce(avg(nullif(average_units_per_order_item_b2b,0)),0) average_units_per_order_item_b2b,
          coalesce(avg(nullif(average_selling_price,0)),0) average_selling_price
        from scoped where not exists (select 1 from scoped all_rows where all_rows.date=scoped.date and all_rows.asin='ALL')
        group by date
        union all
        select date, ordered_product_sales, ordered_product_sales_b2b, units_ordered, units_ordered_b2b, total_order_items, total_order_items_b2b, average_sales_per_order_item, average_sales_per_order_item_b2b, average_units_per_order_item, average_units_per_order_item_b2b, average_selling_price
        from scoped where asin='ALL'
      )
      select * from daily order by date desc limit 120`, [tenantId, start, end])).rows.reverse();
    const products = (await client.query(`
      with traffic_products as (
        select asin, sum(units_ordered) units, sum(ordered_product_sales) sales, avg(featured_offer_percentage) buy_box
        from sales_traffic_daily
        where tenant_id=$1 and date >= $2::date and date < $3::date and asin is not null and asin <> 'ALL'
        group by asin
      ), item_products as (
        select asin, sum(quantity_ordered) units, sum(item_price) sales, null::numeric buy_box
        from order_items oi
        join orders o on o.tenant_id=oi.tenant_id and o.amazon_order_id=oi.amazon_order_id
        where oi.tenant_id=$1 and o.order_date >= $2 and o.order_date < $3 and oi.asin is not null
        group by asin
      ), merged as (
        select coalesce(t.asin, i.asin) asin,
          greatest(coalesce(t.units, 0), coalesce(i.units, 0)) units,
          greatest(coalesce(t.sales, 0), coalesce(i.sales, 0)) sales,
          t.buy_box
        from traffic_products t full outer join item_products i on i.asin = t.asin
      )
      select asin, units, sales, buy_box from merged order by sales desc nulls last, units desc nulls last limit 20`, [tenantId, start, end])).rows;
    const trend = (await client.query(`
      with traffic_trend as (
        select date, sum(ordered_product_sales) sales, sum(units_ordered) units, sum(sessions) sessions
        from sales_traffic_daily
        where tenant_id=$1 and date >= $2::date and date < $3::date
        group by date
      ), order_trend as (
        select date(order_date) date, sum(total_amount) sales, coalesce(sum(items.quantity), 0) units, 0::bigint sessions
        from orders o
        left join lateral (
          select sum(quantity_ordered) quantity from order_items oi where oi.tenant_id=o.tenant_id and oi.amazon_order_id=o.amazon_order_id
        ) items on true
        where o.tenant_id=$1 and o.order_date >= $2 and o.order_date < $3 and o.order_date is not null
        group by date(o.order_date)
      ), merged as (
        select coalesce(t.date, o.date) date,
          greatest(coalesce(t.sales, 0), coalesce(o.sales, 0)) sales,
          greatest(coalesce(t.units, 0), coalesce(o.units, 0)) units,
          coalesce(t.sessions, o.sessions, 0) sessions
        from traffic_trend t full outer join order_trend o on o.date = t.date
      )
      select date, sales, units, sessions from merged order by date desc limit 90`, [tenantId, start, end])).rows.reverse();
    const payments = (await client.query(`
      with settlement_payments as (
        select settlement_id, date(posted_date) posted_date, sum(amount) net_amount, count(*) lines
        from settlement_rows
        where tenant_id=$1 and posted_date >= $2 and posted_date < $3
        group by settlement_id,date(posted_date)
      ), finance_payments as (
        select coalesce(transaction_id, related_order_id, 'finance-' || date(posted_date)::text) settlement_id,
          date(posted_date) posted_date,
          sum(total_amount) net_amount,
          count(*) lines
        from finance_transactions
        where tenant_id=$1 and posted_date >= $2 and posted_date < $3 and posted_date is not null
        group by coalesce(transaction_id, related_order_id, 'finance-' || date(posted_date)::text), date(posted_date)
      ), merged as (
        select * from settlement_payments
        union all
        select * from finance_payments where not exists (select 1 from settlement_payments)
      )
      select settlement_id, posted_date, net_amount, lines from merged order by posted_date desc nulls last limit 100`, [tenantId, start, end])).rows;
    const jobs = (await client.query(`
      with normalized_jobs as (
        select report_type, status, started_at, completed_at, error_message, s3_key
        from sync_jobs where tenant_id=$1
      )
      select distinct on (report_type) report_type, status, started_at, completed_at, error_message, s3_key
      from normalized_jobs
      order by report_type, started_at desc nulls last
    `, [tenantId])).rows;
    const settlementLines = (await client.query('select settlement_id, order_id, amount_type, amount_description, amount, posted_date from settlement_rows where tenant_id=$1 and posted_date >= $2 and posted_date < $3 order by posted_date desc nulls last limit 250', [tenantId, start, end])).rows;
    const orderRows = (await client.query(`
      select o.amazon_order_id, o.order_date, o.status, o.total_amount, o.fulfillment_channel, o.sales_channel,
        count(oi.id) item_lines,
        string_agg(distinct oi.title, ', ') product,
        string_agg(distinct oi.asin, ', ') asin,
        string_agg(distinct oi.sku, ', ') sku,
        string_agg(distinct case when oi.package_weight is not null then trim(to_char(oi.package_weight, 'FM999999990.###')) || ' ' || coalesce(oi.weight_unit, '') end, ', ') package_weight,
        string_agg(distinct oi.package_dimensions, ', ') package_dimensions,
        coalesce(sum(oi.item_price),0) item_value,
        coalesce(sum(oi.item_tax),0) item_tax,
        coalesce(sum(oi.promotion_discount),0) promotion_discount
      from orders o
      left join order_items oi on oi.tenant_id=o.tenant_id and oi.amazon_order_id=o.amazon_order_id
      where o.tenant_id=$1 and o.order_date >= $2 and o.order_date < $3
      group by o.amazon_order_id, o.order_date, o.status, o.total_amount, o.fulfillment_channel, o.sales_channel
      order by o.order_date desc nulls last limit 250`, [tenantId, start, end])).rows;
    const inventory = (await client.query('select sku, fulfillable_quantity, snapshot_date from inventory_snapshots where tenant_id=$1 and snapshot_date >= $2::date and snapshot_date < $3::date order by snapshot_date desc, fulfillable_quantity desc nulls last limit 50', [tenantId, start, end])).rows;
    const returns = (await client.query('select order_id, return_reason, disposition, status, return_date, quantity from returns where tenant_id=$1 and return_date >= $2::date and return_date < $3::date order by return_date desc nulls last limit 50', [tenantId, start, end])).rows;
    const reimbursements = (await client.query('select sku, amount, reason, reimbursement_date from reimbursements where tenant_id=$1 and reimbursement_date >= $2::date and reimbursement_date < $3::date order by reimbursement_date desc nulls last limit 50', [tenantId, start, end])).rows;
    const invoices = (await client.query('select invoice_type, order_id, taxable_value, cgst, sgst, igst, invoice_date from gst_invoices where tenant_id=$1 and invoice_date >= $2::date and invoice_date < $3::date order by invoice_date desc nulls last limit 50', [tenantId, start, end])).rows;
    const orderItems = (await client.query('select oi.amazon_order_id, oi.asin, oi.sku, oi.title, oi.quantity_ordered, oi.item_price, oi.item_tax, oi.promotion_discount from order_items oi join orders o on o.tenant_id=oi.tenant_id and o.amazon_order_id=oi.amazon_order_id where oi.tenant_id=$1 and o.order_date >= $2 and o.order_date < $3 order by oi.quantity_ordered desc nulls last limit 50', [tenantId, start, end])).rows;
    const financeTransactions = (await client.query('select transaction_id, transaction_type, posted_date, total_amount, currency, related_order_id, raw from finance_transactions where tenant_id=$1 and posted_date >= $2 and posted_date < $3 order by posted_date desc nulls last limit 2000', [tenantId, start, end])).rows;
    const financialComponents = [...settlementComponentRows(settlementLines), ...financeTransactions.flatMap(financeComponentRows)];
    const financialSummary = summarizeComponents(financialComponents);
    const orderPayments = buildOrderPaymentRows(orderRows, settlementLines, financeTransactions);
    const paymentComponents = orderPayments.flatMap(order => order.components.map(component => ({
      amazon_order_id: order.amazon_order_id, product: order.product, asin: order.asin, sku: order.sku,
      fulfillment: order.fulfillment, package_weight: order.package_weight, package_dimensions: order.package_dimensions,
      posted_date: component.posted_date, source: component.source, category: component.category,
      deduction: component.component, amount: component.amount
    })));
    const paymentSummary = orderPayments.reduce((summary, order) => {
      summary.grossSales += Number(order.gross_sales ?? 0);
      summary.deductions += Number(order.total_deductions ?? 0);
      summary.sellerReceivable += Number(order.seller_receivable ?? 0);
      summary[order.fulfillment === 'FBA' ? 'fbaReceivable' : order.fulfillment === 'FBM' ? 'fbmReceivable' : 'otherReceivable'] += Number(order.seller_receivable ?? 0);
      return summary;
    }, { grossSales: 0, deductions: 0, sellerReceivable: 0, fbaReceivable: 0, fbmReceivable: 0, otherReceivable: 0 });
    const dashboardCalculations=await loadDashboardCalculations(client,tenantId,{start:start.toISOString(),end:end.toISOString()});
    const hasImportedData = Number(orders.orders ?? 0) > 0 || Number(kpis.net_settled ?? 0) !== 0 || products.length > 0 || payments.length > 0 || inventory.length > 0;
    return { seller, amazonAuth, hasImportedData, kpis, orders, orderRows, orderPayments, paymentComponents, paymentSummary, dashboardCalculations, businessReportRows, products, trend, payments, settlementLines, financialComponents, financialSummary, jobs, inventory, returns, reimbursements, invoices, orderItems, financeTransactions };
  });
});

// Backward-compatible report endpoints for existing clients.
app.get('/api/tenants/:tenantId/summary', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  await requireTenantUser(request, tenantId);
  await assertActiveTenant(tenantId);
  return withTenant(tenantId, async client => ({
    settlementTotal: (await client.query('select coalesce(sum(amount),0) total from settlement_rows where tenant_id=$1', [tenantId])).rows[0].total,
    grossSales: (await client.query("select coalesce(sum(amount),0) total from settlement_rows where tenant_id=$1 and (amount_type ilike '%principal%' or amount_description ilike '%principal%')", [tenantId])).rows[0].total,
    fees: (await client.query("select coalesce(sum(amount),0) total from settlement_rows where tenant_id=$1 and amount < 0 and (amount_type ilike '%fee%' or amount_description ilike '%fee%')", [tenantId])).rows[0].total,
    feeLeaks: (await client.query('select count(*) count from fee_leak_flags where tenant_id=$1', [tenantId])).rows[0].count,
    recentJobs: (await client.query('select report_type,status,started_at,completed_at,error_message,s3_key from sync_jobs where tenant_id=$1 order by started_at desc nulls last limit 10', [tenantId])).rows
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
  await ensureTenantDataIsolationSchema()
    .catch(error => app.log.warn({ err: normalizeDatabaseError(error) }, 'Tenant data isolation self-check skipped; run migrations before serving tenant dashboards'));
  await pool.query("insert into users(id,email,password_hash,role,status) values($1,$2,$3,'admin','active') on conflict(email) do nothing", [adminId, defaultAdminEmail, hashPassword(defaultAdminPassword)])
    .catch(error => app.log.warn({ err: normalizeDatabaseError(error) }, 'Admin seed skipped; run migrations before first login'));
}

startScheduler();
await app.listen({ port: 4000, host: '0.0.0.0' });
