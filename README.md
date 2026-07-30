# Amazon Seller Payment Reconciliation

A JavaScript monorepo that connects an Amazon seller account through SP-API, imports authoritative orders, financial transactions, settlements, GST documents, returns, reimbursements, inventory, and Sales & Traffic data, then exposes an explainable reconciliation dashboard.

## Repository layout

- `apps/api` — Fastify API, Amazon OAuth, sync jobs, report parsers, reconciliation calculations, and scheduler.
- `apps/web` — React/Vite seller and administrator dashboards.
- `packages/db` — PostgreSQL pool, migrations, and tenant row-level-security helpers.
- `packages/sp-api-client` — LWA authentication plus current Orders, Finances, Reports, Inventory, Catalog, and Fees API clients.

## Setup

1. Copy `.env.example` to `.env` and replace every `HEHE` placeholder.

   Required production values include `DATABASE_URL`, `JWT_SECRET`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, the LWA/SP-API application values, and a registered `SP_API_REDIRECT_URI`.
   For RDS, provide its trusted PEM bundle in `DATABASE_SSL_CA` and keep `DATABASE_SSL_REJECT_UNAUTHORIZED=true`.

2. Install dependencies and apply every migration in order:

```bash
npm ci
npm run db:migrate
```

Migration `012_sp_api_reconciliation_integrity.sql` is required by the current importers. It adds idempotent source keys, separates settlement statements from monetary lines, adds GST/reimbursement/return fields, and separates ASIN-level Sales & Traffic aggregates.

3. Start the API and web app:

```bash
npm run dev
```

4. Open `http://localhost:5173`, sign in with the administrator configured in `.env`, create a seller account, then let that seller authorize the application in Seller Central.

## Source and calculation rules

- The app uses Orders API `v2026-01-01`. Order items arrive with each order, and incremental sync uses `lastUpdatedAfter` so status changes are not missed.
- Finances API `v2024-06-19` is fully paginated with the original range retained on every next-token request. `DEFERRED` transactions are stored for audit but excluded from released-money KPIs.
- Settlement reports are listed rather than requested because Amazon generates them automatically. Statement headers are stored in `settlement_statements`; only monetary rows go into `settlement_rows`.
- All report importers use deterministic source keys. Re-syncing the same report updates existing rows instead of multiplying totals.
- Source coverage merges adjacent and overlapping successful sync intervals. A real gap, failed report, or unconsumed pagination token still makes the affected metric unavailable.
- A truncated report document is retained as raw audit evidence but does not overwrite the last verified normalized snapshot.
- Sales & Traffic date totals and ASIN totals are stored separately. The dashboard uses a complete Sales & Traffic range when available and otherwise labels Orders data as a fallback; it never takes the larger of two sources.
- Quantity KPIs use complete Sales & Traffic `unitsOrdered`/`unitsRefunded`. The fallback is allowed only for an FBA-only order set with complete FBA Customer Returns coverage.
- GST values come only from imported Amazon GST documents. The app does not synthesize tax invoices from order items.
- Unavailable sessions, page views, refund counts, or quantities remain unavailable. The UI does not fabricate estimates.

## Validation

```bash
npm test
npm run build
```

The test suite covers locale-sensitive amounts and dates, settlement idempotency, official GST and reimbursement mappings, FBA return semantics, Sales & Traffic separation, finance component classification, deferred transactions, gap-free multi-job coverage, source precedence, and date-range behavior.

## Security notes

- SP-API access and refresh tokens remain server-side. The browser never receives an LWA access token.
- Database credentials are read only from `DATABASE_URL`; no connection string is embedded in source.
- Raw downloaded reports are ignored under `apps/api/storage/raw-reports/` and must not be committed.
- `JWT_SECRET` and `SESSION_SECRET` are mandatory when `NODE_ENV=production`.
- If a secret was ever committed, rotate it and remove it from Git history; deleting it from the current source tree is not sufficient.
