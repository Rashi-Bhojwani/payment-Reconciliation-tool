import { createHash } from 'node:crypto';
import cron from 'node-cron';
import pLimit from 'p-limit';
import { z } from 'zod';
import { assertActiveTenant, pool, withTenant } from '@recon/db';
import { getSpApiEndpoint, REPORT_TYPES, SpApiClient } from '@recon/sp-api-client';
import { decryptSecret } from '../config/crypto.js';
import { putRawReport } from '../storage/s3.js';
import { runJob } from './runner.js';
import { categorizeFinanceLabel, flattenFinanceTransaction } from './finance-components.js';

export { categorizeFinanceLabel } from './finance-components.js';

const NIGHTLY_REPORTS = [...REPORT_TYPES];
const SyncParamsSchema = z.object({ tenantId: z.string().uuid(), reportType: z.enum(REPORT_TYPES), range: z.object({ start: z.string().datetime(), end: z.string().datetime() }).optional() });
const ReportRowSchema = z.record(z.string(), z.unknown());

/** @param {unknown} value */
function text(value) { return value == null ? undefined : String(value).trim() || undefined; }
/** @param {unknown} value */
function number(value) { const parsed = Number(String(value ?? '').replace(/[,₹$]/g, '')); return Number.isFinite(parsed) ? parsed : 0; }
/** @param {unknown} value */
function integer(value) { return Math.trunc(number(value)); }
function reportDate(value) {
  const input = text(value);
  if (!input) return null;
  const match = input.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(.*))?$/);
  if (!match) return input;
  const [, day, month, year, time] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}${time ? ` ${time}` : ''}`;
}
function firstAttribute(attributes, names) {
  for (const name of names) {
    const value = attributes?.[name];
    if (Array.isArray(value) && value[0]) return value[0];
  }
  return undefined;
}
function catalogShippingFacts(catalog) {
  const attributes = catalog?.attributes ?? catalog?.payload?.attributes ?? {};
  const weight = firstAttribute(attributes, ['item_package_weight', 'item_weight']);
  const dimensions = firstAttribute(attributes, ['item_package_dimensions', 'item_dimensions']);
  const dimensionText = dimensions
    ? [dimensions.length, dimensions.width, dimensions.height].filter(value => value != null).join(' × ') + (dimensions.unit ? ` ${dimensions.unit}` : '')
    : null;
  return { weight: number(weight?.value), weightUnit: text(weight?.unit), dimensions: dimensionText };
}
function financeRelatedValue(transaction, wantedNames) {
  const identifiers = transaction?.relatedIdentifiers ?? transaction?.RelatedIdentifiers;
  if (Array.isArray(identifiers)) {
    const match = identifiers.find(identifier => wantedNames.includes(String(identifier?.relatedIdentifierName ?? identifier?.RelatedIdentifierName ?? '').toUpperCase()));
    return text(match?.relatedIdentifierValue ?? match?.RelatedIdentifierValue);
  }
  for (const name of wantedNames) {
    const camelName = name.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = identifiers?.[camelName] ?? identifiers?.[name] ?? identifiers?.[name.toLowerCase()];
    if (value) return text(value);
  }
  return undefined;
}
/** @param {Record<string, unknown>} row @param {string[]} names */

function sourceKey(row, parts = []) {
  const explicit = text(pick(row, ['source-key', 'source key', 'sourceKey', 'transaction-id', 'transaction id', 'transactionId', 'return-event-id', 'event-id', 'eventId']));
  if (explicit) return explicit;
  const material = parts.map(part => text(part) ?? '').join('|') || JSON.stringify(row);
  return createHash('sha256').update(material).digest('hex').slice(0, 48);
}

/**
 * withTenant, but the whole callback runs inside one Postgres transaction, so
 * no other connection can observe a partially applied write set.
 *
 * Any sync that refreshes a table by deleting rows and re-inserting them needs
 * this. Without a transaction those are separate autocommitted statements, and
 * a dashboard request landing between the delete and the insert reads a table
 * with rows missing - producing money figures that are silently wrong for the
 * duration of the sync. Observed live: the same tenant and date range reported
 * 4038 finance rows on one render and 1426 on the next.
 *
 * Built from `pool` here rather than exported from @recon/db so this file
 * cannot fail to start against an older or locally modified copy of that
 * package - it only needs the pool, which has always been exported.
 *
 * set_config's third argument is true so the tenant setting is scoped to the
 * transaction and released by COMMIT/ROLLBACK instead of lingering on a pooled
 * connection.
 * @template T
 * @param {string} tenantId
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTenantTransaction(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1,$2,true)', ['app.current_tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.query("select set_config('app.current_tenant_id','',false)").catch(() => undefined);
    client.release();
  }
}

function pick(row, names) {
  const lowerMap = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), value]));
  for (const name of names) {
    const value = lowerMap.get(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (value != null && String(value).trim() !== '') return value;
  }
  return undefined;
}

const BATCH_UPSERT_CHUNK_SIZE = 500;

/**
 * Inserts many rows in a handful of multi-row statements instead of one
 * sequential round trip per row. A high-volume seller's settlement or
 * finance-event report is realistically tens of thousands of lines; one
 * awaited query per row at that scale is slow enough to risk the sync
 * request itself timing out mid-import (server platform, reverse proxy, or
 * browser), leaving only whatever was inserted before the cutoff actually
 * saved - a "completed" sync with silently incomplete data, indistinguishable
 * from a correct one until the totals are compared against Amazon.
 * @param {import('pg').PoolClient} client
 * @param {{ table: string, columns: string[], conflictColumns?: string[], updateColumns?: string[], rows: unknown[][], chunkSize?: number }} params
 * @returns {Promise<number>}
 */
export async function batchUpsert(client, { table, columns, conflictColumns, updateColumns, rows, chunkSize = BATCH_UPSERT_CHUNK_SIZE }) {
  if (!rows.length) return 0;
  const conflictIndexes = updateColumns?.length ? conflictColumns.map(name => columns.indexOf(name)) : null;
  const action = updateColumns?.length
    ? `on conflict (${conflictColumns.join(',')}) do update set ${updateColumns.map(name => `${name}=excluded.${name}`).join(', ')}`
    : 'on conflict do nothing';
  let imported = 0;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    let chunk = rows.slice(offset, offset + chunkSize);
    if (conflictIndexes) {
      // A single "insert ... on conflict do update" cannot affect the same
      // target row twice in one statement, so same-key rows within a chunk
      // must be pre-merged (keep the latest). But the real unique
      // constraints here include nullable columns, and Postgres never treats
      // NULL as equal to NULL for conflict purposes - two rows that are both
      // NULL in a key column are NOT duplicates of each other. A naive
      // string-join key would incorrectly collapse them, so any row with a
      // null key component always gets its own unique synthetic key instead.
      const seen = new Map();
      chunk.forEach((row, rowIndex) => {
        const keyParts = conflictIndexes.map(index => row[index]);
        const key = keyParts.some(value => value == null) ? `row${rowIndex}` : JSON.stringify(keyParts);
        seen.set(key, row);
      });
      chunk = [...seen.values()];
    }
    const values = [];
    const placeholders = chunk.map((row, rowIndex) => {
      values.push(...row);
      const base = rowIndex * columns.length;
      return `(${columns.map((_, columnIndex) => `$${base + columnIndex + 1}`).join(',')})`;
    }).join(',');
    await client.query(`insert into ${table}(${columns.join(',')}) values ${placeholders} ${action}`, values);
    imported += chunk.length;
  }
  return imported;
}

/** @param {string} textContent @returns {Array<Record<string, unknown>>} */
function parseTsv(textContent) {
  const trimmed = z.string().parse(textContent).trim();
  if (!trimmed) return [];
  const [headerLine, ...lines] = trimmed.split(/\r?\n/);
  const headers = headerLine.split('\t').map(header => header.trim());
  return lines.filter(Boolean).map(line => Object.fromEntries(line.split('\t').map((value, index) => [headers[index], value])));
}

/** @param {Record<string, unknown>} object @returns {Record<string, unknown>} */
function flattenObjectRow(object) {
  const flat = { ...object };
  function walk(value, path = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, nestedValue] of Object.entries(value)) {
      const nextPath = [...path, key];
      flat[nextPath.join('.')] = nestedValue;
      if (path.length) flat[key] ??= nestedValue;
      if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) walk(nestedValue, nextPath);
    }
  }
  walk(object);
  return flat;
}

/** @param {unknown} value @returns {Array<Record<string, unknown>>} */
function collectObjectRows(value) {
  if (Array.isArray(value)) return value.flatMap(collectObjectRows);
  if (!value || typeof value !== 'object') return [];
  const object = value;
  const arrays = Object.values(object).filter(Array.isArray);
  if (arrays.length) return arrays.flatMap(collectObjectRows);
  return [flattenObjectRow(object)];
}

/** @param {string} reportType @param {string} content */
function parseReportRows(reportType, content) {
  const parsedType = z.enum(REPORT_TYPES).parse(reportType);
  const trimmed = z.string().parse(content).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(trimmed);
    if (parsedType === 'GET_SALES_AND_TRAFFIC_REPORT') {
      return collectObjectRows(json).filter(row => pick(row, ['date', 'parentAsin', 'childAsin', 'asin']));
    }
    return collectObjectRows(json);
  }
  return parseTsv(trimmed);
}

/** @param {string} tenantId @param {string} content */
async function saveSettlementRows(tenantId, content) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', content));
  await withTenantTransaction(tenantId, async client => {
    const batch = rows.map(row => {
      const amount = number(pick(row, ['amount']));
      return [tenantId, text(pick(row, ['settlement-id', 'settlement id', 'settlementId'])), text(pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId'])), text(pick(row, ['amount-type', 'amount type', 'amountType'])), text(pick(row, ['amount-description', 'amount description', 'amountDescription'])), amount, reportDate(pick(row, ['posted-date', 'posted date', 'postedDate'])), row, sourceKey(row, [pick(row, ['settlement-id', 'settlement id', 'settlementId']), pick(row, ['transaction-type', 'transaction type', 'transactionType']), pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId']), pick(row, ['amount-type', 'amount type', 'amountType']), pick(row, ['amount-description', 'amount description', 'amountDescription']), pick(row, ['posted-date', 'posted date', 'postedDate']), amount])];
    });
    // source_key is deterministic per settlement/transaction line, and is
    // the real conflict identity here - not the business columns. Settlement
    // header rows deliberately share NULL order_id/amount_type/
    // amount_description/posted_date across *different* settlements
    // (Postgres never treats two NULLs as equal, so a composite target on
    // those columns can never tell one settlement's header from another's,
    // by design), but re-syncing the *same* settlement a second time
    // produces the exact same source_key both times - so source_key is what
    // actually needs to drive the update-vs-insert decision, refreshing
    // deposit metadata on re-sync instead of erroring or duplicating.
    await batchUpsert(client, {
      table: 'settlement_rows',
      columns: ['tenant_id', 'settlement_id', 'order_id', 'amount_type', 'amount_description', 'amount', 'posted_date', 'raw', 'source_key'],
      conflictColumns: ['tenant_id', 'source_key'],
      updateColumns: ['settlement_id', 'order_id', 'amount_type', 'amount_description', 'amount', 'posted_date', 'raw'],
      rows: batch
    });
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content @param {'b2b'|'b2c'} invoiceType */
async function saveGstInvoices(tenantId, content, invoiceType) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows(invoiceType === 'b2b' ? 'GET_GST_MTR_B2B_CUSTOM' : 'GET_GST_MTR_B2C_CUSTOM', content));
  await withTenantTransaction(tenantId, async client => {
    const batch = rows.map(row => [tenantId, invoiceType, text(pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId'])), number(pick(row, ['cgst', 'cgst tax', 'cgst amount'])), number(pick(row, ['sgst', 'sgst tax', 'sgst amount'])), number(pick(row, ['igst', 'igst tax', 'igst amount'])), number(pick(row, ['taxable-value', 'taxable value', 'taxableValue', 'taxable amount'])), text(pick(row, ['invoice-date', 'invoice date', 'invoiceDate', 'transaction-date', 'transaction date'])) ?? null, row]);
    await batchUpsert(client, {
      table: 'gst_invoices',
      columns: ['tenant_id', 'invoice_type', 'order_id', 'cgst', 'sgst', 'igst', 'taxable_value', 'invoice_date', 'raw'],
      conflictColumns: ['tenant_id', 'invoice_type', 'order_id', 'invoice_date'],
      updateColumns: ['cgst', 'sgst', 'igst', 'taxable_value', 'raw'],
      rows: batch
    });
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content */
// Amazon names the returned-unit column differently across return report
// generations and between FBA and seller-fulfilled returns, and pick() only
// matches names it is given. A name we do not list arrives as a null quantity,
// which used to blank Net Qty and Return Rate entirely.
const RETURN_QUANTITY_FIELDS = Object.freeze(['quantity', 'quantity-returned', 'return quantity', 'return-quantity', 'returnQuantity', 'quantity-shipped', 'units', 'unit-count', 'item-quantity']);

async function saveReturns(tenantId, content) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', content));
  await withTenantTransaction(tenantId, async client => {
    const batch = rows.map(row => [tenantId, text(pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId'])), text(pick(row, ['reason', 'return-reason', 'return reason', 'returnReason'])), text(pick(row, ['disposition', 'detailed-disposition', 'detailed disposition'])), 'yet_to_receive', text(pick(row, ['return-date', 'return date', 'returnDate', 'date'])) ?? null, pick(row, RETURN_QUANTITY_FIELDS) == null ? null : integer(pick(row, RETURN_QUANTITY_FIELDS)), row, sourceKey(row, [pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId']), pick(row, ['return-date', 'return date', 'returnDate', 'date']), pick(row, ['reason', 'return-reason', 'return reason', 'returnReason']), pick(row, ['disposition', 'detailed-disposition', 'detailed disposition'])])]);
    // Same reasoning as settlement_rows: source_key, not the business
    // columns, is the deterministic identity of a source row, and is what
    // the ON CONFLICT target must actually be to update-not-error on re-sync.
    await batchUpsert(client, {
      table: 'returns',
      columns: ['tenant_id', 'order_id', 'return_reason', 'disposition', 'status', 'return_date', 'quantity', 'raw', 'source_key'],
      conflictColumns: ['tenant_id', 'source_key'],
      updateColumns: ['order_id', 'return_reason', 'disposition', 'status', 'return_date', 'quantity', 'raw'],
      rows: batch
    });
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content */
async function saveReimbursements(tenantId, content) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_FBA_REIMBURSEMENTS_DATA', content));
  await withTenantTransaction(tenantId, async client => {
    const batch = rows.map(row => {
      const amount = number(pick(row, ['amount', 'total-amount', 'total amount', 'reimbursement amount']));
      const reason = text(pick(row, ['reason', 'reason-code', 'reason code', 'approval-reason']));
      const sku = text(pick(row, ['sku', 'seller-sku', 'seller sku']));
      const reimbursementDate = text(pick(row, ['reimbursement-date', 'reimbursement date', 'approval-date', 'approval date'])) ?? null;
      return [tenantId, amount, reason, sku, reimbursementDate, sourceKey(row, [sku, reimbursementDate, amount, reason])];
    });
    await batchUpsert(client, {
      table: 'reimbursements',
      columns: ['tenant_id', 'amount', 'reason', 'sku', 'reimbursement_date', 'source_key'],
      rows: batch
    });
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content */
async function saveInventorySnapshots(tenantId, content) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', content));
  const snapshotDate = new Date().toISOString().slice(0, 10);
  await withTenantTransaction(tenantId, async client => {
    const batch = rows
      .map(row => [row, text(pick(row, ['sku', 'seller-sku', 'seller sku']))])
      .filter(([, sku]) => sku)
      .map(([row, sku]) => [tenantId, sku, integer(pick(row, ['fulfillable-quantity', 'fulfillable quantity', 'afn-fulfillable-quantity', 'afn fulfillable quantity', 'quantity'])), snapshotDate]);
    await batchUpsert(client, {
      table: 'inventory_snapshots',
      columns: ['tenant_id', 'sku', 'fulfillable_quantity', 'snapshot_date'],
      conflictColumns: ['tenant_id', 'sku', 'snapshot_date'],
      updateColumns: ['fulfillable_quantity'],
      rows: batch
    });
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content */
async function saveSalesTrafficDaily(tenantId, content, range) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_SALES_AND_TRAFFIC_REPORT', content));
  const fallbackDate = range?.start ? new Date(range.start).toISOString().slice(0, 10) : null;
  await withTenantTransaction(tenantId, async client => {
    const batch = rows
      .map(row => [row, text(pick(row, ['date', 'startDate', 'start-date'])) ?? fallbackDate])
      .filter(([, date]) => date)
      .map(([row, date]) => [tenantId, date, text(pick(row, ['asin', 'parentAsin', 'parent-asin', 'childAsin', 'child-asin'])) ?? 'ALL', integer(pick(row, ['sessions', 'sessionsTotal'])), integer(pick(row, ['pageViews', 'page-views', 'page views', 'pageViewsTotal'])), integer(pick(row, ['unitsOrdered', 'units-ordered', 'units ordered'])), number(pick(row, ['orderedProductSales.amount', 'salesByDate.orderedProductSales.amount', 'salesByAsin.orderedProductSales.amount', 'orderedProductSales', 'ordered-product-sales', 'ordered product sales', 'orderedProductSalesAmount', 'amount'])), number(pick(row, ['featuredOfferPercentage', 'featured-offer-percentage', 'featured offer percentage', 'buyBoxPercentage'])), integer(pick(row, ['unitsRefunded', 'units-refunded', 'units refunded'])), number(pick(row, ['shippedProductSales', 'shipped-product-sales', 'shipped product sales', 'shippedProductSalesAmount'])), number(pick(row, ['orderedProductSalesB2B.amount', 'salesByDate.orderedProductSalesB2B.amount', 'salesByAsin.orderedProductSalesB2B.amount', 'orderedProductSalesB2B', 'ordered-product-sales-b2b', 'ordered product sales b2b', 'orderedProductSalesB2BAmount'])), integer(pick(row, ['unitsOrderedB2B', 'units-ordered-b2b', 'units ordered b2b'])), integer(pick(row, ['totalOrderItems', 'total-order-items', 'total order items'])), integer(pick(row, ['totalOrderItemsB2B', 'total-order-items-b2b', 'total order items b2b'])), number(pick(row, ['averageSalesPerOrderItem.amount', 'salesByDate.averageSalesPerOrderItem.amount', 'salesByAsin.averageSalesPerOrderItem.amount', 'averageSalesPerOrderItem', 'average-sales-per-order-item', 'average sales per order item'])), number(pick(row, ['averageSalesPerOrderItemB2B.amount', 'salesByDate.averageSalesPerOrderItemB2B.amount', 'salesByAsin.averageSalesPerOrderItemB2B.amount', 'averageSalesPerOrderItemB2B', 'average-sales-per-order-item-b2b', 'average sales per order item b2b'])), number(pick(row, ['averageUnitsPerOrderItem', 'average-units-per-order-item', 'average units per order item'])), number(pick(row, ['averageUnitsPerOrderItemB2B', 'average-units-per-order-item-b2b', 'average units per order item b2b'])), number(pick(row, ['averageSellingPrice.amount', 'salesByDate.averageSellingPrice.amount', 'salesByAsin.averageSellingPrice.amount', 'averageSellingPrice', 'average-selling-price', 'average selling price'])), row]);
    await batchUpsert(client, {
      table: 'sales_traffic_daily',
      columns: ['tenant_id', 'date', 'asin', 'sessions', 'page_views', 'units_ordered', 'ordered_product_sales', 'featured_offer_percentage', 'units_refunded', 'shipped_product_sales', 'ordered_product_sales_b2b', 'units_ordered_b2b', 'total_order_items', 'total_order_items_b2b', 'average_sales_per_order_item', 'average_sales_per_order_item_b2b', 'average_units_per_order_item', 'average_units_per_order_item_b2b', 'average_selling_price', 'raw'],
      conflictColumns: ['tenant_id', 'date', 'asin'],
      updateColumns: ['sessions', 'page_views', 'units_ordered', 'ordered_product_sales', 'featured_offer_percentage', 'units_refunded', 'shipped_product_sales', 'ordered_product_sales_b2b', 'units_ordered_b2b', 'total_order_items', 'total_order_items_b2b', 'average_sales_per_order_item', 'average_sales_per_order_item_b2b', 'average_units_per_order_item', 'average_units_per_order_item_b2b', 'average_selling_price', 'raw'],
      rows: batch
    });
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} reportType @param {string} content */
async function saveStructuredRows(tenantId, reportType, content, range) {
  switch (reportType) {
    case 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2': return saveSettlementRows(tenantId, content);
    case 'GET_GST_MTR_B2B_CUSTOM': return saveGstInvoices(tenantId, content, 'b2b');
    case 'GET_GST_MTR_B2C_CUSTOM': return saveGstInvoices(tenantId, content, 'b2c');
    case 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA': return saveReturns(tenantId, content);
    case 'GET_FBA_REIMBURSEMENTS_DATA': return saveReimbursements(tenantId, content);
    case 'GET_SALES_AND_TRAFFIC_REPORT': return saveSalesTrafficDaily(tenantId, content, range);
    case 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA': return saveInventorySnapshots(tenantId, content);
    default: return 0;
  }
}

/** @param {{ tenantId: string, reportType: string, range?: { start: string, end: string } }} params */
export async function syncReportForTenant(params) {
  const parsed = SyncParamsSchema.parse(params);
  const range = parsed.range ?? { start: new Date(Date.now() - 30 * 864e5).toISOString(), end: new Date().toISOString() };
  await assertActiveTenant(parsed.tenantId);
  // A report request creates a remote Amazon job. Retrying this whole block can
  // create duplicate remote reports and keep the ledger running for 45+ minutes.
  // The SP-API client already retries throttled HTTP calls, so execute each
  // user-triggered report job only once.
  return runJob(`sync:${parsed.reportType}:${parsed.tenantId}`, async () => {
    const startedAt = Date.now();
    const logLabel = `sync ${parsed.tenantId.slice(0, 8)}:${parsed.reportType}`;
    console.log(`[${logLabel}] starting (range ${range.start} to ${range.end})`);
    const sync = await pool.query('insert into sync_jobs(tenant_id, report_type, status, started_at, range_start, range_end) values($1,$2,$3,now(),$4,$5) returning id', [parsed.tenantId, parsed.reportType, 'running', range.start, range.end]);
    try {
      const seller = await pool.query("select refresh_token_encrypted, marketplace_id from sellers where tenant_id = $1 and auth_status = 'authorized' order by connected_at desc limit 1", [parsed.tenantId]);
      if (!seller.rowCount) throw new Error('No connected Amazon seller account');
      const client = new SpApiClient(decryptSecret(seller.rows[0].refresh_token_encrypted), { baseUrl: getSpApiEndpoint(seller.rows[0].marketplace_id), label: logLabel });
      // Settlement report documents are immutable once generated - skip any
      // this tenant has already downloaded and saved, so a long settlement
      // history doesn't get re-fetched in full on every sync (see fetchReport).
      const alreadyProcessed = await withTenant(parsed.tenantId, db => db.query('select report_document_id from processed_report_documents where tenant_id=$1 and report_type=$2', [parsed.tenantId, parsed.reportType]));
      const skipDocumentIds = new Set(alreadyProcessed.rows.map(row => row.report_document_id));
      const report = await client.fetchReport(parsed.reportType, parsed.tenantId, range, seller.rows[0].marketplace_id, { skipDocumentIds });
      if (report.allAlreadyProcessed) {
        console.log(`[${logLabel}] completed in ${Date.now() - startedAt}ms - all ${report.reportsAvailable} available document(s) already synced, nothing new`);
        await pool.query('update sync_jobs set status=$1, completed_at=now() where id=$2', ['completed', sync.rows[0].id]);
        return { rowsImported: 0, alreadyUpToDate: true };
      }
      const s3Key = await putRawReport({ tenantId: parsed.tenantId, reportType: parsed.reportType, reportId: report.reportId, content: report.content });
      const rowsImported = await saveStructuredRows(parsed.tenantId, parsed.reportType, report.content, range);
      if (report.documentIds?.length) {
        await withTenantTransaction(parsed.tenantId, db => batchUpsert(db, {
          table: 'processed_report_documents',
          columns: ['tenant_id', 'report_document_id', 'report_type'],
          rows: report.documentIds.map(documentId => [parsed.tenantId, documentId, parsed.reportType])
        }));
      }
      const outstandingDocuments = report.reportsTruncated ? report.reportsAvailable - (report.reportsMerged ?? 0) : 0;
      console.log(`[${logLabel}] completed in ${Date.now() - startedAt}ms - ${rowsImported} rows imported from ${report.reportsMerged ?? 0} of ${report.reportsAvailable} document(s) Amazon has for this range` + (outstandingDocuments ? ` - ${outstandingDocuments} STILL OUTSTANDING, figures are incomplete until they are fetched` : ''));
      // A truncated sync fetched only part of what Amazon has, so it must not
      // be recorded as a sync that covers this range. It used to be stored
      // with the full range and status 'completed', which made
      // findReusableSync treat the range as fully synced for the next hour -
      // so the remaining documents were not fetched, the backlog drained at
      // best one capped batch per hour, and the dashboard showed money
      // computed from a partial settlement history with nothing to indicate
      // it. Leaving the range null keeps the job visible in the ledger while
      // letting the next dashboard load pick up where this one stopped;
      // already-processed documents are skipped, so it converges instead of
      // re-fetching, and the in-flight and backoff guards bound the traffic.
      await pool.query(
        outstandingDocuments
          ? 'update sync_jobs set status=$1, completed_at=now(), s3_key=$2, range_start=null, range_end=null, error_message=$4 where id=$3'
          : 'update sync_jobs set status=$1, completed_at=now(), s3_key=$2 where id=$3',
        outstandingDocuments
          ? ['completed', s3Key, sync.rows[0].id, `Partial: ${outstandingDocuments} settlement document(s) still to fetch`]
          : ['completed', s3Key, sync.rows[0].id]
      );
      return { rowsImported, s3Key, documentsMerged: report.reportsMerged ?? 0, documentsAvailable: report.reportsAvailable, outstandingDocuments };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`[${logLabel}] failed after ${Date.now() - startedAt}ms: ${message}`);
      await pool.query('update sync_jobs set status=$1, completed_at=now(), error_message=$2 where id=$3', ['failed', message, sync.rows[0].id]);
      throw error;
    }
  }, 1);
}


// Settlements/Sales & Traffic/Inventory/Reimbursements all fall back to this
// same direct-API sync whenever their own Amazon report isn't ready, and the
// base Orders & Finance sync calls it directly too - so a user (or the sync
// ledger) can easily trigger two or three of these for the same tenant
// within seconds of each other. Nothing previously stopped them running
// concurrently: they'd both hit Amazon's per-account rate limits at once,
// each slowing (and 429-ing) the other, which is consistent with jobs
// sitting in 'running' well past when a single sync would finish. Queue
// same-tenant calls instead so only one is ever in flight against Amazon.
const tenantSyncMutex = new Map();
export function withTenantSyncMutex(tenantId, fn) {
  const previous = tenantSyncMutex.get(tenantId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  tenantSyncMutex.set(tenantId, run.catch(() => undefined));
  return run;
}

/** @param {string} tenantId @param {{ days?: number }} [options] */
export function syncRecentApiDataForTenant(tenantId, options = {}) {
  return withTenantSyncMutex(tenantId, () => syncRecentApiDataForTenantDirect(tenantId, options));
}

async function syncRecentApiDataForTenantDirect(tenantId, options = {}) {
  const parsedTenantId = z.string().uuid().parse(tenantId);
  const range = options.range ? z.object({ start: z.string().datetime(), end: z.string().datetime() }).parse(options.range) : null;
  const defaultCreatedAfter = range ? new Date(range.start) : new Date(Date.now() - (options.days ?? 30) * 864e5);
  const lastCompletedSync = (await pool.query(
    `select completed_at from sync_jobs
     where tenant_id=$1 and report_type='DIRECT_SP_API_SYNC' and status='completed' and completed_at is not null
     order by completed_at desc limit 1`,
    [parsedTenantId]
  )).rows[0]?.completed_at;
  const incrementalCreatedAfter = lastCompletedSync ? new Date(new Date(lastCompletedSync).getTime() - 5 * 60 * 1000) : defaultCreatedAfter;
  const createdAfterDate = range || options.full ? defaultCreatedAfter : new Date(Math.max(defaultCreatedAfter.getTime(), incrementalCreatedAfter.getTime()));
  const createdAfter = createdAfterDate.toISOString();
  const safeNow = new Date(Date.now() - 2 * 60 * 1000);
  const requestedCreatedBefore = range ? new Date(range.end) : safeNow;
  const createdBefore = new Date(Math.min(requestedCreatedBefore.getTime(), safeNow.getTime())).toISOString();
  const includeOrders = options.includeOrders ?? true;
  const includeFinance = options.includeFinance ?? true;
  const includeInventory = options.includeInventory ?? true;
  const maxOrderPages = Math.max(1, Math.min(Number(options.maxOrderPages ?? 100), 100));
  const maxOrderItems = Math.max(0, Math.min(Number(options.maxOrderItems ?? 1000), 1000));
  await assertActiveTenant(parsedTenantId);
  return runJob(`sync:direct-api:${parsedTenantId}`, async () => {
    const startedAt = Date.now();
    const logLabel = `sync ${parsedTenantId.slice(0, 8)}:DIRECT_SP_API_SYNC`;
    console.log(`[${logLabel}] starting (createdAfter=${createdAfter}, createdBefore=${createdBefore})`);
    const sync = await pool.query('insert into sync_jobs(tenant_id, report_type, status, started_at, range_start, range_end) values($1,$2,$3,now(),$4,$5) returning id', [parsedTenantId, 'DIRECT_SP_API_SYNC', 'running', range?.start ?? null, range?.end ?? null]);
    try {
      const seller = await pool.query("select refresh_token_encrypted, marketplace_id from sellers where tenant_id = $1 and auth_status = 'authorized' order by connected_at desc limit 1", [parsedTenantId]);
      if (!seller.rowCount) throw new Error('No connected Amazon seller account');
      const marketplaceId = seller.rows[0].marketplace_id;
      const client = new SpApiClient(decryptSecret(seller.rows[0].refresh_token_encrypted), { baseUrl: getSpApiEndpoint(marketplaceId), label: logLabel });
      let ordersWarning;
      const orderPages = [];
      if (includeOrders) {
        try {
          let ordersResponse = await client.listOrders(createdAfter, marketplaceId, createdBefore);
          orderPages.push(ordersResponse);
          for (let page = 1; page < maxOrderPages; page += 1) {
            const nextToken = ordersResponse?.payload?.NextToken ?? ordersResponse?.NextToken;
            if (!nextToken) break;
            ordersResponse = await client.listOrdersByNextToken(nextToken);
            orderPages.push(ordersResponse);
          }
        } catch (error) {
          ordersWarning = error instanceof Error ? error.message : 'Orders sync failed';
        }
      }
      const orders = orderPages.flatMap(page => page?.payload?.Orders ?? page?.Orders ?? []);
      // A shipped order is often posted to Transaction View days after its
      // purchase date. Extend only the finance window so selecting Jul 1–2 can
      // still retrieve Amazon's Jul 10 payment for those orders.
      const financeBefore = range ? new Date(Math.min(safeNow.getTime(), new Date(range.end).getTime() + 45 * 864e5)).toISOString() : createdBefore;
      let financeResponse = includeFinance ? await client.listFinanceTransactions(createdAfter, financeBefore).catch(error => ({ syncError: error instanceof Error ? error.message : 'Finance sync failed' })) : null;
      const financePages = financeResponse ? [financeResponse] : [];
      const financeTokens = new Set();
      for (let page = 1; includeFinance && page < 100; page += 1) {
        const nextToken = financeResponse?.payload?.nextToken ?? financeResponse?.nextToken ?? financeResponse?.payload?.NextToken ?? financeResponse?.NextToken;
        if (!nextToken || financeTokens.has(nextToken)) break;
        financeTokens.add(nextToken);
        financeResponse = await client.listFinanceTransactions(undefined, undefined, nextToken).catch(error => ({ syncError: error instanceof Error ? error.message : 'Finance pagination failed' }));
        financePages.push(financeResponse);
        if (financeResponse.syncError) break;
      }
      const transactions = financePages.flatMap(page => page?.payload?.transactions ?? page?.transactions ?? page?.payload?.Transactions ?? page?.Transactions ?? []);
      const inventoryResponse = includeInventory ? await client.listInventorySummaries(marketplaceId).catch(error => ({ syncError: error instanceof Error ? error.message : 'Inventory sync failed' })) : null;
      const inventorySummaries = inventoryResponse?.payload?.inventorySummaries ?? inventoryResponse?.inventorySummaries ?? [];
      const snapshotDate = new Date().toISOString().slice(0, 10);
      let ordersImported = 0;
      let transactionsImported = 0;
      let inventoryImported = 0;
      let reimbursementsImported = 0;
      let orderItemsSkipped = 0;
      let catalogItemsImported = 0;
      const catalogCache = new Map();
      // A 403 from the Catalog Items API means this app's SP-API
      // authorization does not include catalog access for this account -
      // that is an Amazon-side permission grant, not a transient failure,
      // and retrying it will never succeed. Once seen, stop spending any
      // more of this run's calls on catalog lookups that are guaranteed to
      // fail the same way.
      let catalogAccessDenied = false;
      const fetchCatalogItem = async asin => {
        if (catalogAccessDenied) return { unavailable: true };
        try {
          const catalog = await client.getCatalogItem(asin, marketplaceId);
          catalogItemsImported += 1;
          return catalog;
        } catch (error) {
          if (error instanceof Error && /\b403\b/.test(error.message)) catalogAccessDenied = true;
          return { unavailable: true };
        }
      };
      await withTenant(parsedTenantId, async db => {
        // Orders/items themselves are cheap to batch; what genuinely must
        // stay sequential is the per-order Order Items API call and the
        // per-ASIN Catalog Items API call, since both are real, rate-limited
        // network requests to Amazon, not database writes. So this loop only
        // fetches from Amazon and collects rows - every DB write is issued
        // once, in batches, after the loop instead of once per row inside it.
        const orderRows = [];
        const orderItemRows = [];
        let orderItemsFetched = 0;
        for (const order of orders) {
          const orderId = order.AmazonOrderId ?? order.amazonOrderId;
          if (!orderId) continue;
          orderRows.push([parsedTenantId, orderId, order.PurchaseDate ?? order.purchaseDate ?? null, number(order.OrderTotal?.Amount ?? order.orderTotal?.amount), order.OrderStatus ?? order.orderStatus ?? null, order.FulfillmentChannel ?? order.fulfillmentChannel ?? null, order.SalesChannel ?? order.salesChannel ?? null, order]);
          ordersImported += 1;
          const existingItems = await db.query('select 1 from order_items where tenant_id=$1 and amazon_order_id=$2 limit 1', [parsedTenantId, orderId]);
          if (existingItems.rowCount) {
            orderItemsSkipped += 1;
            continue;
          }
          if (orderItemsFetched >= maxOrderItems) {
            orderItemsSkipped += 1;
            continue;
          }
          const itemsResponse = await client.listOrderItems(orderId).catch(() => undefined);
          orderItemsFetched += 1;
          const items = itemsResponse?.payload?.OrderItems ?? itemsResponse?.OrderItems ?? [];
          for (const item of items) {
            const asin = item.ASIN ?? item.asin ?? null;
            let catalog = asin ? catalogCache.get(asin) : null;
            if (asin && !catalogCache.has(asin)) {
              catalog = await fetchCatalogItem(asin);
              catalogCache.set(asin, catalog);
            }
            const shipping = catalogShippingFacts(catalog?.unavailable ? null : catalog);
            const sku = item.SellerSKU ?? item.sellerSku ?? null;
            const orderItemId = item.OrderItemId ?? item.orderItemId ?? null;
            orderItemRows.push([parsedTenantId, orderId, asin, sku, item.Title ?? item.title ?? null, integer(item.QuantityOrdered ?? item.quantityOrdered), number(item.ItemPrice?.Amount ?? item.itemPrice?.amount), number(item.ItemTax?.Amount ?? item.itemTax?.amount), number(item.PromotionDiscount?.Amount ?? item.promotionDiscount?.amount), item, shipping.weight || null, shipping.weightUnit ?? null, shipping.dimensions, catalog ?? {}, sourceKey({}, [orderId, orderItemId, sku, asin])]);
          }
        }
        await batchUpsert(db, {
          table: 'orders',
          columns: ['tenant_id', 'amazon_order_id', 'order_date', 'total_amount', 'status', 'fulfillment_channel', 'sales_channel', 'raw'],
          conflictColumns: ['tenant_id', 'amazon_order_id'],
          updateColumns: ['order_date', 'total_amount', 'status', 'fulfillment_channel', 'sales_channel', 'raw'],
          rows: orderRows
        });
        // source_key (order_id + order-item-id + sku + asin) is the real,
        // always-non-null identity of a line item. sku/asin alone can both
        // be null for the same order (e.g. bundle components), and Postgres
        // never treats two NULLs as a match, so a (tenant_id, amazon_order_id,
        // sku, asin) conflict target could insert duplicate rows for those
        // instead of updating the existing one.
        await batchUpsert(db, {
          table: 'order_items',
          columns: ['tenant_id', 'amazon_order_id', 'asin', 'sku', 'title', 'quantity_ordered', 'item_price', 'item_tax', 'promotion_discount', 'raw', 'package_weight', 'weight_unit', 'package_dimensions', 'catalog_raw', 'source_key'],
          conflictColumns: ['tenant_id', 'source_key'],
          updateColumns: ['amazon_order_id', 'asin', 'sku', 'title', 'quantity_ordered', 'item_price', 'item_tax', 'promotion_discount', 'raw', 'package_weight', 'weight_unit', 'package_dimensions', 'catalog_raw'],
          rows: orderItemRows
        });
        // Backfill catalog facts for previously imported order items as well;
        // otherwise only brand-new orders would ever receive shipping weight.
        // catalog_raw='{}' distinguishes "never attempted" from "attempted
        // and Amazon denied it" (stored as {unavailable:true} below) - without
        // that distinction this query would re-select, and re-attempt, the
        // exact same permission-denied ASINs on every single future sync.
        const missingCatalogItems = (await db.query(
          `select distinct asin from order_items
           where tenant_id=$1 and asin is not null and package_weight is null and catalog_raw = '{}'::jsonb
           limit 25`,
          [parsedTenantId]
        )).rows;
        for (const { asin } of missingCatalogItems) {
          let catalog = catalogCache.get(asin);
          if (!catalogCache.has(asin)) {
            catalog = await fetchCatalogItem(asin);
            catalogCache.set(asin, catalog);
          }
          if (catalog?.unavailable) {
            await db.query('update order_items set catalog_raw=$3 where tenant_id=$1 and asin=$2', [parsedTenantId, asin, catalog]);
            continue;
          }
          const shipping = catalogShippingFacts(catalog);
          await db.query(
            `update order_items set package_weight=$3, weight_unit=$4, package_dimensions=$5, catalog_raw=$6
             where tenant_id=$1 and asin=$2`,
            [parsedTenantId, asin, shipping.weight || null, shipping.weightUnit ?? null, shipping.dimensions, catalog]
          );
        }
        const inventoryRows = inventorySummaries
          .map(summary => [summary, summary.sellerSku ?? summary.SellerSKU ?? summary.sellerSKU])
          .filter(([, sku]) => sku)
          .map(([summary, sku]) => [parsedTenantId, sku, integer(summary.inventoryDetails?.fulfillableQuantity ?? summary.InventoryDetails?.FulfillableQuantity ?? summary.fulfillableQuantity ?? summary.FulfillableQuantity), snapshotDate]);
        inventoryImported = await batchUpsert(db, {
          table: 'inventory_snapshots',
          columns: ['tenant_id', 'sku', 'fulfillable_quantity', 'snapshot_date'],
          conflictColumns: ['tenant_id', 'sku', 'snapshot_date'],
          updateColumns: ['fulfillable_quantity'],
          rows: inventoryRows
        });
        // flattenFinanceTransaction is pure CPU work (no network/DB calls),
        // so every transaction can be flattened up front and every resulting
        // write batched, instead of one delete + N inserts per transaction.
        const financeTransactionRows = [];
        const financeTransactionIds = [];
        const financeItemRows = [];
        const reimbursementRows = [];
        for (const transaction of transactions) {
          const transactionId = transaction.transactionId ?? transaction.TransactionId ?? transaction.financialEventGroupId ?? transaction.FinancialEventGroupId;
          if (!transactionId) continue;
          financeTransactionRows.push([parsedTenantId, transactionId, transaction.transactionType ?? transaction.TransactionType ?? null, transaction.postedDate ?? transaction.PostedDate ?? null, number(transaction.totalAmount?.currencyAmount ?? transaction.TotalAmount?.CurrencyAmount ?? transaction.totalAmount?.Amount ?? transaction.TotalAmount?.Amount), transaction.totalAmount?.currencyCode ?? transaction.TotalAmount?.CurrencyCode ?? 'INR', financeRelatedValue(transaction, ['ORDER_ID', 'AMAZON_ORDER_ID']) ?? null, transaction]);
          financeTransactionIds.push(transactionId);
          // Finances API field casing and nested breakdown names can vary by
          // generation. Persist every source node in raw so classifications
          // that land in `other` can be inspected and improved safely.
          const components = flattenFinanceTransaction(transaction);
          for (const component of components) {
            financeItemRows.push([parsedTenantId, component.transactionId, component.orderId ?? null, component.sku ?? null, component.asin ?? null, component.category, component.description ?? null, component.amount, component.currency ?? 'INR', component.postedDate, component.raw, sourceKey({}, [component.transactionId, component.orderId, component.sku, component.category, component.description, component.amount, component.postedDate])]);
          }
          transactionsImported += 1;
          // transactionType only ever documents "Shipment" as a value - it is
          // a structural field, not a reason. Reimbursement events (SAFE-T,
          // lost/damaged inventory, etc.) are only identifiable by their
          // description/breakdown label, which flattenFinanceTransaction
          // already categorizes correctly via the same rules used everywhere
          // else in the app. Reuse that instead of re-deriving it here from a
          // field that can't actually carry the signal.
          for (const component of components.filter(row => row.category === 'reimbursement')) {
            reimbursementRows.push([parsedTenantId, component.amount, component.description ?? 'Finance reimbursement', component.sku ?? component.orderId ?? transactionId, component.postedDate ?? transaction.postedDate ?? transaction.PostedDate ?? null]);
          }
        }
        // finance_transaction_items is refreshed by deleting a transaction's
        // rows and re-inserting them. Outside a transaction those are separate
        // autocommitted statements, so any dashboard request landing between
        // the delete and the insert reads a table with rows missing and
        // silently reports wrong money for the duration of the sync. Observed
        // live on one tenant and date range across consecutive renders: 4038
        // finance rows, then 1426, then 4038 again. All of it is pure DB work
        // with no Amazon calls in between, so one short transaction makes the
        // refresh atomic without holding a connection across the network.
        await withTenantTransaction(parsedTenantId, async tx => {
          await batchUpsert(tx, {
            table: 'finance_transactions',
            columns: ['tenant_id', 'transaction_id', 'transaction_type', 'posted_date', 'total_amount', 'currency', 'related_order_id', 'raw'],
            conflictColumns: ['tenant_id', 'transaction_id'],
            updateColumns: ['transaction_type', 'posted_date', 'total_amount', 'currency', 'related_order_id', 'raw'],
            rows: financeTransactionRows
          });
          if (financeTransactionIds.length) await tx.query('delete from finance_transaction_items where tenant_id=$1 and transaction_id = any($2::text[])', [parsedTenantId, financeTransactionIds]);
          await batchUpsert(tx, {
            table: 'finance_transaction_items',
            columns: ['tenant_id', 'transaction_id', 'order_id', 'sku', 'asin', 'category', 'amount_description', 'amount', 'currency', 'posted_date', 'raw', 'source_key'],
            rows: financeItemRows
          });
          reimbursementsImported = await batchUpsert(tx, {
            table: 'reimbursements',
            columns: ['tenant_id', 'amount', 'reason', 'sku', 'reimbursement_date'],
            rows: reimbursementRows
          });
        });
      });
      console.log(`[${logLabel}] completed in ${Date.now() - startedAt}ms - ${ordersImported} orders, ${transactionsImported} finance transactions, ${inventoryImported} inventory rows, ${reimbursementsImported} reimbursements` + (ordersWarning ? ` (orders warning: ${ordersWarning})` : '') + (financeResponse?.syncError ? ` (finance warning: ${financeResponse.syncError})` : '') + (inventoryResponse?.syncError ? ` (inventory warning: ${inventoryResponse.syncError})` : ''));
      await pool.query('update sync_jobs set status=$1, completed_at=now() where id=$2', ['completed', sync.rows[0].id]);
      return { ordersImported, transactionsImported, inventoryImported, reimbursementsImported, catalogItemsImported, orderItemsSkipped, incrementalSince: createdAfter, incrementalUntil: createdBefore, ordersWarning, financeWarning: financeResponse?.syncError, inventoryWarning: inventoryResponse?.syncError };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`[${logLabel}] failed after ${Date.now() - startedAt}ms: ${message}`);
      await pool.query('update sync_jobs set status=$1, completed_at=now(), error_message=$2 where id=$3', ['failed', message, sync.rows[0].id]);
      throw error;
    }
  }, 1);
}


/** @param {string} tenantId @param {'b2b'|'b2c'} invoiceType */
export async function buildGstInvoicesFromOrderItems(tenantId, invoiceType) {
  const parsedTenantId = z.string().uuid().parse(tenantId);
  const parsedInvoiceType = z.enum(['b2b', 'b2c']).parse(invoiceType);
  await assertActiveTenant(parsedTenantId);
  return withTenant(parsedTenantId, async db => {
    const result = await db.query(
      `insert into gst_invoices(tenant_id, invoice_type, order_id, taxable_value, cgst, sgst, igst, invoice_date)
       select oi.tenant_id,
         $2,
         oi.amazon_order_id,
         sum(greatest(coalesce(oi.item_price,0) - coalesce(oi.item_tax,0), 0)) taxable_value,
         sum(coalesce(oi.item_tax,0) / 2) cgst,
         sum(coalesce(oi.item_tax,0) / 2) sgst,
         0 igst,
         date(coalesce(o.order_date, now())) invoice_date
       from order_items oi
       left join orders o on o.tenant_id=oi.tenant_id and o.amazon_order_id=oi.amazon_order_id
       where oi.tenant_id=$1
       group by oi.tenant_id, oi.amazon_order_id, date(coalesce(o.order_date, now()))
       on conflict (tenant_id, invoice_type, order_id, invoice_date) do update set
         taxable_value=excluded.taxable_value,
         cgst=excluded.cgst,
         sgst=excluded.sgst,
         igst=excluded.igst`,
      [parsedTenantId, parsedInvoiceType]
    );
    return result.rowCount ?? 0;
  });
}

/** @param {string} reportType */
async function syncActiveTenants(reportType) {
  const parsedReportType = z.enum(REPORT_TYPES).parse(reportType);
  const tenants = await pool.query("select id from tenants where status = 'active'");
  const limit = pLimit(3);
  // One tenant's report failure (e.g. Amazon has no settlement report ready
  // yet for this period) must never stop every other tenant's nightly sync,
  // and must never surface as an unhandled rejection that could take the
  // whole scheduler down. syncReportForTenant already records the failure on
  // the tenant's own sync_jobs row, so it is safe to swallow here.
  await Promise.all(tenants.rows.map(row => limit(() =>
    syncReportForTenant({ tenantId: row.id, reportType: parsedReportType })
      .catch(error => { console.error(`Nightly sync failed for tenant ${row.id} (${parsedReportType}):`, error instanceof Error ? error.message : error); })
  )));
}

export function startScheduler() {
  cron.schedule('0 2 * * *', () => {
    Promise.all(NIGHTLY_REPORTS.map(reportType => syncActiveTenants(reportType)))
      .catch(error => console.error('Nightly sync scheduler run failed:', error instanceof Error ? error.message : error));
  });
}
