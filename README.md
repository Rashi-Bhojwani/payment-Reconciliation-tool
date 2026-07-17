# Amazon Seller Reconciliation & Business Intelligence Platform

Working local/dev **plain JavaScript** monorepo for Amazon India seller reconciliation. This version intentionally uses only the credentials in `.env.example`: Amazon SP-API/LWA, the test seller token, AWS RDS Postgres, AWS S3, and app auth/origin settings. It does **not** include Docker, MinIO, Redis, BullMQ, TypeScript, Ads API, Stripe, AI narrative generation, or unused environment variables.

## Apps and packages

- `apps/api` — Fastify API, Amazon OAuth routes, admin approval workflow, in-process node-cron scheduler, and sync jobs, all in ES modules.
- `apps/web` — React/Vite JavaScript SPA with seller and admin dashboard shell.
- `packages/db` — shared Postgres client and RLS tenant context helper.
- `packages/sp-api-client` — reusable SP-API client, Reports API flow, GST RDT, fees, orders, and finances helpers.

## Quick start

1. Copy `.env.example` to `.env` and replace `HEHE` values with real RDS, S3, and Amazon credentials. The API now loads `.env` automatically, but `DATABASE_URL` must be present there (or exported in your shell) for `npm run dev`.
2. Run database migrations against your RDS database:

```bash
export DATABASE_URL="postgresql://reconciliation:YOUR_PASSWORD@YOUR_RDS_HOST:5432/postgres"
for file in packages/db/migrations/*.sql; do psql "$DATABASE_URL" -f "$file"; done
```

3. Install dependencies and start API + web directly:

```bash
npm install
npm run dev
```

4. Open `http://localhost:5173`.
5. Use **Bootstrap Test Seller** to create a pending tenant from `TEST_SELLER_REFRESH_TOKEN`, then use the Admin Dashboard section to grant access before seller data endpoints are available.
6. Trigger `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` from the dashboard to fetch the settlement report, store the raw file in S3, and upsert settlement rows into Postgres.

## Dashboard flow

The Seller Dashboard lets you connect Amazon, bootstrap a test seller, enter a tenant ID, refresh tenant metrics, view a Payment Report built from Settlement Report rows, and view Sales & Traffic chart data when imported. The Admin Dashboard lists tenants, grants/rejects/revokes access, and triggers settlement sync for active tenants. Seller data APIs are denied until the tenant is `active`, so the dashboard remains gated behind admin approval.

## Runtime validation

There is no TypeScript build step. Financial and route-facing code uses `zod` schemas plus JSDoc comments to validate key shapes at runtime, including route params, report types, date ranges, raw report storage inputs, and settlement import rows.

## Deferred by design

AI narrative generation, Ads API, Stripe billing automation, Docker/containerization, TypeScript, and external queues are intentionally excluded from this phase. The job runner is wrapped in `runJob(jobName, fn)` and storage is isolated in `storage/s3.js` so future infrastructure can be added later without rewriting the sync logic.
