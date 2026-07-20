# Technical Documentation: Payment Reconciliation Tool

## 1. What this project is

This repository is a plain JavaScript monorepo for an Amazon seller reconciliation and business intelligence tool. It connects to Amazon Seller Central through Amazon SP-API, stores synced seller data in Postgres, and displays operational dashboards in a React web app.

The app is built around these business areas:

- Seller onboarding and login.
- Admin approval of seller tenants.
- Amazon OAuth connection.
- Direct SP-API sync for orders, order items, finance transactions, inventory summaries, and reimbursement-like finance events.
- Report-based SP-API sync for settlements, GST reports, returns, reimbursements, inventory, and sales/traffic.
- Dashboard analytics for revenue, orders, product performance, trends, inventory, payouts, reports, returns, and reimbursements.
- Raw report storage in S3, with a local disk fallback when S3 is missing or fails.

## 2. Monorepo layout

```text
payment-Reconciliation-tool/
├── README.md
├── technical_documentation.md
├── package.json
├── package-lock.json
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   └── src/
│   │       ├── server.js
│   │       ├── config/
│   │       │   ├── crypto.js
│   │       │   └── secrets.js
│   │       ├── jobs/
│   │       │   ├── runner.js
│   │       │   └── sync.js
│   │       └── storage/
│   │           └── s3.js
│   └── web/
│       ├── index.html
│       ├── package.json
│       ├── postcss.config.js
│       ├── tailwind.config.js
│       └── src/
│           ├── App.jsx
│           └── style.css
└── packages/
    ├── ads-api-client/
    │   ├── package.json
    │   └── src/index.js
    ├── db/
    │   ├── package.json
    │   ├── migrations/
    │   │   ├── 001_init.sql
    │   │   ├── 002_fix_users_rls.sql
    │   │   ├── 003_amazon_auth_metadata.sql
    │   │   └── 004_force_tenant_data_rls.sql
    │   └── src/index.js
    └── sp-api-client/
        ├── package.json
        └── src/index.js
```

## 3. Root files

### 3.1 `package.json`

The root `package.json` defines the monorepo workspaces and main commands.

Important fields:

- `workspaces`: includes `apps/*` and `packages/*`, so npm installs dependencies for the API, web app, and shared packages together.
- `scripts.dev`: runs API and web at the same time using `concurrently`.
- `scripts.dev:api`: starts only the Fastify API.
- `scripts.dev:web`: starts only the Vite web app.
- `scripts.start`: starts the API.
- `scripts.check`: syntax-checks the backend and shared JavaScript files using `node --check`.

The root project is private and not intended to be published as an npm package.

### 3.2 `package-lock.json`

This locks exact dependency versions. The repository uses npm, not pnpm or yarn, based on the committed lockfile and scripts.

### 3.3 `README.md`

The README gives the quick-start flow:

1. Configure environment variables.
2. Run database migrations.
3. Install dependencies.
4. Start API and web.
5. Use admin/seller flows to connect Amazon and sync data.

## 4. Application architecture

The system has four main layers:

```text
React Web App
    ↓ HTTP / JSON
Fastify API
    ↓ shared packages
Postgres + Amazon SP-API + S3/local raw report storage
```

### 4.1 Frontend layer

The frontend is `apps/web`. It is a Vite React single-page app. It handles:

- Login UI.
- Admin dashboard.
- Seller dashboard.
- Sync buttons.
- Tables and charts.
- Amazon connection actions.

### 4.2 API layer

The backend is `apps/api`. It handles:

- Auth.
- Tenant access checks.
- Amazon OAuth start/callback.
- Dashboard JSON endpoints.
- Sync endpoints.
- Admin tenant management.
- Scheduler startup.

### 4.3 Shared database layer

The database package is `packages/db`. It exports:

- A shared Postgres pool.
- `withTenant()` to run queries under a row-level-security tenant context.
- `assertActiveTenant()` to block inactive tenants.

### 4.4 Amazon SP-API layer

The SP-API client package is `packages/sp-api-client`. It owns:

- LWA token refresh.
- Generic SP-API requests.
- Reports API create/poll/download flow.
- Orders API calls.
- Order Items API calls.
- Finance API calls.
- FBA Inventory API calls.
- Fees estimation helper.

### 4.5 Storage layer

Raw report payloads are stored through `apps/api/src/storage/s3.js`. It tries S3 first when configured and falls back to local files if S3 is not usable.

## 5. Data flow overview

### 5.1 Seller connects Amazon

