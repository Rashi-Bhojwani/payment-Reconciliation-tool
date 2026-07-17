import crypto from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import { z } from 'zod';
import { assertActiveTenant, pool, withTenant } from '@recon/db';
import { REPORT_TYPES } from '@recon/sp-api-client';
import { secrets } from './config/secrets.js';
import { encryptSecret } from './config/crypto.js';
import { startScheduler, syncReportForTenant } from './jobs/sync.js';

const app = Fastify({ logger: { redact: ['req.headers.authorization', 'refresh_token', 'access_token', 'password', 'passwordHash'] } });

await app.register(cors, { origin: secrets.frontendOrigin, credentials: true });
await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
await app.register(jwt, { secret: secrets.jwtSecret });

const TenantParamsSchema = z.object({ tenantId: z.string().uuid() });
const SyncParamsSchema = z.object({ tenantId: z.string().uuid(), reportType: z.enum(REPORT_TYPES) });
const AmazonCallbackSchema = z.object({ spapi_oauth_code: z.string().optional(), code: z.string().optional(), selling_partner_id: z.string().optional(), state: z.string().optional() });
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
  const hash = crypto.pbkdf2Sync(password, salt, Number(iterations), 32, 'sha256');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), hash);
}

async function requireAuth(request) {
  try { return await request.jwtVerify(); } catch { throw Object.assign(new Error('Authentication required'), { statusCode: 401 }); }
}
async function requireAdmin(request) { const user = await requireAuth(request); if (user.role !== 'admin') throw Object.assign(new Error('Admin access required'), { statusCode: 403 }); return user; }
async function requireTenantUser(request, tenantId) { const user = await requireAuth(request); if (user.role === 'admin') return user; if (user.tenantId !== tenantId) throw Object.assign(new Error('Tenant access denied'), { statusCode: 403 }); return user; }

app.setErrorHandler((error, _request, reply) => {
  const statusCode = error.statusCode ?? (error.name === 'ZodError' ? 400 : 500);
  reply.code(statusCode).send({ error: statusCode === 500 ? 'Internal server error' : error.message });
});

app.get('/health', async () => ({ ok: true }));

app.post('/api/auth/register-seller', async request => {
  const body = RegisterSchema.parse(request.body);
  const tenant = await pool.query(
    "insert into tenants(company_name, legal_name, owner_email, login_email, default_marketplace_id, status) values($1,$1,$2,$2,$3,'pending') returning id, company_name, status, plan",
    [body.companyName, body.ownerEmail, body.marketplaceId]
  );
  const tenantId = tenant.rows[0].id;
  const user = await pool.query(
    "insert into users(tenant_id, email, password_hash, role, status) values($1,$2,$3,'user','active') returning id,email,role,tenant_id",
    [tenantId, body.ownerEmail, hashPassword(body.password)]
  );
  const token = app.jwt.sign({ sub: user.rows[0].id, email: user.rows[0].email, role: 'user', tenantId }, { expiresIn: '12h' });
  return { token, user: { ...user.rows[0], tenantId }, tenant: tenant.rows[0] };
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
  const query = z.object({ tenantId: z.string().uuid().optional() }).parse(request.query);
  const state = query.tenantId ? Buffer.from(JSON.stringify({ tenantId: query.tenantId })).toString('base64url') : crypto.randomUUID();
  const url = new URL('https://sellercentral.amazon.in/apps/authorize/consent');
  url.searchParams.set('application_id', secrets.spApiAppId);
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', secrets.redirectUri);
  return reply.redirect(url.toString());
});

