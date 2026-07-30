# Technical documentation

## 1. Architecture

```text
React/Vite web app
        |
        | authenticated JSON
        v
Fastify API
   |        |         |
   |        |         +-- S3 or ignored local raw-report storage
   |        +------------ Amazon Selling Partner API
   +--------------------- PostgreSQL with tenant RLS
```

The workspace packages are:

- `apps/web`: login, administrator, seller, synchronization, reconciliation, calculation drill-down, and report views.
- `apps/api`: authentication, Amazon OAuth, tenant authorization, sync orchestration, report normalization, financial calculation, and HTTP endpoints.
- `packages/sp-api-client`: LWA token exchange, throttled/retried HTTP requests, Reports API, Orders `v2026-01-01`, Finances `v2024-06-19`, FBA Inventory, Catalog Items, and Product Fees.
- `packages/db`: PostgreSQL connection and the `withTenant()` row-level-security context.

## 2. Authentication and secrets

`POST /api/auth/login` returns a 12-hour application JWT. Seller routes call `requireTenantUser`; administrator routes call `requireAdmin`.

Amazon OAuth uses a short-lived HMAC-signed state containing the tenant, user, nonce, and creation time. The callback exchanges the authorization code and stores only the encrypted refresh token. LWA access tokens are created and consumed inside the API process; there is no browser access-token endpoint.

Production startup requires `JWT_SECRET` and `SESSION_SECRET`. `DATABASE_URL`, administrator credentials, Amazon application credentials, and AWS credentials are supplied through environment variables. PostgreSQL certificate verification is enabled by default and accepts a PEM trust bundle through `DATABASE_SSL_CA`. No default administrator password or database connection string is embedded in source.

## 3. Date-range contract

The web app and API use half-open ranges:

```text
start <= timestamp < end
```

This avoids double-counting at adjacent boundaries. The Sales & Traffic report requires inclusive date components, so the SP-API client converts the exclusive end to the preceding marketplace calendar date. Coverage rows in `sync_jobs` retain the original half-open application range.

Amazon rejects report and API boundaries within two minutes of the current time. The client caps the requested end at a safe boundary.

## 4. Direct API synchronization

`syncRecentApiDataForTenant()` performs three independent source pulls.

### Orders

The client calls `GET /orders/2026-01-01/orders` with:

- `createdAfter`/`createdBefore` for an explicit historical range.
- `lastUpdatedAfter`/`lastUpdatedBefore` for an incremental sync.
- `includedData=PROCEEDS,PROMOTION,FULFILLMENT,TAX`.
- the original filters plus `paginationToken` on every next page.

Order items are included in every order response. `order_items.source_key` is based on the Amazon order-item ID, so two lines with the same SKU and ASIN remain distinct while retries stay idempotent.

### Finances

The client calls `GET /finances/2024-06-19/transactions`. Every next-token request repeats `postedAfter` and `postedBefore`, as required by Amazon. Long ranges are split into 179-day windows. Empty pages are accepted and pagination continues until the token disappears.

The importer stores transaction status, description, account type, marketplace, raw data, and every leaf/summary breakdown with a deterministic path key. Released calculations accept `RELEASED` and `DEFERRED_RELEASED`; `DEFERRED` remains visible in the transaction ledger but is not counted as available money.

### Inventory

`GET /fba/inventory/v1/summaries` is paginated until `nextToken` is absent. Each SKU is upserted for the snapshot date.

## 5. Report synchronization

The generic flow is:

1. Validate and normalize the range.
2. Create a report, except for settlements.
3. Poll until `DONE`, `CANCELLED`, or `FATAL`.
4. Treat `CANCELLED` as a completed zero-row report because Amazon uses it when no data is available.
5. Request an RDT for GST report documents without invalid Orders-only `dataElements`.
6. Download/decompress the document.
7. Store the raw source in S3 or the ignored local report directory.
8. Parse and upsert normalized rows only after Amazon confirms complete requested-range coverage. A truncated raw response is retained for diagnosis without replacing verified rows.
9. Record requested coverage and the imported row count in `sync_jobs`.

The previous retry-without-date-range behavior is intentionally absent. A rejected ranged report is reported as a failure instead of silently importing a different period.

### Settlements

`GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` cannot be requested. The client paginates `getReports`, where a next-token request contains only the token, selects the latest report for each settlement window, and merges all overlapping documents. Coverage is marked complete only when the selected intervals cover the requested range without a gap.

Header metadata is stored once per settlement in `settlement_statements`. A header is never inserted as a zero-amount transaction. Monetary rows are stored in `settlement_rows` with transaction type, amount type/description, item code, SKU, quantity, currency, and a deterministic key.