1. User logs into the web app.
2. User clicks Amazon connection.
3. Frontend calls `/api/auth/amazon/start`.
4. API creates a signed `state` value and redirects to Seller Central consent.
5. Amazon redirects back to `/api/auth/amazon/callback` or `/oauth/callback`.
6. API exchanges the OAuth code for refresh/access tokens.
7. API stores the refresh token encrypted in the `sellers` table.
8. API queues initial syncs.

### 5.2 Direct SP-API sync

Direct sync is triggered by POST `/api/tenants/:tenantId/sync`.

It imports:

- Orders into `orders`.
- Order items into `order_items`.
- Finance transactions into `finance_transactions`.
- Inventory summaries into `inventory_snapshots`.
- Reimbursement-like finance events into `reimbursements`.

This direct sync is used as a fallback when Amazon report creation fails.

### 5.3 Report sync

Report sync is triggered by POST `/api/tenants/:tenantId/sync/:reportType`.

The flow is:

1. Validate tenant and report type.
2. Create a row in `sync_jobs` with `running` status.
3. Fetch the report through SP-API Reports API.
4. Store the raw payload in S3 or locally.
5. Parse and import rows into the correct database table.
6. Mark the job `completed` or `failed`.

If key report types fail, the API attempts direct sync fallback and returns a completed fallback response.

### 5.4 Dashboard load

The web app calls GET `/api/tenants/:tenantId/dashboard`.

The API returns:

- Seller connection status.
- KPIs.
- Order totals.
- Product performance.
- Sales trend.
- Payments/payout activity.
- Recent sync jobs.
- Inventory.
- Returns.
- Reimbursements.
- GST invoices.
- Order items.
- Finance transactions.

## 6. Database package: `packages/db`

### 6.1 `packages/db/src/index.js`

This file creates and exports the shared Postgres connection.

#### `databaseUrl`

The current file contains a hardcoded Postgres connection string. Technically it should usually come from `process.env.DATABASE_URL` for safety and portability. In the current code, `databaseUrlConfigured` checks whether the string is present and not the placeholder value.

#### `pool`

`pool` is a `pg.Pool`. All API and sync code uses this pool or a tenant-scoped client from `withTenant()`.

#### `withTenant(tenantId, fn)`

Purpose:

- Checks out a Postgres client.
- Sets `app.current_tenant_id` in the session.
- Runs the callback.
- Clears the tenant setting.
- Releases the client.

This matters because database tables use row-level security policies that compare `tenant_id` to the current Postgres setting.

#### `assertActiveTenant(tenantId)`

Purpose:

- Looks up the tenant status.
- Allows only `active` tenants.
- Throws a `403` error if the tenant is pending, suspended, or missing.

This prevents inactive seller accounts from syncing or viewing data.

## 7. Database migrations

### 7.1 `001_init.sql`

Creates the initial schema.

Important tables:

#### `tenants`

Represents seller companies/accounts.

Important columns:

- `id`: tenant UUID.
- `company_name`: seller company display name.
- `status`: `pending`, `active`, or `suspended`.
- `plan`: subscription plan placeholder.
- `created_at`: tenant creation time.
- `approved_at`: admin approval time.

#### `sellers`

Stores Amazon seller connection details.

Important columns:

- `tenant_id`: owner tenant.
- `amazon_seller_id`: Amazon seller ID.
- `marketplace_id`: Amazon marketplace ID.
- `refresh_token_encrypted`: encrypted Amazon LWA refresh token.
- `connected_at`: connection time.

#### `sync_jobs`

Stores every sync attempt.

Important columns:

- `report_type`: report or sync type.
- `status`: `running`, `completed`, or `failed`.
- `started_at` / `completed_at`.
- `error_message`.
- `s3_key`: raw report storage key. This may also contain a `local://...` URI after the local fallback.

#### `orders`

Stores order-level totals.

#### `settlement_rows`

Stores parsed settlement report rows.

#### `gst_invoices`

Stores GST B2B/B2C invoice rows.

#### `returns`

Stores FBA customer return report rows.

#### `reimbursements`

Stores reimbursement rows from reports or direct finance fallback.

#### `inventory_snapshots`

Stores SKU-level fulfillable inventory snapshots by date.

#### `sales_traffic_daily`

Stores ASIN/date sales and traffic metrics from Sales & Traffic reports.

#### `fee_leak_flags`

Reserved for fee leakage detection.

#### `generated_reports`

Reserved for generated narrative/report output.

The migration also enables row-level security for tenant tables.

### 7.2 `002_fix_users_rls.sql`

This migration adjusts user table row-level-security behavior. It is meant to make auth/admin access workable while preserving tenant isolation for seller-owned records.

