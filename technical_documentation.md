Technical Documentation: Payment Reconciliation Tool

1. What this project is

This repository is a plain JavaScript monorepo for an Amazon seller reconciliation and business intelligence tool. It connects to Amazon Seller Central through Amazon SP-API, stores synced seller data in Postgres, and displays operational dashboards in a React web app.

The app is built around these business areas:

Seller onboarding and login.

Admin approval of seller tenants.

Amazon OAuth connection.

Direct SP-API sync for orders, order items, finance transactions, inventory summaries, and reimbursement-like finance events.

Report-based SP-API sync for settlements, GST reports, returns, reimbursements, inventory, and sales/traffic.

Dashboard analytics for revenue, orders, product performance, trends, inventory, payouts, reports, returns, and reimbursements.

Raw report storage in S3, with a local disk fallback when S3 is missing or fails.

2. Monorepo layout

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

3. Root files

3.1 package.json

The root package.json defines the monorepo workspaces and main commands.

Important fields:

workspaces: includes apps/* and packages/*, so npm installs dependencies for the API, web app, and shared packages together.

scripts.dev: runs API and web at the same time using concurrently.

scripts.dev:api: starts only the Fastify API.

scripts.dev:web: starts only the Vite web app.

scripts.start: starts the API.

scripts.check: syntax-checks the backend and shared JavaScript files using node --check.

The root project is private and not intended to be published as an npm package.

3.2 package-lock.json

This locks exact dependency versions. The repository uses npm, not pnpm or yarn, based on the committed lockfile and scripts.

3.3 README.md

The README gives the quick-start flow:

Configure environment variables.

Run database migrations.

Install dependencies.

Start API and web.

Use admin/seller flows to connect Amazon and sync data.

4. Application architecture

The system has four main layers:

React Web App
    ↓ HTTP / JSON
Fastify API
    ↓ shared packages
Postgres + Amazon SP-API + S3/local raw report storage

4.1 Frontend layer

The frontend is apps/web. It is a Vite React single-page app. It handles:

Login UI.

Admin dashboard.

Seller dashboard.

Sync buttons.

Tables and charts.

Amazon connection actions.

4.2 API layer

The backend is apps/api. It handles:

Auth.

Tenant access checks.

Amazon OAuth start/callback.

Dashboard JSON endpoints.

Sync endpoints.

Admin tenant management.

Scheduler startup.

4.3 Shared database layer

The database package is packages/db. It exports:

A shared Postgres pool.

withTenant() to run queries under a row-level-security tenant context.

assertActiveTenant() to block inactive tenants.

4.4 Amazon SP-API layer

The SP-API client package is packages/sp-api-client. It owns:

LWA token refresh.

Generic SP-API requests.

Conservative per-family SP-API request limiting to avoid hammering seller/account quotas.

Reports API create/poll/download flow.

Orders API calls.

Order Items API calls.

Finance API calls.

FBA Inventory API calls.

Fees estimation helper.

4.5 Storage layer

Raw report payloads are stored through apps/api/src/storage/s3.js. It tries S3 first when configured and falls back to local files if S3 is not usable.

5. Data flow overview

5.1 Seller connects Amazon

User logs into the web app.

User clicks Amazon connection.

Frontend calls /api/auth/amazon/start.

API creates a signed state value and redirects to Seller Central consent.

Amazon redirects back to /api/auth/amazon/callback or /oauth/callback.

API exchanges the OAuth code for refresh/access tokens.

API stores the refresh token encrypted in the sellers table.

API queues initial syncs.

5.2 Direct SP-API sync

Direct sync is triggered by POST /api/tenants/:tenantId/sync.

It imports:

Orders into orders.

Order items into order_items.

Finance transactions into finance_transactions.

Inventory summaries into inventory_snapshots.

Reimbursement-like finance events into reimbursements.

This direct sync is used as a fallback when Amazon report creation fails.

5.3 Report sync

Report sync is triggered by POST /api/tenants/:tenantId/sync/:reportType.

The flow is:

Validate tenant and report type.

Create a row in sync_jobs with running status.

Fetch the report through SP-API Reports API.

Store the raw payload in S3 or locally.

Parse and import rows into the correct database table.

Mark the job completed or failed.

If key report types fail, the API attempts direct sync fallback and returns a completed fallback response.

5.4 Dashboard load

The web app calls GET /api/tenants/:tenantId/dashboard.

The API returns:

Seller connection status.

KPIs.

Order totals.

Product performance.

Sales trend.

Payments/payout activity.

Recent sync jobs.

Inventory.

Returns.

Reimbursements.

GST invoices.

Order items.

Finance transactions.

Financial dashboard calculations use one source per purpose:

Product sales, refunds, and promotions use item-level Finances or settlement components.

Amazon Account Activity sections use the nested Finances v2024-06-19 breakdown ancestry (Sales, Expenses, Refunds, GST, and Tax). sellingPartnerMetadata.accountType is account metadata such as Standard Orders; it is not an Income/Expenses classifier.

A complete settlement statement takes precedence over Finances item rows. An incomplete settlement import falls back to Finances.

Returns can be zero only when sync_jobs.coverage_complete proves that the selected range was fully imported; otherwise return quantity and return rate remain unavailable.

Date-only report tables are filtered in the connected marketplace's time zone.

6. Database package: packages/db

6.1 packages/db/src/index.js

This file creates and exports the shared Postgres connection.

databaseUrl

The current file contains a hardcoded Postgres connection string. Technically it should usually come from process.env.DATABASE_URL for safety and portability. In the current code, databaseUrlConfigured checks whether the string is present and not the placeholder value.

pool

pool is a pg.Pool. All API and sync code uses this pool or a tenant-scoped client from withTenant().

withTenant(tenantId, fn)

Purpose:

Checks out a Postgres client.

Sets app.current_tenant_id in the session.

Runs the callback.

Clears the tenant setting.

Releases the client.

This matters because database tables use row-level security policies that compare tenant_id to the current Postgres setting.

assertActiveTenant(tenantId)

Purpose:

Looks up the tenant status.

Allows only active tenants.

Throws a 403 error if the tenant is pending, suspended, or missing.

This prevents inactive seller accounts from syncing or viewing data.

7. Database migrations

7.1 001_init.sql

Creates the initial schema.

Important tables:

tenants

Represents seller companies/accounts.

Important columns:

id: tenant UUID.

company_name: seller company display name.

status: pending, active, or suspended.

plan: subscription plan placeholder.

created_at: tenant creation time.

approved_at: admin approval time.

sellers

Stores Amazon seller connection details.

Important columns:

tenant_id: owner tenant.

amazon_seller_id: Amazon seller ID.

marketplace_id: Amazon marketplace ID.

refresh_token_encrypted: encrypted Amazon LWA refresh token.

connected_at: connection time.

sync_jobs

Stores every sync attempt.

Important columns:

report_type: report or sync type.

status: running, completed, or failed.

started_at / completed_at.

error_message.

s3_key: raw report storage key. This may also contain a local://... URI after the local fallback.

data_start_time / data_end_time: the effective range Amazon says the completed report covers.

rows_imported: number of parsed report rows.

coverage_complete: true only when the effective report range fully covers the requested range. The dashboard uses this to distinguish a genuine zero-return result from missing Returns-report coverage.

orders

Stores order-level totals.

settlement_rows

Stores parsed settlement report rows.

gst_invoices

Stores GST B2B/B2C invoice rows.

returns

Stores FBA customer return report rows.

reimbursements

Stores reimbursement rows from reports or direct finance fallback.

inventory_snapshots

Stores SKU-level fulfillable inventory snapshots by date.

sales_traffic_daily

Stores ASIN/date sales and traffic metrics from Sales & Traffic reports.

fee_leak_flags

Reserved for fee leakage detection.

generated_reports

Reserved for generated narrative/report output.

The migration also enables row-level security for tenant tables.

7.2 002_fix_users_rls.sql

This migration adjusts user table row-level-security behavior. It is meant to make auth/admin access workable while preserving tenant isolation for seller-owned records.

7.3 003_amazon_auth_metadata.sql

This migration adds Amazon authorization metadata columns, such as seller region/auth status/token refresh metadata.

7.4 004_force_tenant_data_rls.sql

This migration forces row-level security on tenant data tables so even table owners must respect tenant isolation in normal queries.

8. SP-API client package: packages/sp-api-client

8.1 Constants

SP_API_BASE_URL

Default SP-API endpoint. Currently points to the EU endpoint.

INDIA_MARKETPLACE_ID

Default marketplace ID for Amazon India: A21TJRUUN4KGV.

MARKETPLACES

Maps marketplace IDs to:

Country.

Region.

SP-API endpoint.

Seller Central host.

Supported marketplace examples:

India.

United States.

United Kingdom.

REPORT_TYPES

Allowed report types for sync endpoints. Important examples:

GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2.

GET_GST_MTR_B2B_CUSTOM.

GET_GST_MTR_B2C_CUSTOM.

GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA.

GET_FBA_REIMBURSEMENTS_DATA.

GET_SALES_AND_TRAFFIC_REPORT.

GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA.

8.2 getSpApiEndpoint(marketplaceId)

Returns the correct SP-API endpoint for a marketplace. If the marketplace is unknown, it falls back to the default endpoint.

8.3 SpApiClient

This class wraps Amazon SP-API calls.

Constructor

new SpApiClient(refreshToken, cfg)

Inputs:

refreshToken: Amazon LWA refresh token.

cfg.clientId: LWA client ID.

cfg.clientSecret: LWA client secret.

cfg.baseUrl: SP-API endpoint.

It stores an access-token cache so every call does not have to refresh the token.

getAccessToken()

Exchanges the refresh token for an LWA access token.

Important behavior:

Reuses cached token until it is close to expiry.

Calls https://api.amazon.com/auth/o2/token.

Throws if token exchange fails.

request(path, init, token)

Generic SP-API request helper.

Important behavior:

Adds x-amz-access-token.

Uses JSON content type by default.

Waits for a conservative per-API-family rate-limit slot before each SP-API request.

Uses slower default spacing for Reports, Finance, Inventory, Tokens, Orders, and Fees calls so sync jobs do not aggressively hit Amazon quotas.

Retries 429 and 503 responses with backoff.

Refreshes the access token between retry attempts when needed.

restrictedDataToken(documentId)

Requests a Restricted Data Token for GST reports that require tax invoice access.

fetchReport(reportType, tenantId, range, marketplaceId)

Full Reports API workflow:

Validates report type, tenant ID, and date range.

Creates the report.

If create returns 400, retries without dataStartTime and dataEndTime.

Polls report status until DONE.

Handles CANCELLED and FATAL statuses.

Looks up the report document.

Downloads the document.

Decompresses GZIP content when needed.

Returns raw text content and report metadata.

estimateListingFees(sellerSku, body)

Calls the Product Fees API to estimate fees for a listing.

listOrders(createdAfter, marketplaceId)

Calls Orders API for orders created after a timestamp.

listOrdersByNextToken(nextToken)

Fetches the next Orders API page.

listOrderItems(orderId)

Fetches line items for an Amazon order.

listInventorySummaries(marketplaceId)

Calls FBA Inventory API summaries for the marketplace. The direct sync uses this to populate inventory_snapshots when inventory report sync fails or is unavailable.

listFinanceTransactions(postedAfter)

Calls the Finance Transactions API for transactions posted after a timestamp.

9. Ads API package: packages/ads-api-client

This is currently a placeholder package.

AdsApiClient

listCampaignMetrics()

Returns an empty validated array. It is a stub for future Amazon Ads integration.

The README says Ads API is intentionally deferred in this phase.

10. API app: apps/api

10.1 apps/api/package.json

Defines the API package.

Important scripts:

dev: starts src/server.js with node --watch.

start: starts src/server.js normally.

check: syntax-checks src/server.js.

Important dependencies:

fastify: HTTP server.

@fastify/cors: CORS.

@fastify/jwt: JWT auth.

@fastify/rate-limit: rate limiting.

zod: validation.

pg through @recon/db.

@aws-sdk/client-s3: raw report upload.

node-cron: nightly sync scheduling.

p-limit: concurrency limiting for scheduled jobs.

10.2 apps/api/src/config/secrets.js

Loads .env using dotenv.config() and exports a secrets object.

Important fields:

lwaClientId: Amazon LWA client ID.

lwaClientSecret: Amazon LWA client secret.

spApiAppId: Amazon SP-API application ID.

redirectUri: OAuth callback URL.

jwtSecret: JWT signing secret.

tokenEncryptionKey: key material for token encryption.

frontendOrigin: allowed frontend origin for CORS and redirects.

s3Bucket: optional bucket for raw reports.

s3Region: S3 region.

localReportDir: local fallback folder for raw reports.

10.3 apps/api/src/config/crypto.js

Handles encryption and decryption of sensitive secrets, especially Amazon refresh tokens.

Expected purpose:

encryptSecret(value): encrypts text before storing in DB.

decryptSecret(value): decrypts text from DB before using it with Amazon.

The API uses these helpers when saving seller auth and when creating an SpApiClient.

10.4 apps/api/src/storage/s3.js

Stores raw downloaded report files.

RawReportSchema

Validates:

tenantId as UUID.

reportType as non-empty string.

reportId as non-empty string.

content as string.

safePathSegment(value)

Sanitizes report path segments for local file storage. This prevents unsafe path characters from being used in filenames or folders.

putLocalRawReport(params)

Writes raw report text to local disk under:

storage/raw-reports/<tenantId>/<reportType>/<reportId>-<timestamp>.txt

Returns a local://... URI relative to the current working directory.

putRawReport(params)

Main storage function.

Behavior:

Validates input.

Builds an S3 key.

If S3_BUCKET is missing or placeholder, writes locally.

If S3 upload succeeds, returns S3 key.

If S3 upload fails, writes locally instead.

This prevents report sync from failing only because S3 is not configured.

10.5 apps/api/src/jobs/runner.js

Contains a tiny retry wrapper.

runJob(jobName, fn, attempts = 3)

Behavior:

Runs an async job.

Retries on failure.

Uses exponential backoff.

Throws the final error with jobName attached.

This is intentionally small so it can later be replaced by SQS, BullMQ, or another queue.

10.6 apps/api/src/jobs/sync.js

This is the core sync/import file.

High-level responsibilities

Schedule nightly report syncs.

Fetch Amazon reports.

Parse report documents.

Import rows into Postgres.

Run direct SP-API sync.

Save sync job status.

Constants and schemas

NIGHTLY_REPORTS

All allowed report types from REPORT_TYPES.

SyncParamsSchema

Validates sync input:

tenantId UUID.

reportType enum.

Optional date range.

ReportRowSchema

Allows parsed report rows as records with string keys.

Utility functions

text(value)

Converts any value to a trimmed string. Empty values become undefined.

number(value)

Converts strings/numbers to numeric values. Removes characters like commas and currency symbols.

integer(value)

Converts value to a truncated integer using number().

pick(row, names)

Flexible field picker. It normalizes keys by lowercasing and removing non-alphanumeric characters. This lets the parser handle Amazon reports with different column styles such as:

order-id

order id

amazonOrderId

parseTsv(textContent)

Parses tab-separated report text into row objects.

flattenObjectRow(object)

Flattens one nested object level so nested JSON report fields become easier to pick.

collectObjectRows(value)

Recursively collects object rows from arrays or nested report JSON.

parseReportRows(reportType, content)

Parses report content. Supports:

JSON arrays.

JSON objects.

TSV files.

For Sales & Traffic reports, it filters rows to those with date/ASIN fields.

Report import functions

saveSettlementRows(tenantId, content)

Imports settlement report rows into settlement_rows.

Fields imported:

Settlement ID.

Order ID.

Amount type.

Amount description.

Amount.

Posted date.

Raw row JSON.

saveGstInvoices(tenantId, content, invoiceType)

Imports B2B/B2C GST invoices into gst_invoices.

Fields imported:

Invoice type.

Order ID.

CGST.

SGST.

IGST.

Taxable value.

Invoice date.

saveReturns(tenantId, content)

Imports FBA customer returns into returns.

Fields imported:

Order ID.

Return reason.

Disposition.

Status.

Return date.

saveReimbursements(tenantId, content)

Imports reimbursement report rows into reimbursements.

Fields imported:

Amount.

Reason.

SKU.

Reimbursement date.

saveInventorySnapshots(tenantId, content)

Imports FBA inventory report rows into inventory_snapshots.

Fields imported:

SKU.

Fulfillable quantity.

Snapshot date.

saveSalesTrafficDaily(tenantId, content)

Imports Sales & Traffic report rows into sales_traffic_daily.

Fields imported:

Date.

ASIN.

Sessions.

Page views.

Units ordered.

Ordered product sales.

Featured offer percentage / buy box.

Units refunded.

Shipped product sales.

saveStructuredRows(tenantId, reportType, content)

Dispatches report content to the correct import function based on reportType.

syncReportForTenant(params)

Main report sync function.

Flow:

Validate params.

Default date range to the last 30 days.

Confirm tenant is active.

Insert sync_jobs row as running.

Load latest authorized seller.

Create an SpApiClient with decrypted refresh token.

Fetch report.

Store raw report with putRawReport().

Parse and save rows with saveStructuredRows().

Mark job completed.

On failure, mark job failed and throw.

syncRecentApiDataForTenant(tenantId, options)

Direct SP-API sync function.

Flow:

Validate tenant ID.

Calculate createdAfter based on requested days, defaulting to 30. If a previous direct sync completed, use an incremental window from the last completed sync with a small 5-minute overlap so repeated syncs are much faster.

Confirm tenant is active.

Insert sync_jobs row as DIRECT_SP_API_SYNC and running.

Load authorized seller.

Create SpApiClient.

Fetch order pages.

Fetch finance transactions.

Fetch inventory summaries.

Import orders.

Import order items only for orders that do not already have item rows, so re-syncing does not repeatedly call the slow order-items endpoint.

Import inventory snapshots.

Import finance transactions.

Derive reimbursement rows from finance transactions where transaction type includes reimbursement.

Mark job completed.

Return import counts and warnings.

Returned counts include:

ordersImported.

transactionsImported.

inventoryImported.

reimbursementsImported.

orderItemsSkipped.

incrementalSince.

Returned warnings may include:

financeWarning.

inventoryWarning.

syncActiveTenants(reportType)

Used by the scheduler. It syncs a given report type for all active tenants with concurrency limiting.

startScheduler()

Runs nightly report syncs using cron at 0 2 * * *.

11. API server: apps/api/src/server.js

This is the main backend entrypoint.

11.1 Server setup

Creates a Fastify app with:

Logger redaction for tokens/passwords.

CORS.

Rate limiting.

JWT support.

Central error handler.

11.2 Validation schemas

Important schemas:

TenantParamsSchema: validates tenant UUID route params.

SyncParamsSchema: validates tenant/report sync route params.

AmazonCallbackSchema: validates Amazon OAuth callback query.

AmazonAccessTokenSchema: validates optional seller token query.

SellerSyncSchema: validates bulk/direct sync body.

RegisterSchema: validates admin-created seller accounts.

LoginSchema: validates login.

11.3 Auth helpers

hashPassword(password, salt)

Creates a PBKDF2 password hash.

verifyPassword(password, stored)

Verifies login password against stored PBKDF2 hash.

requireAuth(request)

Requires a valid JWT.

requireAdmin(request)

Requires JWT and admin role.

requireTenantUser(request, tenantId)

Allows admins or users belonging to the requested tenant.

11.4 Amazon OAuth helpers

signAmazonState(payload)

Signs the OAuth state payload using HMAC so callbacks cannot be forged.

verifyAmazonState(state)

Verifies state signature and expiry.

amazonConsentHost(marketplaceId)

Returns the correct Seller Central host.

exchangeAmazonCode(code)

Exchanges OAuth authorization code for Amazon LWA tokens.

11.5 Tenant/data schema helpers

TENANT_DATA_TABLES

List of tenant-owned data tables that should have row-level security enabled.

ensureSellerAuthSchema()

Adds/ensures seller auth metadata columns and indexes.

ensureTenantDataIsolationSchema()

Enables and forces row-level security for tenant-owned tables.

11.6 Error handling

normalizeDatabaseError(error)

Converts database errors into user-friendly HTTP errors, including:

Missing migrations.

Duplicate account email.

RLS blocked query.

Database unavailable.

Global error handler

Converts thrown errors into JSON responses. Internal errors are hidden as Internal server error.

11.7 Auth routes

GET /health

Health check.

POST /api/auth/register-seller

Admin-only route to create seller tenant and first login user.

POST /api/auth/login

Logs in a user/admin and returns JWT.

GET /api/auth/me

Returns current JWT user.

POST /api/dev/bootstrap

Creates a demo seller tenant for development/testing.

11.8 Amazon connection routes