### GST

The B2B/B2C parser maps Amazon's actual columns, including:

- `Tax Exclusive Gross`
- `Invoice Amount` / `Tax Inclusive Gross`
- `Total Tax`
- principal, shipping, and gift-wrap CGST/SGST/UTGST/IGST/Cess components
- document number, shipment/line identity, SKU, ASIN, quantity, transaction type, and invoice date

Refund and credit-note rows are stored with negative signed values. The unique key is per document line, not per order/date, so multi-line invoices are preserved.

### Customer returns

The FBA Customer Returns report represents units Amazon received at a fulfillment center. The importer retains Amazon's status and maps the dashboard lifecycle to `received` or `received_not_in_hand`; it does not label every row `yet_to_receive`.

### Reimbursements

The parser uses `amount-total` and also stores `amount-per-unit`, reimbursement/order IDs, currency, cash/inventory/total quantities, FNSKU, ASIN, reason, and the raw row.

### Sales & Traffic

`salesAndTrafficByDate` is stored only in `sales_traffic_daily` with `asin='ALL'`. `salesAndTrafficByAsin` is stored in `sales_traffic_asin` with its report period. These arrays have different aggregation semantics and are never flattened into the same date table.

## 6. Money and date normalization

`report-normalization.js` handles:

- international values such as `1,234.56`
- decimal-comma values such as `1.234,56` and `95,00`
- Indian grouping such as `1,23,456.78`
- negative parentheses and currency symbols
- localized flat-file dates such as `22.05.2023 10:13:06 UTC`
- date-only values without timezone shifting

Every flat-file parser preserves the raw source row alongside normalized fields.

## 7. Calculation policy

### Financial source

A settlement report is used for financial metrics only when `sync_jobs` proves complete coverage of the selected range. Otherwise released Finances transactions are used. The calculation no longer guesses completeness from the presence of principal, fee, and GST rows.

Parent summaries and child leaves are retained, but a calculation uses one level only. Transaction breakdown ancestry determines Income, Expenses, GST, and Tax sections.

### Quantity source

Priority is:

1. complete Sales & Traffic date rows: `unitsOrdered - unitsRefunded`
2. FBA-only Orders item quantities plus complete FBA Customer Returns coverage
3. unavailable

FBA return rows are never subtracted from a mixed FBA/FBM order quantity.

### Product and trend source

ASIN products and daily trends use Sales & Traffic only when it covers the complete selected range; otherwise they use completely paginated Orders data and label it as a fallback. Sources are never mixed day by day, and the queries use source precedence rather than `greatest()`.

### Coverage across jobs

Nightly direct synchronization is incremental, so one dashboard range can be covered by several adjacent jobs. `source-coverage.js` merges overlapping and adjacent successful intervals independently for Orders, Finances, and each report type. Coverage is rejected if the first interval starts late, the last interval ends early, any gap remains, or pagination stopped with a next token.

### Unavailable data

Missing sessions, page views, returns, quantities, and conversion values remain `null`/Unavailable. The frontend does not spread totals across months or estimate sessions/page views/refunds.

## 8. Database migration 012

`012_sp_api_reconciliation_integrity.sql`:

- creates `settlement_statements`
- adds deterministic source keys and unique indexes
- removes old settlement header money rows and repeated identical settlement rows
- allows duplicate-SKU order lines by keying order items on Amazon order-item ID
- adds finance status/description/account/path fields
- expands return, reimbursement, and GST schemas
- expands daily Sales & Traffic metrics
- creates `sales_traffic_asin`
- backfills legacy source keys with tenant RLS suspended atomically, then restores and forces every tenant policy before commit
- enables and forces tenant RLS on new tables

Apply all migrations before starting the updated API.

## 9. Security and raw data

Raw Amazon report exports can contain seller and order data. Local reports are written under `apps/api/storage/raw-reports/`, which is ignored. Previously tracked exports should be removed from the current tree and purged from Git history if the repository was shared.

If a database password or other secret was previously committed, rotate it immediately. A normal source edit does not remove a secret from old commits.

## 10. Verification

`npm test` runs syntax checks and unit tests for:

- report amount/date normalization
- settlement header/detail separation and stable keys
- GST, reimbursement, return, and Sales & Traffic mappings
- finance breakdown classification
- released/deferred transaction behavior
- source completeness and quantity precedence
- gap-free coverage across adjacent incremental jobs
- dashboard reconciliation fixtures
- Sales & Traffic half-open/inclusive date conversion

`npm run build` performs the production Vite build.