### 7.3 `003_amazon_auth_metadata.sql`

This migration adds Amazon authorization metadata columns, such as seller region/auth status/token refresh metadata.

### 7.4 `004_force_tenant_data_rls.sql`

This migration forces row-level security on tenant data tables so even table owners must respect tenant isolation in normal queries.

## 8. SP-API client package: `packages/sp-api-client`

### 8.1 Constants

#### `SP_API_BASE_URL`

Default SP-API endpoint. Currently points to the EU endpoint.

#### `INDIA_MARKETPLACE_ID`

Default marketplace ID for Amazon India: `A21TJRUUN4KGV`.

#### `MARKETPLACES`

Maps marketplace IDs to:

- Country.
- Region.
- SP-API endpoint.
- Seller Central host.

Supported marketplace examples:

- India.
- United States.
- United Kingdom.

#### `REPORT_TYPES`

Allowed report types for sync endpoints. Important examples:

- `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`.
- `GET_GST_MTR_B2B_CUSTOM`.
- `GET_GST_MTR_B2C_CUSTOM`.
- `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA`.
- `GET_FBA_REIMBURSEMENTS_DATA`.
- `GET_SALES_AND_TRAFFIC_REPORT`.
- `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA`.

### 8.2 `getSpApiEndpoint(marketplaceId)`

Returns the correct SP-API endpoint for a marketplace. If the marketplace is unknown, it falls back to the default endpoint.

### 8.3 `SpApiClient`

This class wraps Amazon SP-API calls.

#### Constructor

```js
new SpApiClient(refreshToken, cfg)
```

Inputs:

- `refreshToken`: Amazon LWA refresh token.
- `cfg.clientId`: LWA client ID.
- `cfg.clientSecret`: LWA client secret.
- `cfg.baseUrl`: SP-API endpoint.

It stores an access-token cache so every call does not have to refresh the token.

#### `getAccessToken()`

Exchanges the refresh token for an LWA access token.

Important behavior:

- Reuses cached token until it is close to expiry.
- Calls `https://api.amazon.com/auth/o2/token`.
- Throws if token exchange fails.

#### `request(path, init, token)`

Generic SP-API request helper.

Important behavior:

- Adds `x-amz-access-token`.
- Uses JSON content type by default.
- Retries `429` and `503` responses with backoff.
- Refreshes the access token between retry attempts when needed.

#### `restrictedDataToken(documentId)`

Requests a Restricted Data Token for GST reports that require tax invoice access.

#### `fetchReport(reportType, tenantId, range, marketplaceId)`

Full Reports API workflow:

1. Validates report type, tenant ID, and date range.
2. Creates the report.
3. If create returns `400`, retries without `dataStartTime` and `dataEndTime`.
4. Polls report status until `DONE`.
5. Handles `CANCELLED` and `FATAL` statuses.
6. Looks up the report document.
7. Downloads the document.
8. Decompresses GZIP content when needed.
9. Returns raw text content and report metadata.

#### `estimateListingFees(sellerSku, body)`

Calls the Product Fees API to estimate fees for a listing.

#### `listOrders(createdAfter, marketplaceId)`

Calls Orders API for orders created after a timestamp.

#### `listOrdersByNextToken(nextToken)`

Fetches the next Orders API page.

#### `listOrderItems(orderId)`

Fetches line items for an Amazon order.

#### `listInventorySummaries(marketplaceId)`

Calls FBA Inventory API summaries for the marketplace. The direct sync uses this to populate `inventory_snapshots` when inventory report sync fails or is unavailable.

#### `listFinanceTransactions(postedAfter)`

Calls the Finance Transactions API for transactions posted after a timestamp.

## 9. Ads API package: `packages/ads-api-client`

This is currently a placeholder package.

### `AdsApiClient`

#### `listCampaignMetrics()`

Returns an empty validated array. It is a stub for future Amazon Ads integration.

The README says Ads API is intentionally deferred in this phase.

## 10. API app: `apps/api`

### 10.1 `apps/api/package.json`

Defines the API package.

Important scripts:

- `dev`: starts `src/server.js` with `node --watch`.
- `start`: starts `src/server.js` normally.
- `check`: syntax-checks `src/server.js`.

Important dependencies:

- `fastify`: HTTP server.
- `@fastify/cors`: CORS.
- `@fastify/jwt`: JWT auth.
- `@fastify/rate-limit`: rate limiting.
- `zod`: validation.
- `pg` through `@recon/db`.
- `@aws-sdk/client-s3`: raw report upload.
- `node-cron`: nightly sync scheduling.
- `p-limit`: concurrency limiting for scheduled jobs.

