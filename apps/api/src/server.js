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
import { buildGstInvoicesFromOrderItems, isPermissionRefusal, runInitialSellerBackfill, saveStructuredRows, startScheduler, syncRecentApiDataForTenant, syncReportForTenant } from './jobs/sync.js';
import { buildRestoreStatements, createSyncQueue } from './jobs/sync-queue.js';
import { calendarDay, calendarDays } from './jobs/reporting-calendar.js';
import { categorizeFinanceLabel } from './jobs/finance-components.js';
import { CALCULATION_REVISION, calculateDashboardMetrics } from './jobs/dashboard-calculations.js';
import { matchesAmazonTotal, round2, statementBucket, statementPeriod, summariseStatementRows } from './jobs/settlement-statements.js';
import { runFeeAuditForTenant } from './jobs/fee-audit.js';
import { startSchedulingScheduler } from './jobs/scheduling-sync.js';
import schedulingRoutes from './routes/scheduling.js';

// Default 1 MiB body limit is fine for every other route, but a manually
// uploaded settlement or GST MTR flat file (see /reports/:reportType/upload)
// - sent as a JSON string, not multipart, to avoid a new dependency for
// something this codebase already handles as raw text everywhere else - can
// legitimately run tens of thousands of rows for a full quarter. 25 MiB is
// generous enough for that while staying nowhere near "someone could DoS the
// process with this."
const app = Fastify({ logger: { redact: ['req.headers.authorization', 'refresh_token', 'access_token', 'password', 'passwordHash'] }, trustProxy: true, bodyLimit: 25 * 1024 * 1024 });

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
const DashboardQuerySchema = z.object({ start: z.string().datetime().optional(), end: z.string().datetime().optional() });
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


const TENANT_DATA_TABLES = ['orders', 'settlement_rows', 'gst_invoices', 'returns', 'reimbursements', 'inventory_snapshots', 'sales_traffic_daily', 'fee_leak_flags', 'generated_reports', 'order_items', 'finance_transactions', 'finance_transaction_items', 'fee_estimates'];

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
  // Keeps the authorization callback itself fast: the seller is already
  // marked connected before this runs, and the backfill continues in the
  // background rather than making the seller's browser wait on it. It is
  // the ONLY chance to ever capture this seller's last 90 days - see
  // runInitialSellerBackfill and 019_seller_initial_backfill.sql. The
  // dashboard shows a real, per-source progress screen and blocks date-range
  // selection until this finishes, so an in-progress backfill is never
  // mistaken for a complete (and possibly wrong) figure.
  runInitialSellerBackfill(tenantId).catch(error => app.log.warn({ err: error, tenantId }, 'Initial 90-day backfill failed'));
}

// runInitialSellerBackfill calls syncRecentApiDataForTenant/syncReportForTenant
// directly, one report type at a time, deliberately NOT through
// runExclusiveSync (sync-queue.js) - that queue is keyed per tenant+report
// type and lives only in this module, so a call routed through it here would
// not actually be visible to a backfill running the same tenant+report type
// from a different await chain. Blocking every OTHER path that can start a
// sync for this tenant while a backfill is under way is simpler and
// airtight: nothing else can ever compete with it for the same Amazon rate
// bucket. This is checked - not just left to the frontend's own gating - so
// a stale tab, a direct API call, or a race during the few seconds after
// authorization can't trigger a second, concurrent sync against the same
// account.
async function assertNoBackfillRunning(tenantId, action = 'This action') {
  const row = (await pool.query("select backfill_status from sellers where tenant_id=$1 and auth_status='authorized' order by connected_at desc limit 1", [tenantId])).rows[0];
  if (row?.backfill_status === 'running') {
    throw Object.assign(new Error(`${action} is unavailable while your first 90 days of data are still syncing. This finishes automatically - please wait.`), { statusCode: 409 });
  }
}


async function recordSyntheticReportSync(tenantId, reportType, s3Key = 'fallback://direct-sp-api', note = null, range = null) {
  await pool.query(
    `insert into sync_jobs(tenant_id, report_type, status, started_at, completed_at, s3_key, error_message, range_start, range_end)
     values($1,$2,'completed',now(),now(),$3,$4,$5,$6)`,
    [tenantId, reportType, s3Key, note, range?.start ?? null, range?.end ?? null]
  );
}

// A completed sync from the last few minutes that already fully covers the
// newly requested range is data we already have - re-hitting Amazon for it
// only burns rate-limit budget (confirmed by this account's own SP-API usage
// report: heavy 429s across orders, report creation, and document downloads)
// without changing the answer. A DB-only recency check costs nothing and
// keeps genuinely new ranges, or a sync more than a few minutes old, working
// exactly as before.
const SYNC_REUSE_WINDOW_MS = 5 * 60 * 1000;
async function findReusableSync(tenantId, reportType, range, windowMs = SYNC_REUSE_WINDOW_MS) {
  if (!range?.start || !range?.end) return null;
  const recent = await pool.query(
    `select id, completed_at, range_start, range_end from sync_jobs
     where tenant_id=$1 and report_type=$2 and status='completed'
       and completed_at is not null and completed_at > now() - ($5::bigint * interval '1 millisecond')
       and range_start is not null and range_end is not null
       and range_start <= $3 and range_end >= $4
     order by completed_at desc limit 1`,
    [tenantId, reportType, range.start, range.end, windowMs]
  );
  return recent.rows[0] ?? null;
}