app.get('/api/auth/amazon/callback', async (request, reply) => {
  const query = AmazonCallbackSchema.parse(request.query);
  const code = query.spapi_oauth_code ?? query.code;
  if (!code) return reply.code(400).send({ error: 'Missing authorization code' });
  const token = await fetch('https://api.amazon.com/auth/o2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: secrets.lwaClientId, client_secret: secrets.lwaClientSecret, redirect_uri: secrets.redirectUri }) });
  if (!token.ok) return reply.code(502).send({ error: 'Amazon token exchange failed' });
  const body = z.object({ refresh_token: z.string().min(1) }).parse(await token.json());
  let tenantId;
  try { tenantId = JSON.parse(Buffer.from(query.state ?? '', 'base64url').toString()).tenantId; } catch { tenantId = undefined; }
  if (!tenantId) tenantId = (await pool.query("insert into tenants(company_name, status) values($1, 'pending') returning id", [`Amazon Seller ${query.selling_partner_id ?? ''}`])).rows[0].id;
  const marketplace = 'A21TJRUUN4KGV';
  await pool.query('insert into sellers(tenant_id, amazon_seller_id, marketplace_id, refresh_token_encrypted) values($1,$2,$3,$4) on conflict(tenant_id, amazon_seller_id) do update set refresh_token_encrypted=excluded.refresh_token_encrypted, auth_status=\'authorized\', connected_at=now()', [tenantId, query.selling_partner_id ?? 'UNKNOWN', marketplace, encryptSecret(body.refresh_token)]);
  return reply.redirect(`${secrets.frontendOrigin}/seller?tenantId=${tenantId}&connected=1`);
});

app.get('/api/admin/tenants', async request => {
  await requireAdmin(request);
  const result = await pool.query(`select t.id, t.company_name, t.owner_email, t.login_email, t.status, t.plan, t.created_at, t.approved_at,
      s.amazon_seller_id, s.marketplace_id, s.auth_status, exists(select 1 from sellers s2 where s2.tenant_id = t.id) as amazon_connected,
      (select max(completed_at) from sync_jobs sj where sj.tenant_id = t.id and sj.status = 'completed') as last_successful_sync,
      (select count(*) from users u where u.tenant_id = t.id and u.status='active') as user_count
    from tenants t left join lateral (select * from sellers s where s.tenant_id=t.id order by connected_at desc limit 1) s on true order by t.created_at desc`);
  return { tenants: result.rows };
});

app.post('/api/admin/tenants/:tenantId/grant-access', async request => { await requireAdmin(request); const { tenantId } = TenantParamsSchema.parse(request.params); return (await pool.query("update tenants set status='active', approved_at=now(), approved_by_admin_id=$2 where id=$1 returning id,status,approved_at", [tenantId, adminId])).rows[0]; });
app.post('/api/admin/tenants/:tenantId/reject', async request => { await requireAdmin(request); const { tenantId } = TenantParamsSchema.parse(request.params); return (await pool.query("update tenants set status='suspended' where id=$1 returning id,status", [tenantId])).rows[0]; });
app.post('/api/admin/tenants/:tenantId/revoke-access', async request => { await requireAdmin(request); const { tenantId } = TenantParamsSchema.parse(request.params); return (await pool.query("update tenants set status='suspended' where id=$1 returning id,status", [tenantId])).rows[0]; });
app.post('/api/admin/tenants/:tenantId/sync/:reportType', async request => { await requireAdmin(request); return syncReportForTenant(SyncParamsSchema.parse(request.params)); });

app.get('/api/tenants/:tenantId/dashboard', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params); await requireTenantUser(request, tenantId); await assertActiveTenant(tenantId);
  return withTenant(tenantId, async client => {
    const kpis = (await client.query(`select coalesce(sum(amount),0) net_settled, coalesce(sum(case when amount > 0 then amount else 0 end),0) earnings, coalesce(sum(case when amount < 0 then amount else 0 end),0) deductions from settlement_rows`)).rows[0];
    const orders = (await client.query(`select count(*) orders, coalesce(sum(total_amount),0) order_value from orders`)).rows[0];
    const products = (await client.query(`select asin, sum(units_ordered) units, sum(ordered_product_sales) sales, avg(featured_offer_percentage) buy_box from sales_traffic_daily group by asin order by sales desc nulls last limit 20`)).rows;
    const trend = (await client.query(`select date, sum(ordered_product_sales) sales, sum(units_ordered) units, sum(sessions) sessions from sales_traffic_daily group by date order by date desc limit 90`)).rows.reverse();
    const payments = (await client.query(`select settlement_id, date(posted_date) posted_date, sum(amount) net_amount, count(*) lines from settlement_rows group by settlement_id,date(posted_date) order by date(posted_date) desc nulls last limit 50`)).rows;
    const jobs = (await client.query('select report_type,status,started_at,completed_at,error_message,s3_key from sync_jobs order by started_at desc nulls last limit 10')).rows;
    return { kpis, orders, products, trend, payments, jobs };
  });
});

// Backward-compatible report endpoints for existing clients.
app.get('/api/tenants/:tenantId/summary', async request => { const { tenantId } = TenantParamsSchema.parse(request.params); await requireTenantUser(request, tenantId); const dashboard = await app.inject({ method: 'GET', url: `/api/tenants/${tenantId}/dashboard`, headers: request.headers }); return JSON.parse(dashboard.body); });

await pool.query("insert into users(id,email,password_hash,role,status) values($1,$2,$3,'admin','active') on conflict(email) do nothing", [adminId, defaultAdminEmail, hashPassword(defaultAdminPassword)]).catch(error => app.log.warn({ error }, 'Admin seed skipped; run migrations before first login'));

startScheduler();
await app.listen({ port: 4000, host: '0.0.0.0' });