### 10.2 `apps/api/src/config/secrets.js`

Loads `.env` using `dotenv.config()` and exports a `secrets` object.

Important fields:

- `lwaClientId`: Amazon LWA client ID.
- `lwaClientSecret`: Amazon LWA client secret.
- `spApiAppId`: Amazon SP-API application ID.
- `redirectUri`: OAuth callback URL.
- `jwtSecret`: JWT signing secret.
- `tokenEncryptionKey`: key material for token encryption.
- `frontendOrigin`: allowed frontend origin for CORS and redirects.
- `s3Bucket`: optional bucket for raw reports.
- `s3Region`: S3 region.
- `localReportDir`: local fallback folder for raw reports.

### 10.3 `apps/api/src/config/crypto.js`

Handles encryption and decryption of sensitive secrets, especially Amazon refresh tokens.

Expected purpose:

- `encryptSecret(value)`: encrypts text before storing in DB.
- `decryptSecret(value)`: decrypts text from DB before using it with Amazon.

The API uses these helpers when saving seller auth and when creating an `SpApiClient`.

### 10.4 `apps/api/src/storage/s3.js`

Stores raw downloaded report files.

#### `RawReportSchema`

Validates:

- `tenantId` as UUID.
- `reportType` as non-empty string.
- `reportId` as non-empty string.
- `content` as string.

#### `safePathSegment(value)`

Sanitizes report path segments for local file storage. This prevents unsafe path characters from being used in filenames or folders.

#### `putLocalRawReport(params)`

Writes raw report text to local disk under:

```text
storage/raw-reports/<tenantId>/<reportType>/<reportId>-<timestamp>.txt
```

Returns a `local://...` URI relative to the current working directory.

#### `putRawReport(params)`

Main storage function.

Behavior:

1. Validates input.
2. Builds an S3 key.
3. If `S3_BUCKET` is missing or placeholder, writes locally.
4. If S3 upload succeeds, returns S3 key.
5. If S3 upload fails, writes locally instead.

This prevents report sync from failing only because S3 is not configured.

### 10.5 `apps/api/src/jobs/runner.js`

Contains a tiny retry wrapper.

#### `runJob(jobName, fn, attempts = 3)`

Behavior:

- Runs an async job.
- Retries on failure.
- Uses exponential backoff.
- Throws the final error with `jobName` attached.

This is intentionally small so it can later be replaced by SQS, BullMQ, or another queue.

### 10.6 `apps/api/src/jobs/sync.js`

This is the core sync/import file.

#### High-level responsibilities

- Schedule nightly report syncs.
- Fetch Amazon reports.
- Parse report documents.
- Import rows into Postgres.
- Run direct SP-API sync.
- Save sync job status.

#### Constants and schemas

##### `NIGHTLY_REPORTS`

All allowed report types from `REPORT_TYPES`.

##### `SyncParamsSchema`

Validates sync input:

- `tenantId` UUID.
- `reportType` enum.
- Optional date range.

##### `ReportRowSchema`

Allows parsed report rows as records with string keys.

#### Utility functions

##### `text(value)`

Converts any value to a trimmed string. Empty values become `undefined`.

##### `number(value)`

Converts strings/numbers to numeric values. Removes characters like commas and currency symbols.

##### `integer(value)`

Converts value to a truncated integer using `number()`.

##### `pick(row, names)`

Flexible field picker. It normalizes keys by lowercasing and removing non-alphanumeric characters. This lets the parser handle Amazon reports with different column styles such as:

- `order-id`
- `order id`
- `amazonOrderId`

##### `parseTsv(textContent)`

Parses tab-separated report text into row objects.

##### `flattenObjectRow(object)`

Flattens one nested object level so nested JSON report fields become easier to pick.

##### `collectObjectRows(value)`

Recursively collects object rows from arrays or nested report JSON.

##### `parseReportRows(reportType, content)`

Parses report content. Supports:

- JSON arrays.
- JSON objects.
- TSV files.

For Sales & Traffic reports, it filters rows to those with date/ASIN fields.

#### Report import functions

##### `saveSettlementRows(tenantId, content)`

Imports settlement report rows into `settlement_rows`.

Fields imported:

- Settlement ID.
- Order ID.
- Amount type.
- Amount description.
- Amount.
- Posted date.
- Raw row JSON.

##### `saveGstInvoices(tenantId, content, invoiceType)`

Imports B2B/B2C GST invoices into `gst_invoices`.

Fields imported:

- Invoice type.
- Order ID.
- CGST.
- SGST.
- IGST.
- Taxable value.
- Invoice date.

