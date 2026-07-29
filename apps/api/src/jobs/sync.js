import cron from 'node-cron';
import crypto from 'node:crypto';
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
function minorUnits(value) {
  const cleaned = String(value ?? '0').replace(/[,₹$\s]/g, '');
  const match = cleaned.match(/^(-?)(\d+)(?:\.(\d{0,2}))?$/);
  if (!match) throw new Error(`Invalid Amazon money value: ${value}`);
  return (match[1] === '-' ? -1 : 1) * (BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0')));
}
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
function pick(row, names) {
  const lowerMap = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), value]));
  for (const name of names) {
    const value = lowerMap.get(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (value != null && String(value).trim() !== '') return value;
  }
  return undefined;
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
async function saveSettlementRows(tenantId, content, source) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', content));
  await withTenant(tenantId, async client => {
    for (const [index, row] of rows.entries()) {
      const sourceLineId = crypto.createHash('sha256').update(`${source.reportDocumentId}\n${index + 2}\n${JSON.stringify(row)}`).digest('hex');
      const sourceAmount = pick(row, ['amount']);
      const amountMinor = minorUnits(sourceAmount);
      await client.query(
        `insert into settlement_rows(tenant_id, settlement_id, order_id, amount_type, amount_description, amount, posted_date, raw,
          source_report_id,source_document_id,source_line_number,source_line_id,amount_minor,currency)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (tenant_id,source_report_id,source_line_id) where source_report_id is not null and source_line_id is not null do nothing`,
        [tenantId, text(pick(row, ['settlement-id', 'settlement id', 'settlementId'])), text(pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId'])), text(pick(row, ['amount-type', 'amount type', 'amountType'])), text(pick(row, ['amount-description', 'amount description', 'amountDescription'])), Number(amountMinor) / 100, reportDate(pick(row, ['posted-date-time', 'posted date time', 'postedDateTime', 'posted-date', 'posted date', 'postedDate'])), row, source.reportId, source.reportDocumentId, index + 2, sourceLineId, amountMinor.toString(), text(pick(row,['currency'])) ?? 'INR']
      );
    }
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content @param {'b2b'|'b2c'} invoiceType */
async function saveGstInvoices(tenantId, content, invoiceType) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows(invoiceType === 'b2b' ? 'GET_GST_MTR_B2B_CUSTOM' : 'GET_GST_MTR_B2C_CUSTOM', content));
  await withTenant(tenantId, async client => {
    for (const row of rows) {
      await client.query(
        `insert into gst_invoices(tenant_id, invoice_type, order_id, cgst, sgst, igst, taxable_value, invoice_date, raw)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (tenant_id, invoice_type, order_id, invoice_date) do update set cgst=excluded.cgst, sgst=excluded.sgst, igst=excluded.igst, taxable_value=excluded.taxable_value, raw=excluded.raw`,
        [tenantId, invoiceType, text(pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId'])), number(pick(row, ['cgst', 'cgst tax', 'cgst amount'])), number(pick(row, ['sgst', 'sgst tax', 'sgst amount'])), number(pick(row, ['igst', 'igst tax', 'igst amount'])), number(pick(row, ['taxable-value', 'taxable value', 'taxableValue', 'taxable amount'])), text(pick(row, ['invoice-date', 'invoice date', 'invoiceDate', 'transaction-date', 'transaction date'])) ?? null, row]
      );
    }
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content */
async function saveReturns(tenantId, content) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', content));
  await withTenant(tenantId, async client => {
    for (const row of rows) {
      await client.query(
        `insert into returns(tenant_id, order_id, return_reason, disposition, status, return_date, quantity, raw)
         values($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (tenant_id, order_id, return_date, return_reason, disposition) do update set status=excluded.status, quantity=excluded.quantity, raw=excluded.raw`,
        [tenantId, text(pick(row, ['order-id', 'order id', 'amazon-order-id', 'amazonOrderId'])), text(pick(row, ['reason', 'return-reason', 'return reason', 'returnReason'])), text(pick(row, ['disposition', 'detailed-disposition', 'detailed disposition'])), 'yet_to_receive', text(pick(row, ['return-date', 'return date', 'returnDate', 'date'])) ?? null, pick(row, ['quantity','quantity-returned','return quantity']) == null ? null : integer(pick(row, ['quantity','quantity-returned','return quantity'])), row]
      );
    }
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content */
async function saveReimbursements(tenantId, content) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_FBA_REIMBURSEMENTS_DATA', content));
  await withTenant(tenantId, async client => {
    for (const row of rows) {
      await client.query(
        `insert into reimbursements(tenant_id, amount, reason, sku, reimbursement_date)
         values($1,$2,$3,$4,$5)
         on conflict (tenant_id, sku, reimbursement_date, amount, reason) do nothing`,
        [tenantId, number(pick(row, ['amount', 'total-amount', 'total amount', 'reimbursement amount'])), text(pick(row, ['reason', 'reason-code', 'reason code', 'approval-reason'])), text(pick(row, ['sku', 'seller-sku', 'seller sku'])), text(pick(row, ['reimbursement-date', 'reimbursement date', 'approval-date', 'approval date'])) ?? null]
      );
    }
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content */
async function saveInventorySnapshots(tenantId, content) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', content));
  const snapshotDate = new Date().toISOString().slice(0, 10);
  await withTenant(tenantId, async client => {
    for (const row of rows) {
      const sku = text(pick(row, ['sku', 'seller-sku', 'seller sku']));
      if (!sku) continue;
      await client.query(
        `insert into inventory_snapshots(tenant_id, sku, fulfillable_quantity, snapshot_date)
         values($1,$2,$3,$4)
         on conflict (tenant_id, sku, snapshot_date) do update set fulfillable_quantity=excluded.fulfillable_quantity`,
        [tenantId, sku, integer(pick(row, ['fulfillable-quantity', 'fulfillable quantity', 'afn-fulfillable-quantity', 'afn fulfillable quantity', 'quantity'])), snapshotDate]
      );
    }
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} content */
async function saveSalesTrafficDaily(tenantId, content, range) {
  const rows = z.array(ReportRowSchema).parse(parseReportRows('GET_SALES_AND_TRAFFIC_REPORT', content));
  const fallbackDate = range?.start ? new Date(range.start).toISOString().slice(0, 10) : null;
  await withTenant(tenantId, async client => {
    for (const row of rows) {
      const date = text(pick(row, ['date', 'startDate', 'start-date'])) ?? fallbackDate;
      if (!date) continue;
      const asin = text(pick(row, ['asin', 'parentAsin', 'parent-asin', 'childAsin', 'child-asin'])) ?? 'ALL';
      await client.query(
        `insert into sales_traffic_daily(tenant_id, date, asin, sessions, page_views, units_ordered, ordered_product_sales, featured_offer_percentage, units_refunded, shipped_product_sales, ordered_product_sales_b2b, units_ordered_b2b, total_order_items, total_order_items_b2b, average_sales_per_order_item, average_sales_per_order_item_b2b, average_units_per_order_item, average_units_per_order_item_b2b, average_selling_price, raw)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         on conflict (tenant_id, date, asin) do update set sessions=excluded.sessions, page_views=excluded.page_views, units_ordered=excluded.units_ordered, ordered_product_sales=excluded.ordered_product_sales, featured_offer_percentage=excluded.featured_offer_percentage, units_refunded=excluded.units_refunded, shipped_product_sales=excluded.shipped_product_sales, ordered_product_sales_b2b=excluded.ordered_product_sales_b2b, units_ordered_b2b=excluded.units_ordered_b2b, total_order_items=excluded.total_order_items, total_order_items_b2b=excluded.total_order_items_b2b, average_sales_per_order_item=excluded.average_sales_per_order_item, average_sales_per_order_item_b2b=excluded.average_sales_per_order_item_b2b, average_units_per_order_item=excluded.average_units_per_order_item, average_units_per_order_item_b2b=excluded.average_units_per_order_item_b2b, average_selling_price=excluded.average_selling_price, raw=excluded.raw`,
        [tenantId, date, asin, integer(pick(row, ['sessions', 'sessionsTotal'])), integer(pick(row, ['pageViews', 'page-views', 'page views', 'pageViewsTotal'])), integer(pick(row, ['unitsOrdered', 'units-ordered', 'units ordered'])), number(pick(row, ['orderedProductSales.amount', 'salesByDate.orderedProductSales.amount', 'salesByAsin.orderedProductSales.amount', 'orderedProductSales', 'ordered-product-sales', 'ordered product sales', 'orderedProductSalesAmount', 'amount'])), number(pick(row, ['featuredOfferPercentage', 'featured-offer-percentage', 'featured offer percentage', 'buyBoxPercentage'])), integer(pick(row, ['unitsRefunded', 'units-refunded', 'units refunded'])), number(pick(row, ['shippedProductSales', 'shipped-product-sales', 'shipped product sales', 'shippedProductSalesAmount'])), number(pick(row, ['orderedProductSalesB2B.amount', 'salesByDate.orderedProductSalesB2B.amount', 'salesByAsin.orderedProductSalesB2B.amount', 'orderedProductSalesB2B', 'ordered-product-sales-b2b', 'ordered product sales b2b', 'orderedProductSalesB2BAmount'])), integer(pick(row, ['unitsOrderedB2B', 'units-ordered-b2b', 'units ordered b2b'])), integer(pick(row, ['totalOrderItems', 'total-order-items', 'total order items'])), integer(pick(row, ['totalOrderItemsB2B', 'total-order-items-b2b', 'total order items b2b'])), number(pick(row, ['averageSalesPerOrderItem.amount', 'salesByDate.averageSalesPerOrderItem.amount', 'salesByAsin.averageSalesPerOrderItem.amount', 'averageSalesPerOrderItem', 'average-sales-per-order-item', 'average sales per order item'])), number(pick(row, ['averageSalesPerOrderItemB2B.amount', 'salesByDate.averageSalesPerOrderItemB2B.amount', 'salesByAsin.averageSalesPerOrderItemB2B.amount', 'averageSalesPerOrderItemB2B', 'average-sales-per-order-item-b2b', 'average sales per order item b2b'])), number(pick(row, ['averageUnitsPerOrderItem', 'average-units-per-order-item', 'average units per order item'])), number(pick(row, ['averageUnitsPerOrderItemB2B', 'average-units-per-order-item-b2b', 'average units per order item b2b'])), number(pick(row, ['averageSellingPrice.amount', 'salesByDate.averageSellingPrice.amount', 'salesByAsin.averageSellingPrice.amount', 'averageSellingPrice', 'average-selling-price', 'average selling price'])), row]
      );
    }
  });
  return rows.length;
}

/** @param {string} tenantId @param {string} reportType @param {string} content */
async function saveStructuredRows(tenantId, reportType, content, range, source = {}) {
  switch (reportType) {
    case 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2': return saveSettlementRows(tenantId, content, source);
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
    const sync = await pool.query('insert into sync_jobs(tenant_id, report_type, status, started_at) values($1,$2,$3,now()) returning id', [parsed.tenantId, parsed.reportType, 'running']);
    try {
      const seller = await pool.query("select refresh_token_encrypted, marketplace_id from sellers where tenant_id = $1 and auth_status = 'authorized' order by connected_at desc limit 1", [parsed.tenantId]);
      if (!seller.rowCount) throw new Error('No connected Amazon seller account');
      const client = new SpApiClient(decryptSecret(seller.rows[0].refresh_token_encrypted), { baseUrl: getSpApiEndpoint(seller.rows[0].marketplace_id) });
      const report = await client.fetchReport(parsed.reportType, parsed.tenantId, range, seller.rows[0].marketplace_id);
      const documents = report.documents ?? [report];
      let rowsImported = 0;
      let s3Key = null;
      for (const document of documents) {
        s3Key = await putRawReport({ tenantId: parsed.tenantId, reportType: parsed.reportType, reportId: document.reportId, content: document.content });
        if (parsed.reportType === 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2') await withTenant(parsed.tenantId, db => db.query(
          `insert into settlement_report_documents(tenant_id,report_id,report_document_id,marketplace_id,data_start_time,data_end_time,created_time,raw_key)
           values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(tenant_id,report_id) do update set report_document_id=excluded.report_document_id,raw_key=excluded.raw_key,imported_at=now()`,
          [parsed.tenantId,document.reportId,document.reportDocumentId,seller.rows[0].marketplace_id,document.dataStartTime,document.dataEndTime,document.createdTime??null,s3Key]
        ));
        rowsImported += await saveStructuredRows(parsed.tenantId, parsed.reportType, document.content, range, document);
      }
      await pool.query('update sync_jobs set status=$1, completed_at=now(), s3_key=$2 where id=$3', ['completed', s3Key, sync.rows[0].id]);
      return { rowsImported, s3Key };
    } catch (error) {
      await pool.query('update sync_jobs set status=$1, completed_at=now(), error_message=$2 where id=$3', ['failed', error instanceof Error ? error.message : 'unknown error', sync.rows[0].id]);
      throw error;
    }
  }, 1);
}


/** @param {string} tenantId @param {{ days?: number }} [options] */
export async function syncRecentApiDataForTenant(tenantId, options = {}) {
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
    const sync = await pool.query('insert into sync_jobs(tenant_id, report_type, status, started_at) values($1,$2,$3,now()) returning id', [parsedTenantId, 'DIRECT_SP_API_SYNC', 'running']);
    try {
      const seller = await pool.query("select refresh_token_encrypted, marketplace_id from sellers where tenant_id = $1 and auth_status = 'authorized' order by connected_at desc limit 1", [parsedTenantId]);
      if (!seller.rowCount) throw new Error('No connected Amazon seller account');
      const marketplaceId = seller.rows[0].marketplace_id;
      const client = new SpApiClient(decryptSecret(seller.rows[0].refresh_token_encrypted), { baseUrl: getSpApiEndpoint(marketplaceId) });
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
      await withTenant(parsedTenantId, async db => {
        let orderItemsFetched = 0;
        for (const order of orders) {
          const orderId = order.AmazonOrderId ?? order.amazonOrderId;
          if (!orderId) continue;
          await db.query(
            `insert into orders(tenant_id, amazon_order_id, order_date, total_amount, status, fulfillment_channel, sales_channel, raw)
             values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
             on conflict (tenant_id, amazon_order_id) do update set order_date=excluded.order_date, total_amount=excluded.total_amount,
               status=excluded.status, fulfillment_channel=excluded.fulfillment_channel, sales_channel=excluded.sales_channel, raw=excluded.raw`,
            [parsedTenantId, orderId, order.PurchaseDate ?? order.purchaseDate ?? null, number(order.OrderTotal?.Amount ?? order.orderTotal?.amount), order.OrderStatus ?? order.orderStatus ?? null, order.FulfillmentChannel ?? order.fulfillmentChannel ?? null, order.SalesChannel ?? order.salesChannel ?? null, JSON.stringify(order)]
          );
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
              catalog = await client.getCatalogItem(asin, marketplaceId).catch(() => null);
              catalogCache.set(asin, catalog);
              if (catalog) catalogItemsImported += 1;
            }
            const shipping = catalogShippingFacts(catalog);
            await db.query(
              `insert into order_items(tenant_id, amazon_order_id, asin, sku, title, quantity_ordered, item_price, item_tax, promotion_discount, raw, package_weight, weight_unit, package_dimensions, catalog_raw)
               values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
               on conflict (tenant_id, amazon_order_id, sku, asin) do update set title=excluded.title, quantity_ordered=excluded.quantity_ordered, item_price=excluded.item_price, item_tax=excluded.item_tax, promotion_discount=excluded.promotion_discount, raw=excluded.raw,
                 package_weight=excluded.package_weight, weight_unit=excluded.weight_unit, package_dimensions=excluded.package_dimensions, catalog_raw=excluded.catalog_raw`,
              [parsedTenantId, orderId, asin, item.SellerSKU ?? item.sellerSku ?? null, item.Title ?? item.title ?? null, integer(item.QuantityOrdered ?? item.quantityOrdered), number(item.ItemPrice?.Amount ?? item.itemPrice?.amount), number(item.ItemTax?.Amount ?? item.itemTax?.amount), number(item.PromotionDiscount?.Amount ?? item.promotionDiscount?.amount), item, shipping.weight || null, shipping.weightUnit ?? null, shipping.dimensions, catalog ?? {}]
            );
          }
        }
        // Backfill catalog facts for previously imported order items as well;
        // otherwise only brand-new orders would ever receive shipping weight.
        const missingCatalogItems = (await db.query(
          `select distinct asin from order_items
           where tenant_id=$1 and asin is not null and package_weight is null
           limit 25`,
          [parsedTenantId]
        )).rows;
        for (const { asin } of missingCatalogItems) {
          let catalog = catalogCache.get(asin);
          if (!catalogCache.has(asin)) {
            catalog = await client.getCatalogItem(asin, marketplaceId).catch(() => null);
            catalogCache.set(asin, catalog);
            if (catalog) catalogItemsImported += 1;
          }
          if (!catalog) continue;
          const shipping = catalogShippingFacts(catalog);
          await db.query(
            `update order_items set package_weight=$3, weight_unit=$4, package_dimensions=$5, catalog_raw=$6
             where tenant_id=$1 and asin=$2`,
            [parsedTenantId, asin, shipping.weight || null, shipping.weightUnit ?? null, shipping.dimensions, catalog]
          );
        }
        for (const summary of inventorySummaries) {
          const sku = summary.sellerSku ?? summary.SellerSKU ?? summary.sellerSKU;
          if (!sku) continue;
          const fulfillableQuantity = summary.inventoryDetails?.fulfillableQuantity ?? summary.InventoryDetails?.FulfillableQuantity ?? summary.fulfillableQuantity ?? summary.FulfillableQuantity;
          await db.query(
            `insert into inventory_snapshots(tenant_id, sku, fulfillable_quantity, snapshot_date)
             values($1,$2,$3,$4)
             on conflict (tenant_id, sku, snapshot_date) do update set fulfillable_quantity=excluded.fulfillable_quantity`,
            [parsedTenantId, sku, integer(fulfillableQuantity), snapshotDate]
          );
          inventoryImported += 1;
        }
        for (const transaction of transactions) {
          const transactionId = transaction.transactionId ?? transaction.TransactionId ?? transaction.financialEventGroupId ?? transaction.FinancialEventGroupId;
          if (!transactionId) continue;
          await db.query(
            `insert into finance_transactions(tenant_id, transaction_id, transaction_type, posted_date, total_amount, currency, related_order_id, raw)
             values($1,$2,$3,$4,$5,$6,$7,$8)
             on conflict (tenant_id, transaction_id) do update set transaction_type=excluded.transaction_type, posted_date=excluded.posted_date, total_amount=excluded.total_amount, currency=excluded.currency, related_order_id=excluded.related_order_id, raw=excluded.raw`,
            [parsedTenantId, transactionId, transaction.transactionType ?? transaction.TransactionType ?? null, transaction.postedDate ?? transaction.PostedDate ?? null, number(transaction.totalAmount?.currencyAmount ?? transaction.TotalAmount?.CurrencyAmount ?? transaction.totalAmount?.Amount ?? transaction.TotalAmount?.Amount), transaction.totalAmount?.currencyCode ?? transaction.TotalAmount?.CurrencyCode ?? 'INR', financeRelatedValue(transaction, ['ORDER_ID', 'AMAZON_ORDER_ID']) ?? null, transaction]
          );
          // Finances API field casing and nested breakdown names can vary by
          // generation. Persist every source node in raw so classifications
          // that land in `other` can be inspected and improved safely.
          await db.query('delete from finance_transaction_items where tenant_id=$1 and transaction_id=$2', [parsedTenantId, transactionId]);
          for (const component of flattenFinanceTransaction(transaction)) {
            await db.query(
              `insert into finance_transaction_items(tenant_id, transaction_id, order_id, sku, asin, category, amount_description, amount, currency, posted_date, raw)
               values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,
              [parsedTenantId, component.transactionId, component.orderId ?? null, component.sku ?? null, component.asin ?? null, component.category, component.description ?? null, component.amount, component.currency ?? 'INR', component.postedDate, component.raw]
            );
          }
          transactionsImported += 1;
          const transactionType = String(transaction.transactionType ?? transaction.TransactionType ?? '').toLowerCase();
          if (transactionType.includes('reimbursement')) {
            await db.query(
              `insert into reimbursements(tenant_id, amount, reason, sku, reimbursement_date)
               values($1,$2,$3,$4,$5)
               on conflict (tenant_id, sku, reimbursement_date, amount, reason) do nothing`,
              [parsedTenantId, number(transaction.totalAmount?.currencyAmount ?? transaction.TotalAmount?.CurrencyAmount ?? transaction.totalAmount?.Amount ?? transaction.TotalAmount?.Amount), transaction.transactionType ?? transaction.TransactionType ?? 'Finance reimbursement', financeRelatedValue(transaction, ['SKU']) ?? transactionId, transaction.postedDate ?? transaction.PostedDate ?? null]
            );
            reimbursementsImported += 1;
          }
        }
      });
      await pool.query('update sync_jobs set status=$1, completed_at=now() where id=$2', ['completed', sync.rows[0].id]);
      return { ordersImported, transactionsImported, inventoryImported, reimbursementsImported, catalogItemsImported, orderItemsSkipped, incrementalSince: createdAfter, incrementalUntil: createdBefore, ordersWarning, financeWarning: financeResponse?.syncError, inventoryWarning: inventoryResponse?.syncError };
    } catch (error) {
      await pool.query('update sync_jobs set status=$1, completed_at=now(), error_message=$2 where id=$3', ['failed', error instanceof Error ? error.message : 'unknown error', sync.rows[0].id]);
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
  await Promise.all(tenants.rows.map(row => limit(() => syncReportForTenant({ tenantId: row.id, reportType: parsedReportType }))));
}

export function startScheduler() {
  cron.schedule('0 2 * * *', () => { void Promise.all(NIGHTLY_REPORTS.map(reportType => syncActiveTenants(reportType))); });
}
