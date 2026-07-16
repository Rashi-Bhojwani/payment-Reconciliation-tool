# Amazon Seller Reconciliation & Business Intelligence Platform

Working local/dev **plain JavaScript** monorepo for Amazon India seller reconciliation. This version intentionally uses real AWS RDS Postgres via `DATABASE_URL` and real AWS S3 via `@aws-sdk/client-s3`; it does **not** include Docker, MinIO, Redis, BullMQ, TypeScript, or AI narrative generation.

## Apps and packages

- `apps/api` — Fastify API, Amazon OAuth routes, admin approval workflow, in-process node-cron scheduler, and sync jobs, all in ES modules.
- `apps/web` — React/Vite JavaScript SPA with seller and admin dashboard shell.
- `packages/db` — shared Postgres client and RLS tenant context helper.
- `packages/sp-api-client` — reusable SP-API client, Reports API flow, GST RDT, fees, orders, and finances helpers.
- `packages/ads-api-client` — separate Ads API placeholder module for later reporting work.

## Quick start

1. Copy `.env.example` to `.env` and replace `HEHE` values with real RDS, S3, and Amazon credentials.
2. Run database migrations against your RDS database:

```bash
psql "$DATABASE_URL" -f packages/db/migrations/001_init.sql
```

3. Install dependencies and start API + web directly:

```bash
npm install
npm run dev
```

4. Open `http://localhost:5173`.
5. Use **Bootstrap Test Seller** to create a pending tenant from `TEST_SELLER_REFRESH_TOKEN`, then use the Admin Dashboard section to grant access before seller data endpoints are available.
6. Trigger `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` from the dashboard to fetch the settlement report, store the raw file in S3, and upsert settlement rows into Postgres.

## Runtime validation

There is no TypeScript build step. Financial and route-facing code uses `zod` schemas plus JSDoc comments to validate key shapes at runtime, including route params, report types, date ranges, raw report storage inputs, and settlement import rows.

## Access approval workflow

New tenants are created with `status = pending`, including OAuth-created tenants and bootstrap tenants. Tenant data API routes call `assertActiveTenant()` on every request so revocation is enforced mid-session. Admin endpoints can grant access (`active`), reject/revoke (`suspended`), and trigger manual syncs.

## Deferred by design

AI narrative generation, Docker/containerization, TypeScript, and external queues are intentionally excluded from this phase. The job runner is wrapped in `runJob(jobName, fn)` and storage is isolated in `storage/s3.js` so SQS/containerization can be added later without rewriting the sync logic.