##### `saveReturns(tenantId, content)`

Imports FBA customer returns into `returns`.

Fields imported:

- Order ID.
- Return reason.
- Disposition.
- Status.
- Return date.

##### `saveReimbursements(tenantId, content)`

Imports reimbursement report rows into `reimbursements`.

Fields imported:

- Amount.
- Reason.
- SKU.
- Reimbursement date.

##### `saveInventorySnapshots(tenantId, content)`

Imports FBA inventory report rows into `inventory_snapshots`.

Fields imported:

- SKU.
- Fulfillable quantity.
- Snapshot date.

##### `saveSalesTrafficDaily(tenantId, content)`

Imports Sales & Traffic report rows into `sales_traffic_daily`.

Fields imported:

- Date.
- ASIN.
- Sessions.
- Page views.
- Units ordered.
- Ordered product sales.
- Featured offer percentage / buy box.
- Units refunded.
- Shipped product sales.

##### `saveStructuredRows(tenantId, reportType, content)`

Dispatches report content to the correct import function based on `reportType`.

#### `syncReportForTenant(params)`

Main report sync function.

Flow:

1. Validate params.
2. Default date range to the last 30 days.
3. Confirm tenant is active.
4. Insert `sync_jobs` row as `running`.
5. Load latest authorized seller.
6. Create an `SpApiClient` with decrypted refresh token.
7. Fetch report.
8. Store raw report with `putRawReport()`.
9. Parse and save rows with `saveStructuredRows()`.
10. Mark job `completed`.
11. On failure, mark job `failed` and throw.

#### `syncRecentApiDataForTenant(tenantId, options)`

Direct SP-API sync function.

Flow:

1. Validate tenant ID.
2. Calculate `createdAfter` based on requested days, defaulting to 30.
3. Confirm tenant is active.
4. Insert `sync_jobs` row as `DIRECT_SP_API_SYNC` and `running`.
5. Load authorized seller.
6. Create `SpApiClient`.
7. Fetch order pages.
8. Fetch finance transactions.
9. Fetch inventory summaries.
10. Import orders.
11. Import order items.
12. Import inventory snapshots.
13. Import finance transactions.
14. Derive reimbursement rows from finance transactions where transaction type includes reimbursement.
15. Mark job `completed`.
16. Return import counts and warnings.

Returned counts include:

- `ordersImported`.
- `transactionsImported`.
- `inventoryImported`.
- `reimbursementsImported`.

Returned warnings may include:

- `financeWarning`.
- `inventoryWarning`.

#### `syncActiveTenants(reportType)`

Used by the scheduler. It syncs a given report type for all active tenants with concurrency limiting.

#### `startScheduler()`

Runs nightly report syncs using cron at `0 2 * * *`.

## 11. API server: `apps/api/src/server.js`

This is the main backend entrypoint.

### 11.1 Server setup

Creates a Fastify app with:

- Logger redaction for tokens/passwords.
- CORS.
- Rate limiting.
- JWT support.
- Central error handler.

### 11.2 Validation schemas

Important schemas:

- `TenantParamsSchema`: validates tenant UUID route params.
- `SyncParamsSchema`: validates tenant/report sync route params.
- `AmazonCallbackSchema`: validates Amazon OAuth callback query.
- `AmazonAccessTokenSchema`: validates optional seller token query.
- `SellerSyncSchema`: validates bulk/direct sync body.
- `RegisterSchema`: validates admin-created seller accounts.
- `LoginSchema`: validates login.

### 11.3 Auth helpers

#### `hashPassword(password, salt)`

Creates a PBKDF2 password hash.

#### `verifyPassword(password, stored)`

Verifies login password against stored PBKDF2 hash.

#### `requireAuth(request)`

Requires a valid JWT.

#### `requireAdmin(request)`

Requires JWT and admin role.

#### `requireTenantUser(request, tenantId)`

Allows admins or users belonging to the requested tenant.

### 11.4 Amazon OAuth helpers

#### `signAmazonState(payload)`

Signs the OAuth state payload using HMAC so callbacks cannot be forged.

#### `verifyAmazonState(state)`

Verifies state signature and expiry.

#### `amazonConsentHost(marketplaceId)`

Returns the correct Seller Central host.

#### `exchangeAmazonCode(code)`

Exchanges OAuth authorization code for Amazon LWA tokens.

### 11.5 Tenant/data schema helpers

#### `TENANT_DATA_TABLES`

List of tenant-owned data tables that should have row-level security enabled.

#### `ensureSellerAuthSchema()`

Adds/ensures seller auth metadata columns and indexes.

