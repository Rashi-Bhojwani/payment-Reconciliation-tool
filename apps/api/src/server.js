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

const app = Fastify({ logger: { redact: ['req.headers.authorization', 'refresh_token', 'access_token', 'refreshTokenEncrypted'] } });

await app.register(cors, { origin: secrets.frontendOrigin, credentials: true });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
await app.register(jwt, { secret: secrets.jwtSecret });

const TenantParamsSchema = z.object({ tenantId: z.string().uuid() });
const SyncParamsSchema = z.object({ tenantId: z.string().uuid(), reportType: z.enum(REPORT_TYPES) });
const AmazonCallbackSchema = z.object({ spapi_oauth_code: z.string().optional(), code: z.string().optional(), selling_partner_id: z.string().optional() });
const adminId = '00000000-0000-0000-0000-000000000001';

app.setErrorHandler((error, _request, reply) => {
  const statusCode = error.statusCode ?? (error.name === 'ZodError' ? 400 : 500);
  reply.code(statusCode).send({ error: statusCode === 500 ? 'Internal server error' : error.message });
});

app.get('/health', async () => ({ ok: true }));

app.post('/api/dev/bootstrap', async () => {
  const tenant = await pool.query("insert into tenants(company_name, status) values('Demo Seller', 'pending') returning id, company_name, status, plan");
  const tenantId = tenant.rows[0].id;
  if (process.env.TEST_SELLER_REFRESH_TOKEN && process.env.TEST_SELLER_REFRESH_TOKEN !== 'HEHE') {
    await pool.query(
      'insert into sellers(tenant_id, amazon_seller_id, marketplace_id, refresh_token_encrypted) values($1,$2,$3,$4)',
      [tenantId, process.env.TEST_SELLER_ID ?? 'TEST', process.env.TEST_MARKETPLACE_ID ?? 'A21TJRUUN4KGV', encryptSecret(process.env.TEST_SELLER_REFRESH_TOKEN)]
    );
  }
  return tenant.rows[0];
});

app.get('/api/auth/amazon/start', async (_request, reply) => {
  const state = crypto.randomUUID();
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

  const token = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: secrets.lwaClientId, client_secret: secrets.lwaClientSecret, redirect_uri: secrets.redirectUri })
  });
  if (!token.ok) return reply.code(502).send({ error: 'Amazon token exchange failed' });

  const body = z.object({ refresh_token: z.string().min(1) }).parse(await token.json());
  const tenant = await pool.query("insert into tenants(company_name, status) values($1, 'pending') returning id", [`Amazon Seller ${query.selling_partner_id ?? ''}`]);
  await pool.query(
    'insert into sellers(tenant_id, amazon_seller_id, marketplace_id, refresh_token_encrypted) values($1,$2,$3,$4)',
    [tenant.rows[0].id, query.selling_partner_id ?? 'UNKNOWN', 'A21TJRUUN4KGV', encryptSecret(body.refresh_token)]
  );
  return reply.redirect(`${secrets.frontendOrigin}/pending?connected=1`);
});

app.get('/api/admin/tenants', async () => {
  const result = await pool.query(`
    select t.id, t.company_name, t.status, t.plan, t.created_at, t.approved_at,
      exists(select 1 from sellers s where s.tenant_id = t.id) as amazon_connected,
      (select max(completed_at) from sync_jobs sj where sj.tenant_id = t.id and sj.status = 'completed') as last_successful_sync
    from tenants t order by t.created_at desc
  `);
  return { tenants: result.rows };
});

app.post('/api/admin/tenants/:tenantId/grant-access', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  const result = await pool.query("update tenants set status='active', approved_at=now(), approved_by_admin_id=$2 where id=$1 returning id, status, approved_at", [tenantId, adminId]);
  return result.rows[0];
});

app.post('/api/admin/tenants/:tenantId/reject', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  const result = await pool.query("update tenants set status='suspended' where id=$1 returning id, status", [tenantId]);
  return result.rows[0];
});

app.post('/api/admin/tenants/:tenantId/revoke-access', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  const result = await pool.query("update tenants set status='suspended' where id=$1 returning id, status", [tenantId]);
  return result.rows[0];
});

app.post('/api/admin/tenants/:tenantId/sync/:reportType', async request => {
  const params = SyncParamsSchema.parse(request.params);
  return syncReportForTenant(params);
});

app.get('/api/tenants/:tenantId/summary', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  await assertActiveTenant(tenantId);
  return withTenant(tenantId, async client => ({
    settlementTotal: (await client.query('select coalesce(sum(amount),0) total from settlement_rows')).rows[0].total,
    grossSales: (await client.query("select coalesce(sum(amount),0) total from settlement_rows where amount_type ilike '%principal%' or amount_description ilike '%principal%'" )).rows[0].total,
    fees: (await client.query("select coalesce(sum(amount),0) total from settlement_rows where amount < 0 and (amount_type ilike '%fee%' or amount_description ilike '%fee%')" )).rows[0].total,
    feeLeaks: (await client.query('select count(*) count from fee_leak_flags')).rows[0].count,
    recentJobs: (await client.query('select report_type,status,started_at,completed_at,error_message,s3_key from sync_jobs order by started_at desc nulls last limit 10')).rows
  }));
});

app.get('/api/tenants/:tenantId/reports/payments', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  await assertActiveTenant(tenantId);
  return withTenant(tenantId, async client => {
    const rows = (await client.query(`
      select settlement_id, order_id, date(posted_date) as posted_date,
        coalesce(sum(amount), 0) as net_amount,
        coalesce(sum(case when amount > 0 then amount else 0 end), 0) as credits,
        coalesce(sum(case when amount < 0 then amount else 0 end), 0) as debits,
        count(*) as line_count
      from settlement_rows
      group by settlement_id, order_id, date(posted_date)
      order by date(posted_date) desc nulls last, settlement_id desc nulls last
      limit 200
    `)).rows;
    const totals = (await client.query(`
      select coalesce(sum(amount), 0) as net_amount,
        coalesce(sum(case when amount > 0 then amount else 0 end), 0) as credits,
        coalesce(sum(case when amount < 0 then amount else 0 end), 0) as debits
      from settlement_rows
    `)).rows[0];
    return { totals, rows };
  });
});

app.get('/api/tenants/:tenantId/reports/quarterly', async request => {
  const { tenantId } = TenantParamsSchema.parse(request.params);
  await assertActiveTenant(tenantId);
  return withTenant(tenantId, async client => ({
    businessPerformance: (await client.query('select date, asin, sessions, page_views, units_ordered, units_refunded, ordered_product_sales, shipped_product_sales, featured_offer_percentage from sales_traffic_daily order by date desc limit 100')).rows,
    manualNarrative: (await client.query("select narrative_json from generated_reports where report_type='quarterly' order by generated_at desc limit 1")).rows[0]?.narrative_json ?? {}
  }));
});

startScheduler();
await app.listen({ port: 4000, host: '0.0.0.0' });