// A seller opening the dashboard for a date range should never have to know
// that "sync" is a concept, let alone click it per report - they just want
// correct numbers for the range they picked. Anything not covered by a
// reasonably recent completed sync gets fetched automatically in the
// background (not awaited - a full sync can take minutes, and the dashboard
// must still respond with whatever data already exists) the moment the
// dashboard is opened for that range.
const AUTO_SYNC_FRESHNESS_WINDOW_MS = 60 * 60 * 1000;
// A range that ends before right now is CLOSED - nothing about a past day's
// orders, settlements or invoices changes after the fact, so once fully
// synced once it never needs to be re-asked for again. Confirmed this
// mattered live: after the initial 90-day backfill, picking a different
// (also fully past) date range inside that same window still re-triggered a
// live Amazon call every time the freshness window lapsed, even though the
// data was already sitting in the database from the backfill - "already
// downloaded" was true but unused. Only a range that still touches today (or
// later) can receive genuinely new activity, so that's the only case that
// still needs the short freshness window below.
function isClosedRange(range) { return new Date(range.end).getTime() <= Date.now(); }
// Effectively "forever" without being literal Infinity, which the interval
// arithmetic in findReusableSync (windowMs * '1 millisecond') should not be
// asked to hold.
const CLOSED_RANGE_REUSE_WINDOW_MS = 100 * 365 * 864e5;
const AUTO_SYNC_REPORT_TYPES = Object.freeze(['DIRECT_SP_API_SYNC', 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', 'GET_SALES_AND_TRAFFIC_REPORT', 'GET_GST_MTR_B2B_CUSTOM', 'GET_GST_MTR_B2C_CUSTOM', 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', 'GET_FBA_REIMBURSEMENTS_DATA', 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA']);
// Nothing below this line may let the app call Amazon more often than a
// careful human would. A seller's SP-API quota is shared across their whole
// account, and sustained pointless traffic is exactly what gets an
// application throttled or its access reviewed. Two independent runaway paths
// existed and are closed here.
//
// 1. A report type the account is not authorised for (seen live: repeated
//    "GET_SALES_AND_TRAFFIC_REPORT failed: Create report failed: 403") never
//    records a completed sync, so the "is it already synced?" check could
//    never be satisfied and it was re-requested on every single dashboard
//    load, for as long as the dashboard stayed open. A 403 is a permission
//    answer, not a transient error, and re-asking cannot change it.
// 2. The in-flight check reads sync_jobs, but two dashboard requests arriving
//    before the first has inserted its 'running' row both see nothing running
//    and both start a full sync. The dashboard takes seconds to answer, so
//    that window is wide open in practice.
const SYNC_RETRY_BASE_MS = 15 * 60 * 1000;
const SYNC_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
// How long to wait before auto-retrying a report type that keeps failing.
// Backs off exponentially from 15 minutes to a 6 hour ceiling, so a
// permanently unauthorised report settles at 4 attempts a day instead of one
// per page load, while a genuinely transient failure still recovers quickly.
async function autoSyncBackoffRemainingMs(tenantId, reportType) {
  const { rows } = await pool.query(
    `select status, coalesce(completed_at, started_at) as at_time from sync_jobs
     where tenant_id=$1 and report_type=$2 and status in ('completed','failed')
     order by coalesce(completed_at, started_at) desc limit 12`,
    [tenantId, reportType]
  );
  let consecutiveFailures = 0;
  for (const row of rows) {
    if (row.status !== 'failed') break;
    consecutiveFailures += 1;
  }
  if (!consecutiveFailures || !rows[0]?.at_time) return 0;
  const wait = Math.min(SYNC_RETRY_MAX_MS, SYNC_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1));
  return Math.max(0, wait - (Date.now() - new Date(rows[0].at_time).getTime()));
}
/**
 * How long to wait before automatically retrying a report Amazon refused on
 * permission grounds, or 0 if it is due.
 *
 * This is a long backoff, NOT a stop, and the difference matters. A first
 * version of this skipped such a report entirely until someone clicked Sync by
 * hand - which quietly made the product manual exactly where it promises not
 * to be: a seller who gets the role granted should see their data appear on
 * its own, not have to know to come back and press a button. It also traded
 * that away for nothing, because the existing exponential backoff already
 * capped retries at six hours; the rate-limit waste it was meant to stop was
 * not happening.
 *
 * What it does buy is skipping the early rungs of that exponential ladder.
 * Fifteen minutes, then thirty, then an hour are sensible for a transient
 * failure and pointless for a permission one: only granting the role and
 * re-authorizing changes the answer, and neither happens in fifteen minutes.
 * So a refusal goes straight to the six-hour cap.
 *
 * Only the LATEST attempt is consulted, so one successful sync clears it with
 * nothing to remember to undo.
 */
const PERMISSION_REFUSAL_RETRY_MS = SYNC_RETRY_MAX_MS;
async function permissionRefusalWaitMs(tenantId, reportType) {
  const { rows } = await pool.query(
    `select status, error_message, coalesce(completed_at, started_at) as at_time from sync_jobs
      where tenant_id=$1 and report_type=$2
      order by started_at desc nulls last limit 1`,
    [tenantId, reportType]
  );
  const last = rows[0];
  if (!last || last.status === 'completed' || !isPermissionRefusal(last.error_message)) return 0;
  if (!last.at_time) return 0;
  return Math.max(0, PERMISSION_REFUSAL_RETRY_MS - (Date.now() - new Date(last.at_time).getTime()));
}

async function findMissingReportTypes(tenantId, range) {
  if (!range?.start || !range?.end) return [];
  const missing = [];
  const freshnessWindowMs = isClosedRange(range) ? CLOSED_RANGE_REUSE_WINDOW_MS : AUTO_SYNC_FRESHNESS_WINDOW_MS;
  for (const reportType of AUTO_SYNC_REPORT_TYPES) {
    const reusable = await findReusableSync(tenantId, reportType, range, freshnessWindowMs);
    if (reusable) continue;
    const running = await pool.query(
      "select 1 from sync_jobs where tenant_id=$1 and report_type=$2 and status='running' and started_at > now() - interval '10 minutes' limit 1",
      [tenantId, reportType]
    );
    if (running.rowCount) continue;
    if (syncQueue.isBusy(`${tenantId}:${reportType}`)) continue;
    // A report Amazon refuses on permission grounds gets a long wait rather
    // than the usual escalating one - see permissionRefusalWaitMs. It still
    // retries on its own, so a seller who gets the role granted has their data
    // appear without knowing to come back and press anything.
    //
    // Not a hardcoded list of "paused" report types, deliberately: that is
    // what the frontend has, and it needs a human to remember to edit it when
    // Amazon grants a role. This reads the last attempt's own error, so it
    // resumes on its own - which is exactly what the GST rows need.
    const refusalWaitMs = await permissionRefusalWaitMs(tenantId, reportType);
    if (refusalWaitMs > 0) {
      console.log(`[sync ${tenantId.slice(0, 8)}:${reportType}] skipped - Amazon refused this on permissions; retrying automatically in ${Math.ceil(refusalWaitMs / 60000)} min, or use Sync now if the role has just been granted`);
      continue;
    }
    const backoffMs = await autoSyncBackoffRemainingMs(tenantId, reportType);
    if (backoffMs > 0) {
      console.log(`[sync ${tenantId.slice(0, 8)}:${reportType}] skipped - backing off after repeated failures, next auto-retry in ${Math.ceil(backoffMs / 60000)} min`);
      continue;
    }
    missing.push(reportType);
  }
  return missing;
}
// One run per tenant+report type per process, no matter how many requests ask
// for it. Callers join the run already talking to Amazon instead of starting a
// second one, which is what the sync_jobs check alone cannot guarantee.
const syncQueue = createSyncQueue();
function runExclusiveSync(tenantId, reportType, start) {
  return syncQueue.run({ resourceKey: `${tenantId}:${reportType}`, start });
}
function triggerBackgroundSync(tenantId, reportType, range) {
  const task = runExclusiveSync(tenantId, reportType, () => reportType === 'DIRECT_SP_API_SYNC'
    ? syncRecentApiDataForTenant(tenantId, { range, maxOrderPages: 2, maxOrderItems: 20 })
    : syncReportForSellerRequest({ tenantId, reportType }, range));
  task.catch(error => app.log.warn({ err: error, tenantId, reportType }, 'Automatic background sync failed'));
}


async function syncReportForSellerRequest(params, range) {
  const reusable = await findReusableSync(params.tenantId, params.reportType, range);
  if (reusable) {
    const secondsAgo = Math.max(0, Math.round((Date.now() - new Date(reusable.completed_at).getTime()) / 1000));
    return { reportType: params.reportType, status: 'completed', reused: true, message: `Already synced this range ${secondsAgo}s ago; reusing that data instead of calling Amazon again.` };
  }
  if (params.reportType === 'DIRECT_SP_API_SYNC') {
    try {
      const result = await syncRecentApiDataForTenant(params.tenantId, { range, maxOrderPages: 2, maxOrderItems: 20 });
      return { reportType: params.reportType, status: 'completed', ...result };
    } catch (error) {
      // This is the base data layer, so there is no further fallback to try —
      // but a failure here must still come back as a clean JSON result
      // instead of an uncaught 500, so the sync ledger shows the real reason
      // rather than a generic "Internal server error".
      return { reportType: params.reportType, status: 'failed', error: error instanceof Error ? error.message : 'Direct API sync failed' };
    }
  }
  const directFirstReports = new Set(['GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', 'GET_FBA_REIMBURSEMENTS_DATA']);
  if (directFirstReports.has(params.reportType)) {
    const familyOptions = params.reportType === 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'
      ? { includeOrders: false, includeFinance: false, includeInventory: true }
      : { includeOrders: false, includeFinance: true, includeInventory: false };
    try {
      const fallback = await syncRecentApiDataForTenant(params.tenantId, { range, ...familyOptions });
      await recordSyntheticReportSync(params.tenantId, params.reportType, undefined, null, range);
      return { reportType: params.reportType, status: 'completed', fallback: 'DIRECT_SP_API_SYNC', ...fallback };
    } catch {
      // The fast direct-API path threw (transient error, missing token
      // scope, a DB hiccup, etc.) instead of returning a warning like it
      // does for its own internal Orders/Finance/Inventory calls. Previously
      // that uncaught error crashed the whole request as a raw 500 ("Internal
      // server error") and the report was never tried through Amazon's own
      // Reports API at all. Fall through to that real SP-API report instead
      // of failing outright — it already has its own direct-API fallback
      // below if it also can't produce data.
    }
  }
  try {
    const result = await syncReportForTenant({ ...params, range });
    return { reportType: params.reportType, status: 'completed', ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Report sync failed';
    if (params.reportType === 'GET_GST_MTR_B2B_CUSTOM' || params.reportType === 'GET_GST_MTR_B2C_CUSTOM') {
      const invoiceType = params.reportType === 'GET_GST_MTR_B2B_CUSTOM' ? 'b2b' : 'b2c';
      const rowsImported = await buildGstInvoicesFromOrderItems(params.tenantId, invoiceType).catch(() => 0);
      // Nothing was saved: Amazon refused the report AND the order-items
      // estimate produced nothing either. Recording a synthetic 'completed'
      // row here was a real, costly lie - observed live, where a seller saw a
      // green COMPLETED pill next to Amazon's own 403 saying the Tax Invoicing
      // role was missing, and reasonably concluded the sync had worked and the
      // data simply did not exist. It also suppressed the fix: a 'completed'
      // row makes findMissingReportTypes consider this range covered, so the
      // automatic sync would not retry the real report even after the seller
      // re-authorized and it would have succeeded.
      //
      // syncReportForTenant already wrote the honest 'failed' row with this
      // message before throwing, so returning failed here simply leaves it
      // standing. Exactly the rule the settlement branch below already
      // follows, and this is the same mistake it was written to avoid.
      if (rowsImported === 0) {
        return { reportType: params.reportType, status: 'failed', error: message };
      }
      // The estimate did produce rows, so there is real (if lower-fidelity)
      // data to show. That is a genuine partial success, and the warning
      // travels with it so the ledger says where the numbers came from.
      await recordSyntheticReportSync(params.tenantId, params.reportType, 'fallback://order-items-gst-estimate', message, range);
      return { reportType: params.reportType, status: 'completed', fallback: 'ORDER_ITEMS_GST_ESTIMATE', rowsImported, warning: message };
    }
    // Amazon generates the settlement report on its own payout schedule, so
    // "no completed report yet for this range" is a routine, expected state
    // (not an outage) - try the direct-API data as a substitute rather than
    // failing outright, and it is fair to call that 'completed' since
    // retrying the real report immediately would not produce a different
    // answer anyway.
    //
    // A rate-limit exhaustion or network error is a different situation
    // entirely: the real report *exists* and would very likely succeed on a
    // later attempt, but confirmed live (a Settlement Reset & Resync run
    // that hit "429" six times in a row on one document) - silently
    // recording this as 'completed' via the same synthetic-success row
    // blocks the hourly auto-sync coverage check from ever retrying the
    // real report, permanently settling for the lower-fidelity Finance-API
    // substitute while showing a plain green "COMPLETED" pill. Only the
    // "not generated yet" case gets the quiet substitution; a transient
    // failure of a report that actually exists must keep the honest
    // 'failed' row syncReportForTenant already wrote above, still try the
    // substitute so *something* is available in the meantime, but not
    // paper over the failure with a fake completed status.
    const directFallbackReports = new Set(['GET_SALES_AND_TRAFFIC_REPORT', 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', 'GET_FBA_REIMBURSEMENTS_DATA', 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2']);
    if (directFallbackReports.has(params.reportType)) {
      const reportGenuinelyNotAvailableYet = /no completed .* report is available/i.test(message);
      try {
        const fallback = await syncRecentApiDataForTenant(params.tenantId, { range });
        if (!reportGenuinelyNotAvailableYet) {
          return { reportType: params.reportType, status: 'failed', error: message, fallback: 'DIRECT_SP_API_SYNC', ...fallback };
        }
        await recordSyntheticReportSync(params.tenantId, params.reportType, 'fallback://direct-sp-api', message, range);
        return { reportType: params.reportType, status: 'completed', fallback: 'DIRECT_SP_API_SYNC', warning: message, ...fallback };
      } catch (fallbackError) {
        // Both the real Amazon report AND the direct-API fallback failed.
        // syncReportForTenant already wrote the real 'failed' sync_jobs row
        // with `message` above - do not paper over it with a fake
        // 'completed' row here, or the sync ledger (and every dashboard
        // number that depends on this report) silently lies about data that
        // was never actually saved.
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : 'Direct API fallback failed';
        return { reportType: params.reportType, status: 'failed', error: `${message} — fallback also failed: ${fallbackMessage}` };
      }
    }
    if (params.reportType === 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA' && /cancelled|no data|403|fatal/i.test(message)) {
      // "No returns in this period" is a real, correct, empty answer and
      // deserves a green pill. A 403 is not that - it means this app was never
      // allowed to ask, which is a permission problem with a fix, and calling
      // it completed hides both the problem and the fix. Same distinction the
      // GST branch above now makes.
      if (isPermissionRefusal(message)) {
        return { reportType: params.reportType, status: 'failed', error: message };
      }
      await recordSyntheticReportSync(params.tenantId, params.reportType, 'fallback://returns-report-unavailable', message, range);
      return { reportType: params.reportType, status: 'completed', fallback: 'RETURNS_REPORT_UNAVAILABLE', rowsImported: 0, warning: message };
    }
    return { reportType: params.reportType, status: 'failed', error: message };
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

// calculationRevision here, not just in a tenant's own diagnostics, exists
// specifically so "is the running process actually the build I just pulled"
// is a single unauthenticated request away - no login, no tenant id, no
// dashboard drill-down needed. Chasing a figure the dashboard showed but no
// committed build reproduced cost a full round trip once (see
// CALCULATION_REVISION's own comment); this makes that check the first
// thing anyone reaches for instead of the last.
app.get('/health', async () => ({ ok: true, calculationRevision: CALCULATION_REVISION }));

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

// Where the browser goes when Amazon sends the seller back. Every exit from
// the callback goes through here, so the tab always lands somewhere real.
const sellerLanding = (tenantId, params) =>
  `${secrets.frontendOrigin}/seller?${new URLSearchParams({ ...(tenantId ? { tenantId } : {}), ...params })}`;

// Amazon's redirect is a plain top-level browser navigation: whatever this
// request answers with IS what the seller sees. So it must always answer, and
// it must always answer with a redirect. Two things used to break that:
// an unhandled throw (a missing tenant, a database hiccup) rendered a raw JSON
// error in a blank tab, and anything that never settled left the tab spinning
// with nothing to click. The wrapper below turns both into a landing page that
// says what happened.
function amazonCallbackFailure(reply, tenantId, error) {
  const message = error instanceof Error ? error.message : String(error ?? 'Amazon authorization failed');
  if (!tenantId) return reply.redirect(`${secrets.frontendOrigin}/login?amazon=error&message=${encodeURIComponent(message)}`);
  return reply.redirect(sellerLanding(tenantId, { amazon: 'error', message }));
}

async function handleAmazonCallback(request, reply) {
  // Parsed before the try so a tenant is available to redirect to even when the
  // work below fails; a bad state is its own, separate landing.
  let tenantIdForFailure = null;
  try {
    return await runAmazonCallback(request, reply, id => { tenantIdForFailure = id; });
  } catch (error) {
    request.log.error({ err: error, tenantId: tenantIdForFailure }, 'Amazon authorization callback failed');
    return amazonCallbackFailure(reply, tenantIdForFailure, error);
  }
}

async function runAmazonCallback(request, reply, rememberTenant) {
  const query = AmazonCallbackSchema.parse({ ...(request.body && typeof request.body === 'object' ? request.body : {}), ...request.query });
  let state;
  try { state = verifyAmazonState(query.state ?? query.amazon_state); }
  catch (error) {
    return reply.redirect(`${secrets.frontendOrigin}/login?amazon=error&message=${encodeURIComponent(error instanceof Error ? error.message : 'Invalid Amazon authorization state')}`);
  }
  rememberTenant(state.tenantId);
  if (query.error) return reply.redirect(sellerLanding(state.tenantId, { amazon: 'error', message: query.error_description ?? query.error }));
  const code = query.spapi_oauth_code ?? query.code;
  if (!code) return reply.redirect(sellerLanding(state.tenantId, { amazon: 'error', message: 'Missing authorization code from Amazon' }));
  const tenant = (await pool.query('select id, company_name, default_marketplace_id from tenants where id=$1', [state.tenantId])).rows[0];
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });
  const body = await exchangeAmazonCode(code, validateAmazonRedirectUrl(query.redirect_uri ?? amazonCallbackUrl(request)));

  const marketplace = tenant.default_marketplace_id ?? 'A21TJRUUN4KGV';
  const sellerId = query.selling_partner_id ?? `SELLER-${state.tenantId}`;
  const sellerName = tenant.company_name;
  // Diagnostic only, never the raw secret: a one-way fingerprint of whichever
  // refresh token was already stored for this seller, if any, so the log can
  // say for certain whether THIS authorization actually replaced it with a
  // different one from Amazon - rather than leaving that as a guess when a
  // newly-granted role still doesn't seem to take effect after re-authorizing.
  const priorTokenRow = (await pool.query('select refresh_token_encrypted from sellers where tenant_id=$1 and amazon_seller_id=$2', [state.tenantId, sellerId])).rows[0];
  const fingerprint = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
  const priorFingerprint = priorTokenRow ? fingerprint(decryptSecret(priorTokenRow.refresh_token_encrypted)) : null;
  const newFingerprint = fingerprint(body.refresh_token);
  app.log.info({ tenantId: state.tenantId, sellerId, priorFingerprint, newFingerprint, tokenChanged: priorFingerprint === null ? 'first-authorization' : priorFingerprint !== newFingerprint }, 'Amazon OAuth callback - refresh token fingerprint');

  const client = await pool.connect();
  try {
    await client.query('begin');
    // first_authorized_at is deliberately NOT in the ON CONFLICT DO UPDATE SET
    // list below - Postgres then leaves whatever value is already there
    // untouched on every future reconnect, so it only ever gets written once,
    // on the true first authorization. connected_at, right next to it, is the
    // opposite on purpose (reset to now() on every reconnect, since that's
    // genuinely "most recently connected" and other queries rely on it to
    // pick the current active seller row) - conflating the two is exactly
    // what caused data_floor_date to drift later on every reconnect before
    // this column existed (see 022_seller_first_authorized_at.sql).
    await client.query(`insert into sellers(tenant_id, amazon_seller_id, seller_name, marketplace_id, seller_central_region, refresh_token_encrypted, auth_status, connected_at, last_token_refresh_at, first_authorized_at)
      values($1,$2,$3,$4,$5,$6,'authorized',now(),now(),now())
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
  return reply.redirect(sellerLanding(state.tenantId, { connected: '1', auth: 'complete' }));
}

// Amazon sends the seller back with a GET. That used to be served only by
// falling through to the not-found handler further down this file - it worked,
// but the single most important request in the product depended on a 404 path,
// and any future change to that handler would have silently broken sign-up.
// Both methods and both URLs are registered explicitly instead. The not-found
// fallback stays as a safety net for a redirect URI registered with a
// different path shape.
for (const url of ['/oauth/callback', '/api/auth/amazon/callback']) {
  app.route({ method: ['GET', 'POST'], url, handler: handleAmazonCallback });
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

// The frontend's Settings > Amazon panel has called this since it was
// built, but the route itself was never added - Disconnect has been a dead
// 404 the whole time. auth_status flips to 'revoked' (not deleted - the
// refresh token is left in place so a straight re-authorize below can
// overwrite it, and disconnected_at is cleared automatically by the OAuth
// callback's upsert on reconnect) so every "where auth_status='authorized'"
// query elsewhere in the app - dashboard, sync, access-token - stops
// treating this seller as connected without touching any already-synced
// data.
app.post('/api/tenants/:tenantId/amazon/disconnect', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  await requireTenantUser(request, tenantId);
  await assertActiveTenant(tenantId);
  const result = await pool.query(
    "update sellers set auth_status='revoked', disconnected_at=now() where tenant_id=$1 and auth_status='authorized' returning id",
    [tenantId]
  );
  if (!result.rowCount) throw Object.assign(new Error('Amazon seller is not connected'), { statusCode: 404 });
  return { disconnected: true };
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

// Also doubles as "Activate" for a suspended tenant - granting and
// reactivating are the same state transition (-> active, approved_at=now()),
// so a suspended seller revoked by mistake is one click from working again.
app.post('/api/admin/tenants/:tenantId/grant-access', async request => { await requireAdmin(request); const { tenantId } = TenantParamsSchema.parse(request.params); return (await pool.query("update tenants set status='active', approved_at=now(), approved_by_admin_id=$2 where id=$1 returning id,status,approved_at", [tenantId, adminId])).rows[0]; });
app.post('/api/admin/tenants/:tenantId/reject', async request => { await requireAdmin(request); const { tenantId } = TenantParamsSchema.parse(request.params); return (await pool.query("update tenants set status='suspended' where id=$1 returning id,status", [tenantId])).rows[0]; });
app.post('/api/admin/tenants/:tenantId/revoke-access', async request => { await requireAdmin(request); const { tenantId } = TenantParamsSchema.parse(request.params); return (await pool.query("update tenants set status='suspended' where id=$1 returning id,status", [tenantId])).rows[0]; });
// Permanently removes the tenant and, via ON DELETE CASCADE (see
// 001_init.sql), every row that hangs off it - users, sellers, sync_jobs,
// orders, settlement_rows, and every other fact table. Irreversible, so it's
// deliberately refused for an 'active' tenant even if a stale UI or a direct
// API call tries it: the seller must be revoked (suspended) first. That
// mirrors the two-step flow in the admin UI (Revoke, then Delete or
// Activate) and means a live, in-use account can never be deleted in one
// accidental click.
app.delete('/api/admin/tenants/:tenantId', async request => {
  await requireAdmin(request);
  const { tenantId } = TenantParamsSchema.parse(request.params);
  const tenant = (await pool.query('select status from tenants where id=$1', [tenantId])).rows[0];
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { statusCode: 404 });
  if (tenant.status === 'active') throw Object.assign(new Error('Revoke this seller before deleting - active accounts cannot be deleted directly'), { statusCode: 409 });
  await pool.query('delete from tenants where id=$1', [tenantId]);
  return { deleted: true, id: tenantId };
});
app.post('/api/admin/tenants/:tenantId/sync/:reportType', async request => { await requireAdmin(request); return syncReportForTenant(SyncParamsSchema.parse(request.params)); });

app.post('/api/tenants/:tenantId/sync/:reportType', async request => {
  const params = SellerSyncParamsSchema.parse(request.params);
  const body = z.object({ range: DateRangeSchema.optional() }).parse(request.body ?? {});
  await requireTenantUser(request, params.tenantId);
  await assertActiveTenant(params.tenantId);
  await assertNoBackfillRunning(params.tenantId, 'Manual sync');

  // Starts the sync and answers immediately. It used to await the whole
  // Amazon round trip inside this request, which cannot work: creating a
  // report and polling it to DONE is up to 20 polls at 15s (five minutes)
  // before the document download even begins, and that download is paced by
  // Amazon's own rate limit - observed live at 45 seconds per request with
  // 37-second waits. No browser holds a fetch open that long, so a seller
  // clicking Sync got "Failed to fetch" while the server was still working
  // perfectly well, and the report they were told had failed then quietly
  // succeeded with nothing on screen to say so.
  //
  // runExclusiveSync is the same guard the automatic path uses, so a second
  // click while one is running joins rather than starting a duplicate. The
  // real outcome lands in sync_jobs, which is where the ledger reads status
  // from anyway - the next dashboard poll shows it.
  const task = runExclusiveSync(params.tenantId, params.reportType, () => syncReportForSellerRequest(params, body.range));
  task.catch(error => app.log.warn({ err: error, tenantId: params.tenantId, reportType: params.reportType }, 'Manual sync failed'));
  return { reportType: params.reportType, status: 'started', message: 'Amazon is preparing this report. The ledger updates on its own when it finishes - you can leave this page.' };
});

app.post('/api/tenants/:tenantId/sync', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  await requireTenantUser(request, tenantId);
  await assertActiveTenant(tenantId);
  await assertNoBackfillRunning(tenantId, 'Manual sync');
  const body = SellerSyncSchema.parse(request.body ?? {});
  const results = [];
  // This route called Amazon unconditionally: no reuse check, no in-flight
  // check. Every click, retry or duplicate request started another full sync
  // of the same range on top of the ones already running. A seller's SP-API
  // quota is account-wide, so that is a real risk to them, not just wasted
  // work. An explicit sync still bypasses the freshness window - the seller
  // asked for fresh data - but it can no longer stack concurrent runs.
  try {
    const result = await runExclusiveSync(tenantId, 'DIRECT_SP_API_SYNC', () => syncRecentApiDataForTenant(tenantId, { range: body.range, maxOrderPages: 2, maxOrderItems: 20 }));
    results.push({ reportType: 'DIRECT_SP_API_SYNC', status: 'completed', ...result });
  } catch (error) {
    results.push({ reportType: 'DIRECT_SP_API_SYNC', status: 'failed', error: error instanceof Error ? error.message : 'unknown error' });
  }
  for (const reportType of body.reportTypes) {
    results.push(await runExclusiveSync(tenantId, reportType, () => syncReportForSellerRequest({ tenantId, reportType }, body.range)));
  }
  return { results };
});

// Report types where a human downloading directly from Seller Central
// produces the exact same flat-file format Amazon's own API returns, so the
// same parser/save path (saveStructuredRows) can be trusted on it without a
// separate parser being written and unverified against real files:
//  - Settlement, GST B2B/B2C, FBA Returns, FBA Reimbursements are all TSV
//    documents Amazon generates identically regardless of whether a human
//    or the API requested them.
// Deliberately excludes two report types that WOULD be wrong here:
//  - GET_SALES_AND_TRAFFIC_REPORT: Seller Central's manual "Business
//    Reports" export is a different CSV shape than the API's JSON payload -
//    assuming they match without ever having verified a real exported file
//    risks silently storing wrong numbers, which is worse than not
//    supporting upload for it at all.
//  - GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA: inventory is a point-in-time
//    snapshot, not a time series - saveInventorySnapshots always dates a
//    snapshot "today" (see snapshotDate in sync.js), so uploading an old
//    inventory file would silently mislabel stale stock levels as current.
//    There is nothing correct this upload could backfill.
const UPLOADABLE_REPORT_TYPES = new Set([
  'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
  'GET_GST_MTR_B2B_CUSTOM',
  'GET_GST_MTR_B2C_CUSTOM',
  'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
  'GET_FBA_REIMBURSEMENTS_DATA'
]);
const ReportUploadSchema = z.object({ content: z.string().min(1), range: DateRangeSchema });
// The only route in the app that ingests report data without ever calling
// Amazon - for the handful of report types Seller Central lets a person
// download much further back than SP-API's 90-day retention allows an app
// to fetch automatically (see UPLOADABLE_REPORT_TYPES above). Reuses
// saveStructuredRows, the exact function every API-driven sync already
// calls to turn report content into rows - so an uploaded settlement file
// gets the same balance-to-the-paisa check (assertSettlementsBalance) as
// one Amazon's API handed over directly, and every other correctness rule
// already built into this pipeline applies unchanged. The caller supplies
// the range being uploaded (what period this file covers) rather than the
// server trying to infer it from row contents, which is unambiguous and
// matches exactly how every other sync_jobs row already records its range.
app.post('/api/tenants/:tenantId/reports/:reportType/upload', async request => {
  const { tenantId, reportType } = SellerSyncParamsSchema.parse(request.params);
  await requireTenantUser(request, tenantId);
  await assertActiveTenant(tenantId);
  if (!UPLOADABLE_REPORT_TYPES.has(reportType)) {
    throw Object.assign(new Error(`${reportType} does not support manual upload - either its Seller Central export format is unverified against this app's parser, or the report type has no meaningful historical range to upload.`), { statusCode: 400 });
  }
  const body = ReportUploadSchema.parse(request.body);
  const rowsImported = await saveStructuredRows(tenantId, reportType, body.content, null);
  await pool.query(
    `insert into sync_jobs(tenant_id, report_type, status, started_at, completed_at, range_start, range_end, source)
     values($1,$2,'completed',now(),now(),$3,$4,'manual_upload')`,
    [tenantId, reportType, body.range.start, body.range.end]
  );
  // Real data reaching further back than the recorded floor means the floor
  // was wrong, not that this upload should be clamped to it - same LEAST
  // reasoning as 022_seller_first_authorized_at.sql, just applied live
  // instead of as a one-time migration. Never moves the floor later, only
  // ever earlier or from null to a real date. calendarDay converts the
  // instant to its IST calendar day first, the same correction
  // reporting-calendar.js already applies everywhere else a DATE column is
  // compared - casting the raw UTC ISO string straight to ::date instead
  // silently shifts a day near midnight IST, confirmed elsewhere in this
  // codebase (see that file's own comment for the verified repro).
  await pool.query(
    "update sellers set data_floor_date = least(coalesce(data_floor_date, $2::date), $2::date) where tenant_id=$1 and auth_status='authorized'",
    [tenantId, calendarDay(body.range.start)]
  );
  return { reportType, status: 'completed', source: 'manual_upload', rowsImported };
});

// A tenant that was actively re-synced during this session's earlier bugs
// (before document-level dedup and a stable source_key formula both landed)
// can be left with genuine duplicate-content settlement_rows: two rows that
// differ only by source_key, because the same Amazon document got parsed
// under two different versions of that formula. Settlement documents are
// immutable on Amazon's side, so the only way to get a provably correct,
// duplicate-free dataset - instead of guessing which of two identical-
// looking rows is real - is to delete the stored rows for the affected
// range and re-fetch them from scratch under the pipeline as it stands
// today. processed_report_documents is cleared for the whole tenant+report
// type (not just this range) because it is purely a re-download-avoidance
// cache with no date columns of its own; clearing it never loses data - it
// just means the next sync for any other period re-examines documents it
// had already skipped, safely upserting the exact same rows back in place.
//
// The delete happens before the re-fetch, which means a re-fetch that fails
// leaves the tenant with *less* data than it started with. That is not
// hypothetical: a Reset & Resync run hit "429" six times on a single document
// and gave up after 248s, so the rows were deleted and nothing came back. A
// reconciliation tool losing a seller's ledger because Amazon was busy is the
// worst possible outcome, so the deleted rows are kept in memory for the
// duration of the re-fetch and put back if it does not fully succeed. They go
// back with `on conflict do nothing`, so any row the re-fetch *did* bring
// down stays the authoritative copy and only genuine gaps are refilled.
const SETTLEMENT_REPORT_TYPE = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2';
// A fixed cooldown, not the exponential failure-count backoff used for
// missing-report auto-sync (autoSyncBackoffRemainingMs): that helper counts
// CONSECUTIVE FAILED jobs, but a corrupt settlement is recorded as a
// successful sync - it downloaded fine, the numbers are just wrong - so a
// failure-based check would see zero failures and retrigger on every single
// dashboard request. This checks the most recent attempt regardless of
// its outcome, so a Reset & Resync that raced Amazon's rate limit gets a
// real gap before the next automatic attempt instead of being restarted
// every few seconds while a seller's tab sits open.
const SETTLEMENT_AUTOHEAL_COOLDOWN_MS = 15 * 60 * 1000;
async function settlementAutoHealOnCooldown(tenantId) {
  const { rows } = await pool.query(
    `select coalesce(completed_at, started_at) as at_time from sync_jobs
     where tenant_id=$1 and report_type=$2 order by coalesce(completed_at, started_at) desc limit 1`,
    [tenantId, SETTLEMENT_REPORT_TYPE]
  );
  const at = rows[0]?.at_time;
  return Boolean(at) && Date.now() - new Date(at).getTime() < SETTLEMENT_AUTOHEAL_COOLDOWN_MS;
}
async function restoreSettlementRows(tenantId, rows) {
  const statements = buildRestoreStatements(rows);
  if (!statements.length) return 0;
  return withTenant(tenantId, async client => {
    let restored = 0;
    for (const statement of statements) {
      const result = await client.query(statement.text, statement.values);
      restored += result.rowCount ?? 0;
    }
    return restored;
  });
}
async function resetSettlementData(tenantId, range) {
  return syncQueue.run({
    resourceKey: `${tenantId}:${SETTLEMENT_REPORT_TYPE}`,
    dedupeKey: `${tenantId}:reset:${SETTLEMENT_REPORT_TYPE}:${range.start}:${range.end}`,
    queue: true,
    start: () => runSettlementReset(tenantId, range)
  });
}
async function runSettlementReset(tenantId, range) {
  const { counts, snapshot } = await withTenant(tenantId, async client => {
    // One transaction: a reader that arrives mid-reset must not see the rows
    // half-gone, and a failure partway through must not leave the sync ledger
    // cleared while the rows it describes are still present.
    await client.query('begin');
    try {
      const deletedRows = await client.query('delete from settlement_rows where tenant_id=$1 and posted_date >= $2 and posted_date < $3 returning *', [tenantId, range.start, range.end]);
      const deletedDocs = await client.query("delete from processed_report_documents where tenant_id=$1 and report_type=$2", [tenantId, SETTLEMENT_REPORT_TYPE]);
      const deletedJobs = await client.query("delete from sync_jobs where tenant_id=$1 and report_type=$2 and range_start <= $4 and range_end >= $3", [tenantId, SETTLEMENT_REPORT_TYPE, range.start, range.end]);
      await client.query('commit');
      return {
        snapshot: deletedRows.rows,
        counts: { deletedSettlementRows: deletedRows.rowCount, deletedProcessedDocuments: deletedDocs.rowCount, deletedSyncJobs: deletedJobs.rowCount }
      };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    }
  });

  let resync;
  try {
    resync = await syncReportForSellerRequest({ tenantId, reportType: SETTLEMENT_REPORT_TYPE }, range);
  } catch (error) {
    const restoredSettlementRows = await restoreSettlementRows(tenantId, snapshot);
    const message = error instanceof Error ? error.message : 'Settlement re-sync failed';
    console.error(`[reset ${tenantId.slice(0, 8)}] re-sync threw after deleting ${snapshot.length} row(s); restored ${restoredSettlementRows} of them: ${message}`);
    throw Object.assign(new Error(`Settlement re-sync failed, so the ${snapshot.length} deleted row(s) were put back (${restoredSettlementRows} restored) - your data is as it was before the reset. Amazon reported: ${message}`), { statusCode: 502 });
  }

  const outstandingDocuments = Number(resync?.outstandingDocuments ?? 0);
  const incomplete = resync?.status === 'failed' || outstandingDocuments > 0;
  if (!incomplete) return { ...counts, restoredSettlementRows: 0, resync };

  const restoredSettlementRows = await restoreSettlementRows(tenantId, snapshot);
  const reason = resync?.status === 'failed'
    ? `the re-sync failed (${resync.error ?? 'no reason reported'})`
    : `${outstandingDocuments} settlement document(s) could not be fetched`;
  const warning = `Reset incomplete: ${reason}. ${restoredSettlementRows} of the ${snapshot.length} deleted row(s) were restored so no ledger data was lost - run the reset again once Amazon's rate limit clears.`;
  console.warn(`[reset ${tenantId.slice(0, 8)}] ${warning}`);
  return { ...counts, restoredSettlementRows, warning, resync };
}

app.post('/api/tenants/:tenantId/settlement-data/reset', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  const body = z.object({ range: DateRangeSchema, confirm: z.literal(true, { errorMap: () => ({ message: 'This deletes stored settlement rows for the given range before re-fetching them from Amazon - pass confirm: true to proceed.' }) }) }).parse(request.body ?? {});
  await requireTenantUser(request, tenantId);
  await assertActiveTenant(tenantId);
  await assertNoBackfillRunning(tenantId, 'Settlement reset');
  app.log.warn({ tenantId, range: body.range }, 'Settlement data reset requested: deleting stored settlement rows for this range and re-syncing from Amazon');
  return resetSettlementData(tenantId, body.range);
});

// One settlement = one of Amazon's own statement periods, the same rows its
// "All Statements" page shows. The columns mirror that page exactly (Sales,
// Refunds, Expenses, Others, Payout) because a seller comparing the two
// should be comparing like with like, not translating between two different
// vocabularies for the same money. The bucketing itself lives in
// jobs/settlement-statements.js so it can be tested without standing up a
// server - see that module for why amount_type is read before the text
// classifiers.
const StatementRowsSchema = `select id source_row_id, settlement_id, order_id, sku, amount_type, amount_description, amount, posted_date, raw,
      coalesce(raw->>'transaction-type',raw->>'transaction type',raw->>'transactionType') parent_transaction_type
      from settlement_rows where tenant_id=$1 and settlement_id is not null and settlement_id <> ''`;

// Amazon's "All Statements" page, rebuilt from the settlement rows this tool
// already holds - so a seller can answer "this payout was 4,825.94, where did
// that come from" without downloading a flat file and adding columns by hand.
app.get('/api/tenants/:tenantId/statements', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  await requireTenantUser(request, tenantId); await assertActiveTenant(tenantId);
  return withTenant(tenantId, async db => {
    const { rows } = await db.query(StatementRowsSchema, [tenantId]);
    const bySettlement = new Map();
    for (const row of rows) {
      const list = bySettlement.get(row.settlement_id);
      if (list) list.push(row); else bySettlement.set(row.settlement_id, [row]);
    }
    const statements = [...bySettlement].map(([settlementId, settlementRows]) => {
      const period = statementPeriod(settlementRows);
      const totals = summariseStatementRows(settlementRows);
      return {
        settlement_id: settlementId, ...period, ...totals, lines: settlementRows.length,
        // Amazon stamps its own total on the document. Reporting ours beside
        // it, and whether they agree, is the difference between "here is a
        // number" and "here is a number Amazon confirms" - and it is how a
        // half-downloaded settlement announces itself instead of quietly
        // producing a wrong payout.
        matches_amazon: matchesAmazonTotal(totals.payout, period.amazon_total)
      };
    });
    statements.sort((a, b) => String(b.period_end ?? b.deposit_date ?? '').localeCompare(String(a.period_end ?? a.deposit_date ?? '')));
    return { statements };
  });
});