#### `ensureTenantDataIsolationSchema()`

Enables and forces row-level security for tenant-owned tables.

### 11.6 Error handling

#### `normalizeDatabaseError(error)`

Converts database errors into user-friendly HTTP errors, including:

- Missing migrations.
- Duplicate account email.
- RLS blocked query.
- Database unavailable.

#### Global error handler

Converts thrown errors into JSON responses. Internal errors are hidden as `Internal server error`.

### 11.7 Auth routes

#### `GET /health`

Health check.

#### `POST /api/auth/register-seller`

Admin-only route to create seller tenant and first login user.

#### `POST /api/auth/login`

Logs in a user/admin and returns JWT.

#### `GET /api/auth/me`

Returns current JWT user.

#### `POST /api/dev/bootstrap`

Creates a demo seller tenant for development/testing.

### 11.8 Amazon connection routes

#### `GET /api/auth/amazon/start`

Starts Amazon authorization.

#### `GET|POST /api/auth/amazon/callback`

Handles Amazon callback, stores encrypted refresh token, activates tenant if needed, and queues initial sync.

#### `GET|POST /oauth/callback`

Alias callback route.

#### `GET /api/tenants/:tenantId/amazon/access-token`

Returns a short-lived SP-API access token for an authorized tenant seller.

### 11.9 Admin routes

#### `GET /api/admin/tenants`

Lists tenants and their seller connection metadata.

#### `POST /api/admin/tenants/:tenantId/grant-access`

Marks tenant active.

#### `POST /api/admin/tenants/:tenantId/reject`

Marks tenant suspended.

#### `POST /api/admin/tenants/:tenantId/revoke-access`

Marks tenant suspended.

#### `POST /api/admin/tenants/:tenantId/sync/:reportType`

Admin-triggered report sync.

### 11.10 Seller sync routes

#### `POST /api/tenants/:tenantId/sync/:reportType`

Tenant-triggered report sync.

Important fallback behavior:

- First tries report sync.
- If report sync fails for settlement, sales/traffic, inventory, or reimbursement reports, it tries direct SP-API sync.
- If direct fallback succeeds, returns `status: completed`, `fallback: DIRECT_SP_API_SYNC`, and the original report error as `warning`.
- If fallback also fails, returns the original report failure.

#### `POST /api/tenants/:tenantId/sync`

Runs direct SP-API sync first, then any requested report types.

If called with:

```json
{ "reportTypes": [] }
```

it only runs direct sync.

### 11.11 Dashboard route

#### `GET /api/tenants/:tenantId/dashboard`

Builds all dashboard data in one response.

Important sections:

##### Seller status

Returns connected/disconnected Amazon seller state.

##### KPIs

Calculates settlement totals, earnings, and deductions.

##### Orders

Counts orders and sums order value.

##### Products

Merges:

- `sales_traffic_daily` ASIN data.
- `order_items` ASIN data.

This lets Product Performance populate even if Sales & Traffic reports fail.

##### Trend

Merges:

- `sales_traffic_daily` date metrics.
- `orders` and `order_items` date totals.

This lets Sales Trend populate from orders if traffic reports fail.

##### Payments

Uses settlement rows when available. If settlement rows are not available, falls back to finance transactions.

##### Other returned arrays

- `jobs`.
- `inventory`.
- `returns`.
- `reimbursements`.
- `invoices`.
- `orderItems`.
- `financeTransactions`.

### 11.12 Backward-compatible endpoints

#### `GET /api/tenants/:tenantId/summary`

Returns summary metrics for older clients.

There may also be other legacy report endpoints below the dashboard route, depending on the remaining file content.

## 12. Web app: `apps/web`

### 12.1 `apps/web/package.json`

Defines the frontend package.

Important scripts:

- `dev`: starts Vite.
- `build`: builds production frontend.
- `preview`: previews production build.

Important dependencies:

- React.
- React DOM.
- React Router DOM.
- Recharts.
- Vite.

### 12.2 `apps/web/index.html`

HTML entrypoint for Vite. It mounts the React app.

### 12.3 `apps/web/src/App.jsx`

This is the entire React application.

#### API config

`API` comes from `VITE_API_URL` or defaults to `http://localhost:4000`.

#### `REPORTS`

Defines sync ledger rows shown in the UI.

Current rows:

- `DIRECT_SP_API_SYNC`: Orders & finance.
- `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`: Settlements.
- `GET_SALES_AND_TRAFFIC_REPORT`: Sales & traffic.
- `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA`: Inventory.
- `GET_FBA_REIMBURSEMENTS_DATA`: Reimbursements.
- `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA`: Customer returns.

