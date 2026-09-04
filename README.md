# Amazon Seller Reconciliation & Business Intelligence Platform

Working local/dev **plain JavaScript** monorepo for Amazon India seller reconciliation. This version intentionally uses only the credentials in `.env.example`: Amazon SP-API/LWA, the test seller token, AWS RDS Postgres, AWS S3, and app auth/origin settings. It does **not** include Docker, MinIO, Redis, BullMQ, TypeScript, Ads API, Stripe, AI narrative generation, or unused environment variables.

## Apps and packages

- `apps/api` — Fastify API, Amazon OAuth routes, admin approval workflow, in-process node-cron scheduler, and sync jobs, all in ES modules.
- `apps/web` — React/Vite JavaScript SPA with seller and admin dashboard shell.
- `packages/db` — shared Postgres client and RLS tenant context helper.
- `packages/sp-api-client` — reusable SP-API client, Reports API flow, GST RDT, fees, orders, and finances helpers.
- `packages/order-scheduler` — order scheduling, merged in from the standalone order scheduling tool: marketplace adapters (Amazon Easy Ship, plus Flipkart/Meesho/Myntra stubs), order sync, and pickup scheduling.

## Order scheduling

Reconciliation answers "what did this order pay". Scheduling is the other half
of the same order: pull what still has to ship, enter each package once, and
book the Amazon Easy Ship pickup — instead of doing it in Seller Central.

Three things are worth knowing about how it is wired in:

- **There is no second Amazon login.** Both halves talk to the same SP-API
  application on behalf of the same seller, so scheduling reuses the refresh
  token the reconciliation side already holds and re-reads it whenever the
  seller re-authorizes (`apps/api/src/jobs/scheduling-link.js`). Connecting
  Amazon once, in Settings → Amazon Connection, is the whole setup.
- **Its tables live in a `scheduling` Postgres schema** (migration 025), not in
  `public`. Four table names collided outright — `orders` above all, which
  means something completely different on each side — and `packages/order-scheduler`
  therefore uses its own connection pool pinned to
  `search_path = scheduling, public`. See the header comment in
  `packages/order-scheduler/src/db/pool.js`; it is the single most important
  file in the merge.
- **Every scheduling table is behind the same row-level security** as the
  reconciliation tables, reading the same `app.current_tenant_id` that
  `withTenant()` sets.

Order sync runs unattended hourly (`apps/api/src/jobs/scheduling-sync.js`); the
Sync button only exists for when you want it right now.

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

## Checks

`npm run check` is the one that runs everywhere: 241 tests, no database, no
credentials, no network. Run it before every commit.

Five more are opt-in because they need a **throwaway** Postgres with
`npm run db:migrate` already applied — every one of them writes and deletes
rows, so never point `DATABASE_URL` at a real database:

| Command | What it proves |
| --- | --- |
| `npm run check:sql` | Every migration applies, and re-applies, cleanly. |
| `npm run check:scheduling-isolation` | The `scheduling` row-level policies actually hold, tested as a purpose-made unprivileged role — a superuser bypasses every policy and would pass for the wrong reason. |
| `npm run check:scheduling-runtime` | The repositories can still *read through* those policies. A wrong `search_path`, an unbound tenant or a bad join each return zero rows rather than failing, which looks identical to an empty page. |
| `npm run check:scheduling-api` | The real server, booted: auth, the cross-tenant 403, the response shapes the React components destructure, and the three states of the Amazon link. |
| `npm run check:scheduler-db` | The ported scheduling logic, against a real database — the sync loop, the scheduling service, shipment idempotency, the reconciliation sweep. |

## Runtime validation

There is no TypeScript build step. Financial and route-facing code uses `zod` schemas plus JSDoc comments to validate key shapes at runtime, including route params, report types, date ranges, raw report storage inputs, and settlement import rows.

## Deferred by design

AI narrative generation, Ads API, Stripe billing automation, Docker/containerization, TypeScript, and external queues are intentionally excluded from this phase. The job runner is wrapped in `runJob(jobName, fn)` and storage is isolated in `storage/s3.js` so future infrastructure can be added later without rewriting the sync logic.