// The drill-down: every line behind one payout, grouped the way a seller
// would ask about it - first by section, then by Amazon's own label, and
// separately rolled up per order so "which orders made up this payout" is
// answerable without reading hundreds of raw rows.
app.get('/api/tenants/:tenantId/statements/:settlementId', async request => {
  const { tenantId, settlementId } = z.object({ tenantId: z.string().uuid(), settlementId: z.string().min(1) }).parse(request.params);
  await requireTenantUser(request, tenantId); await assertActiveTenant(tenantId);
  return withTenant(tenantId, async db => {
    const { rows } = await db.query(`${StatementRowsSchema} and settlement_id=$2 order by posted_date, id`, [tenantId, settlementId]);
    if (!rows.length) throw Object.assign(new Error('No settlement rows stored for that statement.'), { statusCode: 404 });
    const period = statementPeriod(rows);
    const totals = summariseStatementRows(rows);
    const groups = new Map();
    for (const row of rows) {
      const bucket = statementBucket(row);
      const label = `${row.amount_type ?? ''} ${row.amount_description ?? ''}`.trim() || '(no label)';
      const key = `${bucket}|${label}`;
      const current = groups.get(key) ?? { bucket, label, amount: 0, lines: 0 };
      current.amount += Number(row.amount ?? 0); current.lines += 1;
      groups.set(key, current);
    }
    const byOrder = new Map();
    for (const row of rows) {
      if (!row.order_id) continue;
      const current = byOrder.get(row.order_id) ?? { order_id: row.order_id, sales: 0, refunds: 0, expenses: 0, others: 0, net: 0, lines: 0 };
      const bucket = statementBucket(row);
      if (bucket !== 'transfer') { current[bucket] += Number(row.amount ?? 0); current.net += Number(row.amount ?? 0); }
      current.lines += 1;
      byOrder.set(row.order_id, current);
    }
    const orders = [...byOrder.values()].map(order => ({ ...order, sales: round2(order.sales), refunds: round2(order.refunds), expenses: round2(order.expenses), others: round2(order.others), net: round2(order.net) }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    return {
      settlement_id: settlementId, ...period, ...totals, lines: rows.length,
      matches_amazon: matchesAmazonTotal(totals.payout, period.amazon_total),
      groups: [...groups.values()].map(group => ({ ...group, amount: round2(group.amount) })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
      orders,
      // Rows with no order id - subscription, storage, advertising, transfers.
      // These are exactly the money a seller cannot find by looking at orders,
      // and the usual reason a payout is smaller than the order total.
      nonOrderLines: rows.filter(row => !row.order_id).length
    };
  });
});

const DASHBOARD_METRICS = ['netSales','netQty','orders','returns','settled','deductions','reimbursements','drr','feeImpact','returnRate','refundValueRate','gstValue','income','expenses','tax','transfers','gst'];
const CalculationParamsSchema = z.object({ tenantId: z.string().uuid(), metric: z.enum(DASHBOARD_METRICS) });
const OrderDetailParamsSchema = z.object({ tenantId: z.string().uuid(), orderId: z.string().min(1) });
const FEE_CATEGORIES = ['referral_commission', 'fulfillment_fee_per_order', 'fulfillment_fee_per_unit', 'fulfillment_fee_weight', 'shipping_fee', 'gift_wrap_fee', 'closing_fee', 'digital_services_fee', 'storage_fee', 'chargeback', 'tax'];
function requestedRange(query) { const parsed = DashboardQuerySchema.parse(query); return { start: parsed.start ?? new Date(Date.now() - 30 * 864e5).toISOString(), end: parsed.end ?? new Date().toISOString() }; }

function groupCalculationRows(rows) {
  const grouped = new Map();
  for (const row of rows) { const key = row.category; const current = grouped.get(key) ?? { category: key, label: key.replaceAll('_', ' '), amount: 0, count: 0 }; current.amount += Number(row.amount ?? 0); current.count += 1; grouped.set(key, current); }
  return [...grouped.values()];
}

// db is a single checked-out PoolClient (one physical connection, from
// withTenant), not the Pool itself - node-postgres processes queries on one
// connection strictly one at a time. Firing these nine queries concurrently
// via Promise.all on that same client is invalid usage that node-postgres
// only tolerates today by silently queuing them behind the scenes (hence
// the live "Calling client.query() when the client is already executing a
// query is deprecated and will be removed in pg@9.0" warning) - it buys no
// real parallelism over one connection anyway, so awaiting them in sequence
// is both spec-compliant and no slower.
async function loadDashboardCalculations(db, tenantId, range) {
  const orders = await db.query('select id source_row_id,amazon_order_id,status,order_date,total_amount,raw from orders where tenant_id=$1 and order_date >= $2 and order_date < $3',[tenantId,range.start,range.end]);
  const orderItems = await db.query(`select oi.id source_row_id,oi.amazon_order_id,oi.asin,oi.sku,oi.title,oi.quantity_ordered,oi.item_price,oi.promotion_discount,oi.raw,o.status,o.order_date from order_items oi join orders o on o.tenant_id=oi.tenant_id and o.amazon_order_id=oi.amazon_order_id where oi.tenant_id=$1 and o.order_date >= $2 and o.order_date < $3`,[tenantId,range.start,range.end]);
  const returns = await db.query('select id source_row_id,order_id,return_date,return_reason,disposition,status,quantity,raw from returns where tenant_id=$1 and return_date >= $2 and return_date < $3',[tenantId,...calendarDays(range)]);
  const settlementRows = await db.query(`select id source_row_id,settlement_id,order_id,amount_type,amount_description,amount,posted_date,raw,
      coalesce(raw->>'transaction-type',raw->>'transaction type',raw->>'transactionType') parent_transaction_type
      from settlement_rows where tenant_id=$1 and posted_date >= $2 and posted_date < $3`,[tenantId,range.start,range.end]);
  // In a V2 settlement flat file only the *first* line of a document is the
  // header: it carries deposit-date and total-amount and leaves the
  // transaction columns empty, while every following line repeats
  // settlement-id and settlement-start-date but not total-amount. Selecting
  // on "has a deposit-date OR a settlement-start-date" therefore returned
  // hundreds of non-header lines per document alongside the one real header,
  // and the caller then picked one row per settlement_id from an unordered
  // result - so which row won, and whether it had a total-amount at all, was
  // whatever Postgres happened to return that time. Reproduced against a
  // real Postgres with three documents (two deposited, one still open): the
  // old predicate returned 17 rows, and taking the first per settlement_id
  // resolved two of the three settlements to a detail line whose
  // total-amount was empty - scoring a genuine payout as 0.00. The new
  // predicate returns exactly the 2 real headers, and returns them
  // identically after the rows are physically moved on disk.
  //
  // Requiring a non-empty total-amount keeps only genuine headers; requiring
  // a deposit-date drops settlements Amazon has not paid out yet (they have
  // transferred nothing, so they belong in no statement's Transfers); and
  // the ORDER BY makes the choice reproducible instead of load-dependent.
  const settlementHeaders = await db.query(`select settlement_id,coalesce(raw->>'deposit-date',raw->>'deposit date',raw->>'depositDate') deposit_date,coalesce(raw->>'settlement-start-date',raw->>'settlement start date',raw->>'settlementStartDate') settlement_start_date,coalesce(raw->>'settlement-end-date',raw->>'settlement end date',raw->>'settlementEndDate') settlement_end_date,coalesce(nullif(raw->>'total-amount',''),nullif(raw->>'total amount',''),nullif(raw->>'totalAmount','')) total_amount,coalesce(raw->>'transaction-type',raw->>'transaction type') transaction_type,raw from settlement_rows where tenant_id=$1 and coalesce(nullif(raw->>'total-amount',''),nullif(raw->>'total amount',''),nullif(raw->>'totalAmount','')) is not null and coalesce(raw->>'deposit-date',raw->>'deposit date',raw->>'depositDate','')<>'' order by settlement_id,deposit_date,id`,[tenantId]);
  // order_id here is deliberately ft.related_order_id (the transaction-level
  // identifier, extracted by financeRelatedValue matching an exact
  // ORDER_ID/AMAZON_ORDER_ID identifier name), not fi.order_id. fi.order_id
  // is populated per line-item by flattenFinanceTransaction's looser /order/i
  // key-name scan and is null or inconsistent on many components - exactly
  // what the already-working Order Payments transaction ledger (below) also
  // avoids, using related_order_id for the same reason. Falling back to
  // fi.order_id only when related_order_id is unavailable keeps a value for
  // rows whose parent transaction genuinely lacks one.
// Amazon re-posts a deferred payment when it matures, so a payment posted in
// June appears again in July under a new transaction id. De-duplicating them
// requires seeing the original, which sits BEFORE the window being viewed - so
// finance rows are fetched with a lookback and narrowed to the range after
// de-duplication, never by this query.
//
// The size is set by how long Amazon actually defers. Observed on real accounts:
// a DD7 reason with maturity dates running up to about a month out. 60 days
// covers that with margin, and costs only rows that are discarded a moment
// later. Measured: an account with a full month of lookback reconciles to its
// statement exactly, while the same code on five days of lookback over-counts
// Income by 63,963.29 - the originals simply were not there to match against.
const FINANCE_LOOKBACK_DAYS = 60;

  const financeItems = await db.query(`select fi.id source_row_id,fi.transaction_id,coalesce(ft.related_order_id,fi.order_id) order_id,fi.sku,fi.asin,fi.category,fi.amount_description,fi.amount,fi.currency,fi.posted_date,fi.raw,
      ft.transaction_type parent_transaction_type,
      coalesce(ft.raw->>'transactionStatus',ft.raw->>'TransactionStatus') transaction_status,
      coalesce(ft.raw->>'accountType',ft.raw->>'AccountType',ft.raw#>>'{sellingPartnerMetadata,accountType}') account_type
      from finance_transaction_items fi left join finance_transactions ft on ft.tenant_id=fi.tenant_id and ft.transaction_id=fi.transaction_id
      where fi.tenant_id=$1 and fi.posted_date >= ($2::timestamptz - interval '${FINANCE_LOOKBACK_DAYS} days') and fi.posted_date < $3`,[tenantId,range.start,range.end]);
  const financeTransactions = await db.query('select transaction_id,transaction_type,posted_date,total_amount,currency,related_order_id,raw from finance_transactions where tenant_id=$1 and posted_date >= $2 and posted_date < $3',[tenantId,range.start,range.end]);
  // Deliberately NOT range-filtered. "Has this order ever been settled?" is a
  // property of the order, not of the selected window: an order's settlement
  // lines can post outside the range the user is looking at (a late-June order
  // settled in early July, a refund settled in the next cycle) while its
  // Finance API rows post inside it. Deriving the settled set from the
  // in-range settlement rows alone therefore reports "never settled" for
  // orders that plainly were, and the Deferred merge then adds their money on
  // top of settlement money that is already counted somewhere.
  const settledOrderIds = await db.query('select distinct order_id from settlement_rows where tenant_id=$1 and order_id is not null and order_id<>$2',[tenantId,'']);
  // Every Amazon settlement document states its own total, and the lines it
  // contains must add up to exactly that. So this is a complete, self-checking
  // proof that a settlement was ingested without losing or duplicating a
  // single row - no statement PDF, no date range, no comparison against
  // anything external. If a settlement does not foot, its lines are wrong and
  // every figure derived from them is wrong, silently.
  //
  // Deliberately NOT range-filtered: a settlement's lines span its own period,
  // not whatever window the seller happens to be looking at, so checking only
  // the in-range subset would report a shortfall on every settlement that
  // straddles the edge of the view.
  // Settlement syncs that fetched only part of what Amazon has. While any of
  // these exist the money figures are computed from an incomplete settlement
  // history, and the seller must be told rather than shown a confident wrong
  // number. This is what distinguishes "Amazon has not settled it yet" from
  // "we have not downloaded it yet" - the two look identical in the totals.
  const outstandingSettlementSyncs = await db.query(
    `select count(*)::int pending from sync_jobs
      where tenant_id=$1 and report_type='GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'
        and status='completed' and error_message like 'Partial:%'
        and completed_at > now() - interval '7 days'`,
    [tenantId]
  ).catch(() => ({ rows: [{ pending: 0 }] }));
  const settlementIntegrity = await db.query(
    `select settlement_id,
            count(*) row_count,
            round(sum(amount)::numeric, 2) rows_total,
            round(max(coalesce(nullif(raw->>'total-amount',''), nullif(raw->>'total amount',''), nullif(raw->>'totalAmount',''))::numeric), 2) header_total
       from settlement_rows
      where tenant_id=$1 and settlement_id is not null and settlement_id <> ''
      group by settlement_id
     having max(coalesce(nullif(raw->>'total-amount',''), nullif(raw->>'total amount',''), nullif(raw->>'totalAmount',''))::numeric) is not null
        and abs(sum(amount) - max(coalesce(nullif(raw->>'total-amount',''), nullif(raw->>'total amount',''), nullif(raw->>'totalAmount',''))::numeric)) > 0.01
      order by abs(sum(amount) - max(coalesce(nullif(raw->>'total-amount',''), nullif(raw->>'total amount',''), nullif(raw->>'totalAmount',''))::numeric)) desc`,
    [tenantId]
  ).catch(error => { app.log.warn({ err: error, tenantId }, 'Settlement integrity check failed'); return { rows: [] }; });
  const reimbursements = await db.query('select amount,reason,sku,reimbursement_date from reimbursements where tenant_id=$1 and reimbursement_date >= $2 and reimbursement_date < $3',[tenantId,...calendarDays(range)]);
  const gstInvoices = await db.query('select id source_row_id,invoice_type,order_id,cgst,sgst,igst,taxable_value,invoice_date,raw from gst_invoices where tenant_id=$1 and invoice_date >= $2 and invoice_date < $3',[tenantId,...calendarDays(range)]);
  const result=calculateDashboardMetrics({orders:orders.rows,orderItems:orderItems.rows,returns:returns.rows,settlementRows:settlementRows.rows,settlementHeaders:settlementHeaders.rows,financeItems:financeItems.rows,financeTransactions:financeTransactions.rows,reimbursements:reimbursements.rows,gstInvoices:gstInvoices.rows,settledOrderIdsAllTime:settledOrderIds.rows.map(row=>row.order_id),settlementIntegrity:settlementIntegrity.rows,outstandingSettlementSyncs:Number(outstandingSettlementSyncs.rows[0]?.pending ?? 0)},range);
  return result;
}

app.get('/api/tenants/:tenantId/calculations/:metric', async request => {
  const {tenantId,metric}=CalculationParamsSchema.parse(request.params); const range=requestedRange(request.query);
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
  const range = DashboardQuerySchema.parse(request.query);
  const start = range.start ? new Date(range.start) : new Date(Date.now() - 30 * 864e5);
  const end = range.end ? new Date(range.end) : new Date();
  // A backfill whose process is gone must not block this tenant forever.
  // backfill_status='running' hides every page in the app, and nothing except
  // the backfill's own completion ever cleared it - so a redeploy, a restart
  // or a crash mid-backfill left the seller staring at a progress screen that
  // could never advance, with the app telling them to refresh a page that no
  // amount of refreshing could help. Confirmed live: a seller was locked out
  // for a full day this way.
  //
  // The heartbeat is what makes this decidable rather than a guess (see
  // 026_seller_backfill_heartbeat.sql): a real backfill can legitimately run a
  // long time, so elapsed time alone cannot separate "still working" from
  // "died an hour ago". A stale heartbeat can. The window is generous because
  // the cost of releasing too early - showing figures from a partial range -
  // is worse than waiting a bit longer.
  //
  // Same reasoning, and the same shape, as the sync_jobs timeout further down
  // this handler; this table simply never got it.
  await pool.query(
    `update sellers set backfill_status='failed'
      where tenant_id=$1 and backfill_status='running'
        and coalesce(backfill_heartbeat_at, backfill_started_at) < now() - interval '30 minutes'`,
    [tenantId]
  ).catch(error => app.log.warn({ err: normalizeDatabaseError(error), tenantId }, 'Stale backfill sweep skipped'));
  const sellerRow = (await pool.query(`select seller_name, amazon_seller_id, marketplace_id, auth_status, connected_at, last_token_refresh_at,
      backfill_status, backfill_started_at, backfill_completed_at, backfill_progress, data_floor_date from sellers
    where tenant_id=$1 and auth_status='authorized' order by connected_at desc limit 1`, [tenantId])).rows[0] ?? null;
  const backfillRunning = sellerRow?.backfill_status === 'running';
  const seller = sellerRow
    ? {
        connected: true, sellerName: sellerRow.seller_name, sellerId: sellerRow.amazon_seller_id, marketplaceId: sellerRow.marketplace_id, authStatus: sellerRow.auth_status, connectedAt: sellerRow.connected_at, lastTokenRefreshAt: sellerRow.last_token_refresh_at,
        // The one-time 90-day catch-up (see runInitialSellerBackfill). The
        // frontend blocks date-range selection and shows real per-source
        // progress from backfillProgress while status is 'running'.
        backfillStatus: sellerRow.backfill_status ?? 'completed', backfillStartedAt: sellerRow.backfill_started_at, backfillCompletedAt: sellerRow.backfill_completed_at, backfillProgress: sellerRow.backfill_progress ?? {},
        // Fixed permanently the first time the backfill ran (see
        // 020_seller_data_floor.sql) - the earliest date this tenant's data
        // will ever reach, so the picker can refuse a range Amazon can never
        // supply rather than let the seller pick one and get nothing back.
        // Null for a seller connected before this feature existed; the
        // frontend leaves the picker unrestricted in that case.
        dataFloorDate: sellerRow.data_floor_date
      }
    : { connected: false };
  // Defense in depth: the frontend picker already refuses to offer a date
  // before dataFloorDate, but a stale tab or a direct API call could still
  // send one. Amazon can never supply data before this tenant's floor (see
  // 020_seller_data_floor.sql), and nothing was ever stored before it either,
  // so clamp the actual query start here too rather than let a request
  // silently pass through and return a misleadingly empty range.
  const floorDate = sellerRow?.data_floor_date ? new Date(sellerRow.data_floor_date) : null;
  if (floorDate && start < floorDate) start.setTime(floorDate.getTime());
  const effectiveRange = { start: start.toISOString(), end: end.toISOString() };
  // While the backfill owns this tenant's Amazon rate budget (see
  // assertNoBackfillRunning), the demand-driven auto-sync must not also
  // start work against the same tenant+report type - and there is nothing
  // useful to show for an arbitrary range yet anyway, since the dashboard is
  // showing the backfill's own progress screen instead of figures.
  const autoSyncReportTypes = sellerRow && !backfillRunning ? await findMissingReportTypes(tenantId, effectiveRange) : [];
  for (const reportType of autoSyncReportTypes) triggerBackgroundSync(tenantId, reportType, effectiveRange);
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
        where tenant_id=$1 and date >= $2 and date < $3
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
      select * from daily order by date desc limit 120`, [tenantId, ...calendarDays({ start, end })])).rows.reverse();
    const products = (await client.query(`
      with traffic_products as (
        select asin, sum(units_ordered) units, sum(ordered_product_sales) sales, avg(featured_offer_percentage) buy_box
        from sales_traffic_daily
        where tenant_id=$1 and date >= $4 and date < $5 and asin is not null and asin <> 'ALL'
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
      select asin, units, sales, buy_box from merged order by sales desc nulls last, units desc nulls last limit 20`, [tenantId, start, end, ...calendarDays({ start, end })])).rows;
    const trend = (await client.query(`
      with traffic_trend as (
        select date, sum(ordered_product_sales) sales, sum(units_ordered) units, sum(sessions) sessions
        from sales_traffic_daily
        where tenant_id=$1 and date >= $4 and date < $5
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
      select date, sales, units, sessions from merged order by date desc limit 90`, [tenantId, start, end, ...calendarDays({ start, end })])).rows.reverse();
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
        select report_type, status, started_at, completed_at, error_message, s3_key, source
        from sync_jobs where tenant_id=$1
      )
      select distinct on (report_type) report_type, status, started_at, completed_at, error_message, s3_key, source
      from normalized_jobs
      order by report_type, started_at desc nulls last
    `, [tenantId])).rows;
    // This feeds financialComponents/financialSummary/orderPayments below, not
    // just display - a low cap here was silently truncating those
    // computations for any account with more settlement lines than the cap
    // in the selected range (confirmed: one real account had 700+ lines in a
    // 25-day window, well past the old limit of 250).
    // The Finances API side of the ledger, itemised, alongside the settlement
    // side. Settlement documents only ever carry RELEASED activity and they lag
    // the posted date Amazon's own statement is built on, so a settlement-only
    // view is structurally short - measured on a real account, 101,248.49 stored
    // against 107,014.34 of released activity for the same window, before any
    // classification. These are the rows that close that gap, and having them
    // downloadable next to the settlement lines is what makes the two sides
    // comparable when a section does not match Amazon.
    const financeLines = (await client.query(`select fi.transaction_id, fi.posted_date, fi.order_id, fi.sku, fi.category,
        fi.amount_description, fi.amount,
        coalesce(ft.raw->>'transactionStatus',ft.raw->>'TransactionStatus','Unknown') transaction_status,
        ft.transaction_type,
        -- A transaction that was deferred and has since been released is counted
        -- by Amazon on the date the money matured, not the date it posted, so
        -- the two dates decide whether it belongs in the window being viewed.
        -- There is no release-date field: confirmed on a real account, every
        -- transaction of every status carries exactly the same twelve top-level
        -- keys and none of them is a release date. The date lives inside
        -- "contexts", a polymorphic array where a DeferredContext carries
        -- maturityDate and deferralReason.
        --
        -- Amazon nests contexts on the transaction OR on each item, and has
        -- moved them before, so these search the payload at any depth rather
        -- than assuming a path.
        nullif(jsonb_path_query_array(coalesce(ft.raw,'{}'::jsonb),'$.**.maturityDate')::text,'[]') maturity_dates,
        nullif(jsonb_path_query_array(coalesce(ft.raw,'{}'::jsonb),'$.**.deferralReason')::text,'[]') deferral_reasons,
        -- The fulfilment channel (AFN/MFN). This is the only source in the
        -- Finances API for Amazon's FBA vs seller-fulfilled split, and
        -- flattenFinanceTransaction currently reads ProductContext for sku and
        -- asin while discarding it.
        nullif(jsonb_path_query_array(coalesce(ft.raw,'{}'::jsonb),'$.**.fulfillmentNetwork')::text,'[]') fulfillment_networks,
        nullif(jsonb_path_query_array(coalesce(ft.raw,'{}'::jsonb),'$.**.contextType')::text,'[]') context_types
      from finance_transaction_items fi
      left join finance_transactions ft on ft.tenant_id=fi.tenant_id and ft.transaction_id=fi.transaction_id
      where fi.tenant_id=$1 and fi.posted_date >= $2 and fi.posted_date < $3
      order by fi.posted_date desc nulls last, fi.transaction_id limit 20000`, [tenantId, start, end])).rows;
    const settlementLines = (await client.query(`select id source_row_id, settlement_id, order_id, amount_type, amount_description, amount, posted_date,
        coalesce(raw->>'transaction-type',raw->>'transaction type',raw->>'transactionType') transaction_type,
        coalesce(raw->>'order-item-code',raw->>'order item code') order_item_code,
        coalesce(raw->>'merchant-order-item-id',raw->>'merchant order item id') merchant_order_item_id,
        coalesce(raw->>'sku') sku,
        coalesce(raw->>'quantity-purchased',raw->>'quantity purchased') quantity_purchased,
        coalesce(raw->>'posted-date-time',raw->>'posted date time') posted_date_time,
        coalesce(raw->>'adjustment-id',raw->>'adjustment id') adjustment_id,
        source_key
      from settlement_rows where tenant_id=$1 and posted_date >= $2 and posted_date < $3 order by posted_date desc nulls last limit 10000`, [tenantId, start, end])).rows;
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
    const inventory = (await client.query('select sku, fulfillable_quantity, snapshot_date from inventory_snapshots where tenant_id=$1 and snapshot_date >= $2 and snapshot_date < $3 order by snapshot_date desc, fulfillable_quantity desc nulls last limit 50', [tenantId, ...calendarDays({ start, end })])).rows;
    const returns = (await client.query('select order_id, return_reason, disposition, status, return_date, quantity from returns where tenant_id=$1 and return_date >= $2 and return_date < $3 order by return_date desc nulls last limit 50', [tenantId, ...calendarDays({ start, end })])).rows;
    const reimbursements = (await client.query('select sku, amount, reason, reimbursement_date from reimbursements where tenant_id=$1 and reimbursement_date >= $2 and reimbursement_date < $3 order by reimbursement_date desc nulls last limit 50', [tenantId, ...calendarDays({ start, end })])).rows;
    const invoices = (await client.query('select invoice_type, order_id, taxable_value, cgst, sgst, igst, invoice_date from gst_invoices where tenant_id=$1 and invoice_date >= $2 and invoice_date < $3 order by invoice_date desc nulls last limit 50', [tenantId, ...calendarDays({ start, end })])).rows;
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
    // Deferred activity is measured on every render but never added to the
    // statement. Checked against a real seller's own Account Activity
    // Statement, adding it moved every bucket further from Amazon and tripled
    // the total error, so the reported figures stay settlement-only and this
    // block exists to size the pending pipeline - and to keep the two
    // distinguishable failure modes apart: "Amazon counts money we do not
    // hold" versus "we misclassify money we do hold".
    // A settlement whose lines do not add up to Amazon's own stated total is
    // the one failure that corrupts every figure silently, so it is reported
    // first and unconditionally, with the exact shortfall.
    const outstanding=dashboardCalculations.diagnostics?.outstandingSettlementSyncs;
    if (outstanding) console.log(`[dashboard ${tenantId.slice(0, 8)}] INCOMPLETE SETTLEMENT HISTORY - ${outstanding} settlement sync(s) fetched only part of what Amazon has. Money figures are computed from incomplete data until those documents are downloaded.`);
    const integrity=dashboardCalculations.diagnostics?.settlementIntegrity;
    if (integrity?.length) {
      console.log(`[dashboard ${tenantId.slice(0, 8)}] SETTLEMENT INTEGRITY FAILURE - ${integrity.length} settlement(s) do not add up to the total Amazon stamped on them. Figures derived from them are wrong; re-run Reset & Resync for settlements.`);
      for (const row of integrity) console.log(`[dashboard ${tenantId.slice(0, 8)}]   settlement=${row.settlement_id} rows=${row.row_count} sum=${row.rows_total.toFixed(2)} amazon_total=${row.header_total.toFixed(2)} difference=${row.difference.toFixed(2)}`);
    }
    // A seller was never going to notice a console log and click Reset &
    // Resync themselves - confirmed live, this exact failure sat unfixed
    // for hours until it was found by reading server logs by hand. So a
    // settlement whose own rows do not add up to the total Amazon stamped
    // on it repairs itself instead of waiting on a human. A plain
    // background sync (triggerBackgroundSync above) cannot do this: it
    // skips any report type with a recent COMPLETED sync, and a corrupt
    // settlement IS recorded as completed - it downloaded fine, the rows
    // are just wrong - so only a real Reset & Resync replaces it.
    //
    // ONLY the integrity failure triggers this, deliberately. The first
    // version also triggered on outstandingSettlementSyncs, which was
    // wrong: that counts partial syncs from the last 7 days, and a range
    // ending today ALWAYS has settlement documents Amazon has not issued
    // yet, so it could never reach zero and the repair fired forever on a
    // healthy account. "Amazon has not settled this week yet" is not
    // corruption - it is how settlement works, and no amount of re-fetching
    // changes it.
    const settlementDataCorrupt = Boolean(integrity?.length);
    if (settlementDataCorrupt && !backfillRunning) {
      if (syncQueue.isBusy(`${tenantId}:${SETTLEMENT_REPORT_TYPE}`)) {
        if (!autoSyncReportTypes.includes(SETTLEMENT_REPORT_TYPE)) autoSyncReportTypes.push(SETTLEMENT_REPORT_TYPE);
      } else if (!(await settlementAutoHealOnCooldown(tenantId))) {
        console.log(`[dashboard ${tenantId.slice(0, 8)}] auto-healing corrupt settlement data - triggering Reset & Resync automatically`);
        resetSettlementData(tenantId, effectiveRange).catch(error => app.log.warn({ err: error, tenantId }, 'Automatic settlement auto-heal failed'));
        if (!autoSyncReportTypes.includes(SETTLEMENT_REPORT_TYPE)) autoSyncReportTypes.push(SETTLEMENT_REPORT_TYPE);
      }
      // On cooldown: say nothing new here. The most recent attempt already
      // logged its own outcome (success, or "run again once the rate limit
      // clears"), and there is nothing further to trigger until it lapses.
    }
    const pendingDetail=dashboardCalculations.diagnostics?.pendingFinanceRowsDetail;
    const mergeSummary=dashboardCalculations.diagnostics?.pendingMergeSummary;
    if (pendingDetail?.length) {
      const label=`[dashboard ${tenantId.slice(0,8)}]`;
      const money=value=>Number(value ?? 0).toFixed(2);
      console.log(`${label} statement is settlement-only. Deferred activity measured but EXCLUDED: ${mergeSummary.pendingRows} row(s) across ${mergeSummary.pendingOrders} order(s), from ${mergeSummary.financeRowsInRange} Finance row(s) in range; ${mergeSummary.settledOrderIdsKnown} order(s) known settled (all time)`);
      for (const bucket of ['income','expenses','gst','tax','transfer']) {
        const baseline=mergeSummary.settlementBaselineTotals[bucket] ?? 0;
        const excluded=mergeSummary.pendingExcludedTotals[bucket] ?? 0;
        if (baseline || excluded) console.log(`${label}   ${bucket.padEnd(8)} reported=${money(baseline).padStart(12)}   (deferred, not counted: ${money(excluded).padStart(12)})`);
      }
      // One line per excluded row, on EVERY dashboard load. On a real account
      // that is several hundred lines per request - it buried the one thing
      // anyone actually needed to read in the log (a GST 403), and printing it
      // is not free either. The summary above says everything the day-to-day
      // case needs; the per-row detail is for when someone is chasing a
      // specific figure, so it is opt-in now.
      if (process.env.LOG_DEFERRED_ROWS === '1' || process.env.LOG_DEFERRED_ROWS === 'true') {
        for (const row of pendingDetail) console.log(`${label}   [excluded] order=${row.order_id} status=${row.transaction_status} category=${row.category} amount_desc=${row.amount_description ?? ''} amount=${row.amount} -> would be ${row.bucket}`);
      } else {
        console.log(`${label}   (${pendingDetail.length} excluded row(s) not listed - set LOG_DEFERRED_ROWS=1 to see each one)`);
      }
    }
    const hasImportedData = Number(orders.orders ?? 0) > 0 || Number(kpis.net_settled ?? 0) !== 0 || products.length > 0 || payments.length > 0 || inventory.length > 0;
    return { seller, amazonAuth, hasImportedData, kpis, orders, orderRows, orderPayments, paymentComponents, paymentSummary, dashboardCalculations, businessReportRows, products, trend, payments, settlementLines, financeLines, financialComponents, financialSummary, jobs, inventory, returns, reimbursements, invoices, orderItems, financeTransactions, autoSyncing: autoSyncReportTypes, settlementDataCorrupt };
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
    recentJobs: (await client.query('select report_type,status,started_at,completed_at,error_message,s3_key,source from sync_jobs where tenant_id=$1 order by started_at desc nulls last limit 10', [tenantId])).rows
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

// Registered last so it cannot shadow any existing route, and given
// requireTenantUser rather than reimplementing it - the scheduling routes are
// behind exactly the same tenant check as every other /api/tenants route.
await app.register(schedulingRoutes, { requireTenantUser });

const scheduler = startScheduler();
const schedulingScheduler = startSchedulingScheduler();
// PORT is what every hosting platform hands a process; 4000 stays the default
// so `npm run dev` and the web app's VITE_API_URL are unchanged.
await app.listen({ port: Number(process.env.PORT ?? 4000), host: '0.0.0.0' });
export { app, scheduler, schedulingScheduler };