#### `VIEW_REPORT_TYPES`

Maps sidebar views to sync rows.

Examples:

- Sales uses Sales & Traffic report.
- Inventory uses Inventory report.
- Payouts uses Direct Sync and Settlements.
- Brand uses Direct Sync.
- Health uses Reimbursements and Returns.
- Reports shows all rows.

#### `VIEW_LEDGER_COPY`

Controls the title/subtitle of the sync ledger per page.

#### `authHeaders()`

Reads JWT from `localStorage` and creates Authorization header.

#### `jsonHeaders(options)`

Builds request headers, including content type when needed.

#### `api(path, options)`

Shared fetch wrapper. Throws an error when HTTP response is not OK.

#### Amazon token cache helpers

The app can cache Amazon SP-API access tokens in `localStorage` by tenant ID.

### 12.4 UI components in `App.jsx`

#### `MiniMetric`

Small metric card used on dashboard top strip.

#### `StatCard`

General stat card.

#### `Card`

Reusable panel container.

#### `Button`

Reusable button component.

#### `Empty`

Empty-state box used when a table/chart has no rows.

#### `LoginScreen`

Login form and session creation.

#### `AmazonConnectionPanel`

Handles Amazon connection UI and calls the Amazon start/access token endpoints.

#### `SyncLedger`

The sync control panel.

Important behavior:

- Filters report rows by current page.
- For normal report types, calls `/api/tenants/:tenantId/sync/:reportType`.
- For `DIRECT_SP_API_SYNC`, calls `/api/tenants/:tenantId/sync` with `reportTypes: []`.
- Displays `idle`, `running`, `completed`, or `failed` status.
- Shows last synced timestamps from `sync_jobs`.

#### `SellerDashboard`

Main seller UI after login.

Important behavior:

- Reads `tenantId` and `view` from URL query params.
- Loads dashboard data.
- Auto-syncs dashboard once per session after Amazon is connected.
- Renders the right page based on `view`.

Supported views:

- `dashboard`.
- `sales`.
- `inventory`.
- `payouts`.
- `brand`.
- `health`.
- `reports`.

#### `DashboardOverview`

Top-level dashboard view.

Shows:

- Total revenue.
- Units sold.
- Average order value.
- Orders.
- Sales analytics.
- Payment settlements.
- Recent sync jobs.

#### `SalesAnalytics`

Shows:

- Sales source distribution pie chart.
- Sales trend area chart.
- Product Performance table.
- Order Items table.

#### `PanelHeader`

Reusable panel header with date range label.

#### `Legend`

Pie chart legend.

#### `TableCard`

Reusable table card.

#### `AdminDashboard`

Admin-only UI.

Shows:

- Tenant list.
- Tenant approval/rejection/revocation actions.
- Create seller account form.

#### Layout components

The lower part of `App.jsx` defines app layout, sidebar, routes, and navigation links.

### 12.5 `apps/web/src/style.css`

Contains the app styling, including:

- Layout.
- Cards.
- Tables.
- Buttons.
- Alerts.
- Sync ledger.
- Charts.
- Login/admin/seller dashboard visuals.

### 12.6 Tailwind/PostCSS files

`tailwind.config.js` and `postcss.config.js` are present, but the app mostly uses custom CSS from `style.css`.

## 13. Important business concepts

### 13.1 Tenant

A tenant is one seller business. Most data tables include `tenant_id`.

### 13.2 Seller

A seller row connects a tenant to Amazon SP-API credentials.

### 13.3 Admin approval

Seller tenants must be active before tenant APIs allow access.

### 13.4 Direct sync vs report sync

#### Direct sync

Uses API endpoints that immediately return JSON.

Pros:

- Faster.
- Good fallback.
- Useful when reports fail because of permissions or date constraints.

Cons:

- May not contain every specialized report field.

#### Report sync

Uses Amazon Reports API.

Pros:

- More complete for specialized reports.
- Needed for GST, returns, sales/traffic sessions, buy box metrics, etc.

Cons:

- Can fail due permissions.
- Can fail due date range requirements.
- Requires async polling.
- Requires raw storage.

### 13.5 Raw report storage

Raw reports are stored for audit/debugging. The app tries S3 first but can write local files.

### 13.6 Row-level security

Tenant data isolation relies on Postgres RLS and `app.current_tenant_id` session variable.

## 14. Dashboard data sources by page

### 14.1 Dashboard

Uses:

- `orders`.
- `order_items`.
- `sales_traffic_daily`.
- `settlement_rows`.
- `finance_transactions`.
- `sync_jobs`.

### 14.2 Sales Analytics

Uses:

- `sales_traffic_daily` when available.
- `orders` and `order_items` fallback.

### 14.3 Inventory

Uses:

- `inventory_snapshots`.

Can be populated by:

- Inventory report sync.
- Direct FBA Inventory Summaries fallback.

### 14.4 Payout Reconciliation

Uses:

- `settlement_rows` when available.
- `finance_transactions` fallback.

### 14.5 Brand Analytics

Uses:

- `order_items` for ASIN product performance.
- `sales_traffic_daily` for traffic/buy-box metrics when available.

### 14.6 Account Health

Uses:

- `returns`.
- `reimbursements`.

### 14.7 Reports

Uses:

- `gst_invoices`.
- `sync_jobs`.
- Sync ledger rows.

## 15. Common errors and what they mean

### 15.1 `Create report failed: 400`

Amazon rejected the report creation request. Common causes:

- Report type does not accept the provided date range.
- Marketplace/report combination is invalid.
- Report request parameters are not supported.

The client now retries report creation without date range for `400` responses.

### 15.2 `Create report failed: 403`

Amazon rejected the request due authorization/permissions.

Common causes:

- Seller has not granted the required role.
- App is not authorized for that report.
- Marketplace/account does not support the report.

For key sections, the API now tries direct sync fallback.

### 15.3 S3 bucket error

If S3 is missing or fails, raw reports are stored locally instead.

### 15.4 Empty dashboard sections

Possible causes:

- Seller not connected.
- Tenant not active.
- Sync job failed.
- Amazon account lacks permission for that report.
- Direct sync completed but Amazon returned no data for the date window.

## 16. How to run locally

### 16.1 Install dependencies

```bash
npm install
```

### 16.2 Run migrations

```bash
for file in packages/db/migrations/*.sql; do psql "$DATABASE_URL" -f "$file"; done
```

### 16.3 Start development servers

```bash
npm run dev
```

### 16.4 API only

```bash
npm run dev:api
```

### 16.5 Web only

```bash
npm run dev:web
```

### 16.6 Syntax check

```bash
npm run check
```

## 17. Suggested future improvements

### 17.1 Move hardcoded database URL to environment variable

`packages/db/src/index.js` currently contains a hardcoded database URL. This should be changed to use `process.env.DATABASE_URL`.

### 17.2 Add automated tests

The repository currently has syntax checks but no comprehensive test suite. Useful tests would include:

- Auth route tests.
- Tenant isolation tests.
- Report parser tests.
- Sync fallback tests.
- Dashboard query tests.

### 17.3 Split `App.jsx`

`App.jsx` contains most of the frontend. It could be split into:

- `api.js`.
- `components/`.
- `pages/`.
- `layouts/`.
- `constants/reports.js`.

### 17.4 Add structured logging for fallback sync

The API returns fallback warnings, but structured logs would help debug Amazon report failures.

### 17.5 Add user-facing warning details

The frontend could display fallback warnings separately from hard failures.

### 17.6 Add pagination

Tables currently return limited rows. Larger sellers will need pagination/filtering.

### 17.7 Harden secret management

Use environment variables and managed secrets for production. Avoid committing credentials or real connection strings.

## 18. Quick mental model for new developers

If you want to understand the whole app quickly, follow this path:

1. Start with `apps/web/src/App.jsx` to see what the user clicks.
2. Follow API calls into `apps/api/src/server.js`.
3. For dashboard data, inspect the `/api/tenants/:tenantId/dashboard` route.
4. For sync behavior, inspect `apps/api/src/jobs/sync.js`.
5. For Amazon calls, inspect `packages/sp-api-client/src/index.js`.
6. For database context/RLS, inspect `packages/db/src/index.js` and migrations.
7. For raw report storage, inspect `apps/api/src/storage/s3.js`.

## 19. Glossary

- **SP-API**: Amazon Selling Partner API.
- **LWA**: Login With Amazon, Amazon's OAuth system.
- **Tenant**: A seller business account in this app.
- **Seller**: Amazon seller credentials connected to a tenant.
- **RLS**: Row-Level Security in Postgres.
- **Report sync**: Amazon Reports API workflow, including create/poll/download.
- **Direct sync**: Immediate JSON API sync from Orders, Finance, and Inventory endpoints.
- **S3 key**: Path to raw report in S3.
- **Local raw report**: Local fallback file when S3 is unavailable.
- **Settlement**: Amazon payout batch/fee report data.
- **Sales & Traffic**: Amazon business report with sessions, units, sales, buy box, etc.
- **Inventory snapshot**: SKU fulfillable quantity captured on a date.
