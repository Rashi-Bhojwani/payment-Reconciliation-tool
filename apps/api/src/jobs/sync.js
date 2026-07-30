import cron from 'node-cron';
import pLimit from 'p-limit';
import { z } from 'zod';
import { assertActiveTenant, pool, withTenant } from '@recon/db';
import { getSpApiEndpoint, MARKETPLACES, REPORT_TYPES, SpApiClient } from '@recon/sp-api-client';
import { decryptSecret } from '../config/crypto.js';
import { putRawReport } from '../storage/s3.js';
import { runJob } from './runner.js';
import { categorizeFinanceLabel, flattenFinanceTransaction } from './finance-components.js';
import {
  parseAmazonAmount,
  parseAmazonInteger,
  parseGstReport,
  parseInventoryReport,
  parseReimbursementsReport,
  parseReturnsReport,
  parseSalesTrafficReport,
  parseSettlementReport,
  sourceKey,
  text
} from './report-normalization.js';

export { categorizeFinanceLabel } from './finance-components.js';

const NIGHTLY_REPORTS = [...REPORT_TYPES];
const SyncParamsSchema = z.object({
  tenantId: z.string().uuid(),
  reportType: z.enum(REPORT_TYPES),
  range: z.object({ start: z.string().datetime(), end: z.string().datetime() }).optional()
});

function firstAttribute(attributes, names) {
  for (const name of names) {
    const value = attributes?.[name];
    if (Array.isArray(value) && value[0]) return value[0];
  }
  return undefined;
}

function marketplaceDate(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const part = name => parts.find(item => item.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function catalogShippingFacts(catalog) {
  const attributes = catalog?.attributes ?? catalog?.payload?.attributes ?? {};
  const weight = firstAttribute(attributes, ['item_package_weight', 'item_weight']);
  const dimensions = firstAttribute(attributes, ['item_package_dimensions', 'item_dimensions']);
  const dimensionText = dimensions
    ? [dimensions.length, dimensions.width, dimensions.height].filter(value => value != null).join(' × ')
      + (dimensions.unit ? ` ${dimensions.unit}` : '')
    : null;
  return {
    weight: parseAmazonAmount(weight?.value),
    weightUnit: text(weight?.unit),
    dimensions: dimensionText
  };
}

function financeRelatedValue(transaction, wantedNames) {
  const identifiers = transaction?.relatedIdentifiers ?? transaction?.RelatedIdentifiers;
  if (Array.isArray(identifiers)) {
    const wanted = new Set(wantedNames.map(name => name.toUpperCase()));
    const match = identifiers.find(identifier => wanted.has(
      String(identifier?.relatedIdentifierName ?? identifier?.RelatedIdentifierName ?? '').toUpperCase()
    ));
    return text(match?.relatedIdentifierValue ?? match?.RelatedIdentifierValue);
  }
  for (const name of wantedNames) {
    const camelName = name.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = identifiers?.[camelName] ?? identifiers?.[name] ?? identifiers?.[name.toLowerCase()];
    if (value) return text(value);
  }
  return undefined;
}

function financeMetadata(transaction) {
  const metadata = transaction?.sellingPartnerMetadata
    ?? transaction?.SellingPartnerMetadata
    ?? {};
  return {
    status: text(transaction?.transactionStatus ?? transaction?.TransactionStatus),
    description: text(transaction?.description ?? transaction?.Description),
    accountType: text(metadata.accountType ?? metadata.AccountType ?? transaction?.accountType ?? transaction?.AccountType),
    marketplaceId: text(metadata.marketplaceId ?? metadata.MarketplaceId ?? transaction?.marketplaceId)
  };
}

function moneyValue(node) {
  if (!node || typeof node !== 'object') return parseAmazonAmount(node);
  return parseAmazonAmount(node.amount ?? node.Amount ?? node.currencyAmount ?? node.CurrencyAmount);
}

function orderBreakdownAmount(breakdowns, type) {
  return (breakdowns ?? [])
    .filter(item => String(item?.type ?? item?.Type ?? '').toUpperCase() === type)
    .reduce((sum, item) => sum + moneyValue(item?.subtotal ?? item?.Subtotal), 0);
}

function normalizeOrder(order) {
  const legacy = Boolean(order?.AmazonOrderId ?? order?.amazonOrderId);
  if (legacy) {
    return {
      orderId: order.AmazonOrderId ?? order.amazonOrderId,
      createdTime: order.PurchaseDate ?? order.purchaseDate,
      lastUpdatedTime: order.LastUpdateDate ?? order.lastUpdateDate,
      status: order.OrderStatus ?? order.orderStatus,
      fulfillmentChannel: order.FulfillmentChannel ?? order.fulfillmentChannel,
      salesChannel: order.SalesChannel ?? order.salesChannel,
      totalAmount: moneyValue(order.OrderTotal ?? order.orderTotal),
      items: order.OrderItems ?? order.orderItems ?? [],
      raw: order
    };
  }
  return {
    orderId: order.orderId,
    createdTime: order.createdTime,
    lastUpdatedTime: order.lastUpdatedTime,
    status: order.fulfillment?.fulfillmentStatus,
    fulfillmentChannel: order.fulfillment?.fulfilledBy === 'AMAZON'
      ? 'AFN'
      : order.fulfillment?.fulfilledBy === 'MERCHANT'
        ? 'MFN'
        : order.fulfillment?.fulfilledBy,
    salesChannel: order.salesChannel?.marketplaceName ?? order.salesChannel?.channelName,
    totalAmount: moneyValue(order.proceeds?.grandTotal),
    items: order.orderItems ?? [],
    raw: order
  };
}

function normalizeOrderItem(orderId, item) {
  const legacy = Boolean(item?.OrderItemId ?? item?.SellerSKU ?? item?.ASIN);
  const quantity = parseAmazonInteger(item.quantityOrdered ?? item.QuantityOrdered);
  const product = item.product ?? {};
  const proceeds = item.proceeds?.breakdowns ?? [];
  const orderItemId = text(item.orderItemId ?? item.OrderItemId);
  const unitPrice = moneyValue(product.price?.unitPrice);
  const itemPrice = legacy
    ? moneyValue(item.ItemPrice ?? item.itemPrice)
    : orderBreakdownAmount(proceeds, 'ITEM') || unitPrice * quantity;
  const itemTax = legacy
    ? moneyValue(item.ItemTax ?? item.itemTax)
    : orderBreakdownAmount(proceeds, 'TAX');
  const discount = legacy
    ? moneyValue(item.PromotionDiscount ?? item.promotionDiscount)
    : Math.abs(orderBreakdownAmount(proceeds, 'DISCOUNT'));
  return {
    sourceKey: orderItemId
      ? `orders-v2026:${orderId}:${orderItemId}`
      : sourceKey('ORDERS_API_ITEM', {
        orderId,
        asin: product.asin ?? item.ASIN ?? item.asin,
        sku: product.sellerSku ?? item.SellerSKU ?? item.sellerSku,
        quantity,
        itemPrice
      }),
    orderItemId,
    asin: text(product.asin ?? item.ASIN ?? item.asin),
    sku: text(product.sellerSku ?? item.SellerSKU ?? item.sellerSku),
    title: text(product.title ?? item.Title ?? item.title),
    quantity,
    itemPrice,
    itemTax,
    promotionDiscount: discount,
    currency: text(
      product.price?.unitPrice?.currencyCode
      ?? item.ItemPrice?.CurrencyCode
      ?? item.itemPrice?.currencyCode
    ),
    raw: item
  };
}

async function transaction(client, work) {
  await client.query('begin');
  try {
    const result = await work();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function saveSettlementRows(tenantId, content, reportId) {
  const parsed = parseSettlementReport(content, reportId);
  await withTenant(tenantId, client => transaction(client, async () => {
    for (const statement of parsed.statements) {
      await client.query(
        `insert into settlement_statements(
           tenant_id,settlement_id,settlement_start_date,settlement_end_date,deposit_date,total_amount,currency,report_id,raw
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict(tenant_id,settlement_id) do update set
           settlement_start_date=excluded.settlement_start_date,
           settlement_end_date=excluded.settlement_end_date,
           deposit_date=excluded.deposit_date,
           total_amount=excluded.total_amount,
           currency=excluded.currency,
           report_id=excluded.report_id,
           raw=excluded.raw`,
        [
          tenantId,
          statement.settlementId,
          statement.settlementStartDate,
          statement.settlementEndDate,
          statement.depositDate,
          statement.totalAmount,
          statement.currency,
          statement.reportId,
          statement.raw
        ]
      );
    }
    for (const row of parsed.rows) {
      await client.query(
        `insert into settlement_rows(
           tenant_id,source_key,report_id,settlement_id,order_id,transaction_type,amount_type,amount_description,
           amount,currency,posted_date,order_item_code,sku,quantity,raw
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         on conflict(tenant_id,source_key) do update set
           report_id=excluded.report_id,
           settlement_id=excluded.settlement_id,
           order_id=excluded.order_id,
           transaction_type=excluded.transaction_type,
           amount_type=excluded.amount_type,
           amount_description=excluded.amount_description,
           amount=excluded.amount,
           currency=excluded.currency,
           posted_date=excluded.posted_date,
           order_item_code=excluded.order_item_code,
           sku=excluded.sku,
           quantity=excluded.quantity,
           raw=excluded.raw`,
        [
          tenantId,
          row.sourceKey,
          row.reportId,
          row.settlementId,
          row.orderId,
          row.transactionType,
          row.amountType,
          row.amountDescription,
          row.amount,
          row.currency,
          row.postedDate,
          row.orderItemCode,
          row.sku,
          row.quantity,
          row.raw
        ]
      );
    }
  }));
  return parsed.rows.length;
}

async function saveGstInvoices(tenantId, content, invoiceType, range, timeZone) {
  const rows = parseGstReport(content, invoiceType);
  await withTenant(tenantId, client => transaction(client, async () => {
    await client.query(
      `delete from gst_invoices
       where tenant_id=$1 and invoice_type=$2
         and invoice_date >= timezone($5,$3::timestamptz)::date
         and invoice_date < timezone($5,$4::timestamptz)::date`,
      [tenantId, invoiceType, range.start, range.end, timeZone]
    );
    for (const row of rows) {
      await client.query(
        `insert into gst_invoices(
           tenant_id,source_key,invoice_type,order_id,document_number,line_id,transaction_type,sku,asin,quantity,
           taxable_value,invoice_amount,tax_total,cgst,sgst,utgst,igst,cess,invoice_date,raw
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         on conflict(tenant_id,source_key) do update set
           order_id=excluded.order_id,
           document_number=excluded.document_number,
           line_id=excluded.line_id,
           transaction_type=excluded.transaction_type,
           sku=excluded.sku,
           asin=excluded.asin,
           quantity=excluded.quantity,
           taxable_value=excluded.taxable_value,
           invoice_amount=excluded.invoice_amount,
           tax_total=excluded.tax_total,
           cgst=excluded.cgst,
           sgst=excluded.sgst,
           utgst=excluded.utgst,
           igst=excluded.igst,
           cess=excluded.cess,
           invoice_date=excluded.invoice_date,
           raw=excluded.raw`,
        [
          tenantId,
          row.sourceKey,
          row.invoiceType,
          row.orderId,
          row.documentNumber,
          row.lineId,
          row.transactionType,
          row.sku,
          row.asin,
          row.quantity,
          row.taxableValue,
          row.invoiceAmount,
          row.taxTotal,
          row.cgst,
          row.sgst,
          row.utgst,
          row.igst,
          row.cess,
          row.invoiceDate,
          row.raw
        ]
      );
    }
  }));
  return rows.length;
}

async function saveReturns(tenantId, content, range, timeZone) {
  const rows = parseReturnsReport(content);
  await withTenant(tenantId, client => transaction(client, async () => {
    await client.query(
      `delete from returns
       where tenant_id=$1
         and return_date >= timezone($4,$2::timestamptz)::date
         and return_date < timezone($4,$3::timestamptz)::date`,
      [tenantId, range.start, range.end, timeZone]
    );
    for (const row of rows) {
      await client.query(
        `insert into returns(
           tenant_id,source_key,order_id,order_item_id,sku,asin,fnsku,return_reason,disposition,status,
           amazon_status,return_date,quantity,fulfillment_center_id,raw
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         on conflict(tenant_id,source_key) do update set
           order_id=excluded.order_id,
           order_item_id=excluded.order_item_id,
           sku=excluded.sku,
           asin=excluded.asin,
           fnsku=excluded.fnsku,
           return_reason=excluded.return_reason,
           disposition=excluded.disposition,
           status=excluded.status,
           amazon_status=excluded.amazon_status,
           return_date=excluded.return_date,
           quantity=excluded.quantity,
           fulfillment_center_id=excluded.fulfillment_center_id,
           raw=excluded.raw`,
        [
          tenantId,
          row.sourceKey,
          row.orderId,
          row.orderItemId,
          row.sku,
          row.asin,
          row.fnsku,
          row.returnReason,
          row.disposition,
          row.status,
          row.amazonStatus,
          row.returnDate,
          row.quantity,
          row.fulfillmentCenterId,
          row.raw
        ]
      );
    }
  }));
  return rows.length;
}

async function saveReimbursements(tenantId, content, range, timeZone) {
  const rows = parseReimbursementsReport(content);
  await withTenant(tenantId, client => transaction(client, async () => {
    await client.query(
      `delete from reimbursements
       where tenant_id=$1
         and reimbursement_date >= timezone($4,$2::timestamptz)::date
         and reimbursement_date < timezone($4,$3::timestamptz)::date`,
      [tenantId, range.start, range.end, timeZone]
    );
    for (const row of rows) {
      await client.query(
        `insert into reimbursements(
           tenant_id,source_key,reimbursement_id,order_id,amount,amount_per_unit,currency,reason,sku,fnsku,asin,
           quantity_cash,quantity_inventory,quantity_total,reimbursement_date,raw
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         on conflict(tenant_id,source_key) do update set
           reimbursement_id=excluded.reimbursement_id,
           order_id=excluded.order_id,
           amount=excluded.amount,
           amount_per_unit=excluded.amount_per_unit,
           currency=excluded.currency,
           reason=excluded.reason,
           sku=excluded.sku,
           fnsku=excluded.fnsku,
           asin=excluded.asin,
           quantity_cash=excluded.quantity_cash,
           quantity_inventory=excluded.quantity_inventory,
           quantity_total=excluded.quantity_total,
           reimbursement_date=excluded.reimbursement_date,
           raw=excluded.raw`,
        [
          tenantId,
          row.sourceKey,
          row.reimbursementId,
          row.orderId,
          row.amount,
          row.amountPerUnit,
          row.currency,
          row.reason,
          row.sku,
          row.fnsku,
          row.asin,
          row.quantityCash,
          row.quantityInventory,
          row.quantityTotal,
          row.reimbursementDate,
          row.raw
        ]
      );
    }
  }));
  return rows.length;
}

async function saveInventorySnapshots(tenantId, content, snapshotDate) {
  const rows = parseInventoryReport(content, snapshotDate);
  await withTenant(tenantId, client => transaction(client, async () => {
    await client.query(
      'delete from inventory_snapshots where tenant_id=$1 and snapshot_date=$2',
      [tenantId, snapshotDate]
    );
    for (const row of rows) {
      await client.query(
        `insert into inventory_snapshots(tenant_id,sku,fulfillable_quantity,snapshot_date)
         values($1,$2,$3,$4)
         on conflict(tenant_id,sku,snapshot_date) do update set fulfillable_quantity=excluded.fulfillable_quantity`,
        [tenantId, row.sku, row.fulfillableQuantity, row.snapshotDate]
      );
    }
  }));
  return rows.length;
}

async function saveSalesTraffic(tenantId, content, range) {
  const parsed = parseSalesTrafficReport(content, {
    start: marketplaceDate(new Date(range.start), range.timeZone),
    end: marketplaceDate(new Date(new Date(range.end).getTime() - 1), range.timeZone)
  });
  await withTenant(tenantId, client => transaction(client, async () => {
    await client.query(
      `delete from sales_traffic_daily
       where tenant_id=$1 and asin='ALL'
         and date >= timezone($4,$2::timestamptz)::date
         and date < timezone($4,$3::timestamptz)::date`,
      [tenantId, range.start, range.end, range.timeZone]
    );
    const periods = [...new Set([
      parsed.periodStart && parsed.periodEnd ? `${parsed.periodStart}|${parsed.periodEnd}` : null,
      ...parsed.asin.map(row => `${row.periodStart}|${row.periodEnd}`)
    ].filter(Boolean))];
    for (const period of periods) {
      const [periodStart, periodEnd] = period.split('|');
      if (!periodStart || !periodEnd) continue;
      await client.query(
        'delete from sales_traffic_asin where tenant_id=$1 and period_start=$2 and period_end=$3',
        [tenantId, periodStart, periodEnd]
      );
    }
    for (const row of parsed.daily) {
      await client.query(
        `insert into sales_traffic_daily(
           tenant_id,date,asin,sessions,page_views,browser_sessions,mobile_app_sessions,browser_page_views,mobile_app_page_views,
           units_ordered,ordered_product_sales,featured_offer_percentage,units_refunded,refund_rate,shipped_product_sales,
           units_shipped,orders_shipped,ordered_product_sales_b2b,units_ordered_b2b,total_order_items,total_order_items_b2b,
           average_sales_per_order_item,average_sales_per_order_item_b2b,average_units_per_order_item,
           average_units_per_order_item_b2b,average_selling_price,unit_session_percentage,order_item_session_percentage,
           currency,raw
         ) values($1,$2,'ALL',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
         on conflict(tenant_id,date,asin) do update set
           sessions=excluded.sessions,
           page_views=excluded.page_views,
           browser_sessions=excluded.browser_sessions,
           mobile_app_sessions=excluded.mobile_app_sessions,
           browser_page_views=excluded.browser_page_views,
           mobile_app_page_views=excluded.mobile_app_page_views,
           units_ordered=excluded.units_ordered,
           ordered_product_sales=excluded.ordered_product_sales,
           featured_offer_percentage=excluded.featured_offer_percentage,
           units_refunded=excluded.units_refunded,
           refund_rate=excluded.refund_rate,
           shipped_product_sales=excluded.shipped_product_sales,
           units_shipped=excluded.units_shipped,
           orders_shipped=excluded.orders_shipped,
           ordered_product_sales_b2b=excluded.ordered_product_sales_b2b,
           units_ordered_b2b=excluded.units_ordered_b2b,
           total_order_items=excluded.total_order_items,
           total_order_items_b2b=excluded.total_order_items_b2b,
           average_sales_per_order_item=excluded.average_sales_per_order_item,
           average_sales_per_order_item_b2b=excluded.average_sales_per_order_item_b2b,
           average_units_per_order_item=excluded.average_units_per_order_item,
           average_units_per_order_item_b2b=excluded.average_units_per_order_item_b2b,
           average_selling_price=excluded.average_selling_price,
           unit_session_percentage=excluded.unit_session_percentage,
           order_item_session_percentage=excluded.order_item_session_percentage,
           currency=excluded.currency,
           raw=excluded.raw`,
        [
          tenantId,
          row.date,
          row.sessions,
          row.pageViews,
          row.browserSessions,
          row.mobileAppSessions,
          row.browserPageViews,
          row.mobileAppPageViews,
          row.unitsOrdered,
          row.orderedProductSales,
          row.featuredOfferPercentage,
          row.unitsRefunded,
          row.refundRate,
          row.shippedProductSales,
          row.unitsShipped,
          row.ordersShipped,
          row.orderedProductSalesB2b,
          row.unitsOrderedB2b,
          row.totalOrderItems,
          row.totalOrderItemsB2b,
          row.averageSalesPerOrderItem,
          row.averageSalesPerOrderItemB2b,
          row.averageUnitsPerOrderItem,
          row.averageUnitsPerOrderItemB2b,
          row.averageSellingPrice,
          row.unitSessionPercentage,
          row.orderItemSessionPercentage,
          row.currency,
          row.raw
        ]
      );
    }
    for (const row of parsed.asin) {
      await client.query(
        `insert into sales_traffic_asin(
           tenant_id,period_start,period_end,parent_asin,child_asin,sku,sessions,page_views,browser_sessions,
           mobile_app_sessions,browser_page_views,mobile_app_page_views,units_ordered,total_order_items,
           ordered_product_sales,featured_offer_percentage,unit_session_percentage,currency,raw
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         on conflict(tenant_id,period_start,period_end,parent_asin,child_asin,sku) do update set
           sessions=excluded.sessions,
           page_views=excluded.page_views,
           browser_sessions=excluded.browser_sessions,
           mobile_app_sessions=excluded.mobile_app_sessions,
           browser_page_views=excluded.browser_page_views,
           mobile_app_page_views=excluded.mobile_app_page_views,
           units_ordered=excluded.units_ordered,
           total_order_items=excluded.total_order_items,
           ordered_product_sales=excluded.ordered_product_sales,
           featured_offer_percentage=excluded.featured_offer_percentage,
           unit_session_percentage=excluded.unit_session_percentage,
           currency=excluded.currency,
           raw=excluded.raw`,
        [
          tenantId,
          row.periodStart,
          row.periodEnd,
          row.parentAsin ?? '',
          row.childAsin ?? '',
          row.sku ?? '',
          row.sessions,
          row.pageViews,
          row.browserSessions,
          row.mobileAppSessions,
          row.browserPageViews,
          row.mobileAppPageViews,
          row.unitsOrdered,
          row.totalOrderItems,
          row.orderedProductSales,
          row.featuredOfferPercentage,
          row.unitSessionPercentage,
          row.currency,
          row.raw
        ]
      );
    }
  }));
  return parsed.daily.length + parsed.asin.length;
}

async function saveStructuredRows(tenantId, reportType, content, range, reportId, timeZone) {
  switch (reportType) {
    case 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2':
      return saveSettlementRows(tenantId, content, reportId);
    case 'GET_GST_MTR_B2B_CUSTOM':
      return saveGstInvoices(tenantId, content, 'b2b', range, timeZone);
    case 'GET_GST_MTR_B2C_CUSTOM':
      return saveGstInvoices(tenantId, content, 'b2c', range, timeZone);
    case 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA':
      return saveReturns(tenantId, content, range, timeZone);
    case 'GET_FBA_REIMBURSEMENTS_DATA':
      return saveReimbursements(tenantId, content, range, timeZone);
    case 'GET_SALES_AND_TRAFFIC_REPORT':
      return saveSalesTraffic(tenantId, content, { ...range, timeZone });
    case 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA':
      return saveInventorySnapshots(tenantId, content, marketplaceDate(new Date(), timeZone));
    default:
      return 0;
  }
}

export async function syncReportForTenant(params) {
  const parsed = SyncParamsSchema.parse(params);
  const range = parsed.range ?? {
    start: new Date(Date.now() - 30 * 864e5).toISOString(),
    end: new Date().toISOString()
  };
  await assertActiveTenant(parsed.tenantId);
  return runJob(`sync:${parsed.reportType}:${parsed.tenantId}`, async () => {
    const sync = await pool.query(
      `insert into sync_jobs(tenant_id,report_type,status,started_at,data_start_time,data_end_time)
       values($1,$2,'running',now(),$3,$4) returning id`,
      [parsed.tenantId, parsed.reportType, range.start, range.end]
    );
    try {
      const seller = await pool.query(
        `select refresh_token_encrypted,marketplace_id
         from sellers
         where tenant_id=$1 and auth_status='authorized'
         order by connected_at desc limit 1`,
        [parsed.tenantId]
      );
      if (!seller.rowCount) throw new Error('No connected Amazon seller account');
      const marketplaceId = seller.rows[0].marketplace_id;
      const marketplaceTimeZone = MARKETPLACES[marketplaceId]?.timeZone ?? 'UTC';
      const client = new SpApiClient(
        decryptSecret(seller.rows[0].refresh_token_encrypted),
        { baseUrl: getSpApiEndpoint(marketplaceId) }
      );
      const report = await client.fetchReport(parsed.reportType, parsed.tenantId, range, marketplaceId);
      const s3Key = await putRawReport({
        tenantId: parsed.tenantId,
        reportType: parsed.reportType,
        reportId: report.reportId,
        content: report.content
      });
      const coverageComplete = report.coverageComplete === true;
      // Preserve the raw document for diagnosis, but do not let a truncated
      // response delete or replace a previously verified normalized snapshot.
      const rowsImported = coverageComplete
        ? await saveStructuredRows(
            parsed.tenantId,
            parsed.reportType,
            report.content,
            {
              start: report.dataStartTime ?? range.start,
              end: report.dataEndTime ?? range.end
            },
            report.reportId,
            marketplaceTimeZone
          )
        : 0;
      const coverageError = coverageComplete
        ? null
        : 'Amazon returned data that does not cover the complete requested range. The raw response was retained, but verified normalized rows were left unchanged.';
      await pool.query(
        `update sync_jobs set
           status=$2,
           completed_at=now(),
           s3_key=$3,
           data_start_time=$4,
           data_end_time=$5,
           rows_imported=$6,
           coverage_complete=$7,
           error_message=$8
         where id=$1`,
        [
          sync.rows[0].id,
          coverageComplete ? 'completed' : 'failed',
          s3Key,
          report.dataStartTime ?? range.start,
          report.dataEndTime ?? range.end,
          rowsImported,
          coverageComplete,
          coverageError
        ]
      );
      return {
        rowsImported,
        s3Key,
        coverageComplete,
        coverageError,
        noData: report.cancelledNoData === true
      };
    } catch (error) {
      await pool.query(
        `update sync_jobs set status='failed',completed_at=now(),error_message=$2 where id=$1`,
        [sync.rows[0].id, error instanceof Error ? error.message : 'unknown error']
      );
      throw error;
    }
  }, 1);
}

export async function syncRecentApiDataForTenant(tenantId, options = {}) {
  const parsedTenantId = z.string().uuid().parse(tenantId);
  const range = options.range
    ? z.object({ start: z.string().datetime(), end: z.string().datetime() }).parse(options.range)
    : null;
  const defaultStart = range
    ? new Date(range.start)
    : new Date(Date.now() - (options.days ?? 30) * 864e5);
  const lastCompletedSync = (await pool.query(
    `select coalesce(data_end_time,completed_at) cursor
     from sync_jobs
     where tenant_id=$1 and report_type='DIRECT_SP_API_SYNC' and status='completed'
     order by completed_at desc nulls last limit 1`,
    [parsedTenantId]
  )).rows[0]?.cursor;
  const incrementalStart = lastCompletedSync
    ? new Date(new Date(lastCompletedSync).getTime() - 5 * 60 * 1000)
    : defaultStart;
  // Never discard an outage gap. Once a cursor exists, continue from it even
  // when the process was offline for longer than the default lookback.
  const queryStart = range || options.full ? defaultStart : incrementalStart;
  const safeNow = new Date(Date.now() - 2 * 60 * 1000);
  const queryEnd = new Date(Math.min(range ? new Date(range.end).getTime() : safeNow.getTime(), safeNow.getTime()));
  if (queryStart >= queryEnd) throw new Error('Direct sync range has no data before Amazon\'s safe boundary');

  const includeOrders = options.includeOrders ?? true;
  const includeFinance = options.includeFinance ?? true;
  const includeInventory = options.includeInventory ?? true;
  const maxOrderPages = Math.max(1, Math.min(Number(options.maxOrderPages ?? 100), 100));
  await assertActiveTenant(parsedTenantId);

  return runJob(`sync:direct-api:${parsedTenantId}`, async () => {
    const sync = await pool.query(
      `insert into sync_jobs(tenant_id,report_type,status,started_at,data_start_time,data_end_time)
       values($1,'DIRECT_SP_API_SYNC','running',now(),$2,$3) returning id`,
      [parsedTenantId, queryStart.toISOString(), queryEnd.toISOString()]
    );
    try {
      const seller = await pool.query(
        `select refresh_token_encrypted,marketplace_id
         from sellers where tenant_id=$1 and auth_status='authorized'
         order by connected_at desc limit 1`,
        [parsedTenantId]
      );
      if (!seller.rowCount) throw new Error('No connected Amazon seller account');
      const marketplaceId = seller.rows[0].marketplace_id;
      const marketplaceTimeZone = MARKETPLACES[marketplaceId]?.timeZone ?? 'UTC';
      const client = new SpApiClient(
        decryptSecret(seller.rows[0].refresh_token_encrypted),
        { baseUrl: getSpApiEndpoint(marketplaceId) }
      );

      let ordersResult = { orders: [], pagesFetched: 0 };
      let financeResult = { transactions: [], pagesFetched: 0 };
      let inventoryResult = { inventorySummaries: [], pagesFetched: 0 };
      const warnings = {};

      if (includeOrders) {
        try {
          ordersResult = await client.searchOrders(range || options.full
            ? {
                marketplaceId,
                createdAfter: queryStart.toISOString(),
                createdBefore: queryEnd.toISOString(),
                maxPages: maxOrderPages
              }
            : {
                marketplaceId,
                lastUpdatedAfter: queryStart.toISOString(),
                lastUpdatedBefore: queryEnd.toISOString(),
                maxPages: maxOrderPages
              });
        } catch (error) {
          warnings.orders = error instanceof Error ? error.message : 'Orders sync failed';
        }
      }

      if (includeFinance) {
        try {
          // Refresh a rolling Finances window so transactions that change from
          // DEFERRED to RELEASED are updated even when their postedDate is old.
          const financeStart = range
            ? queryStart
            : new Date(Math.min(queryStart.getTime(), queryEnd.getTime() - 179 * 864e5));
          const financeEnd = range
            ? new Date(Math.min(safeNow.getTime(), queryEnd.getTime() + 45 * 864e5))
            : queryEnd;
          financeResult = await client.listAllFinanceTransactions(
            financeStart.toISOString(),
            financeEnd.toISOString()
          );
        } catch (error) {
          warnings.finance = error instanceof Error ? error.message : 'Finance sync failed';
        }
      }

      if (includeInventory) {
        try {
          inventoryResult = await client.listInventorySummaries(marketplaceId);
        } catch (error) {
          warnings.inventory = error instanceof Error ? error.message : 'Inventory sync failed';
        }
      }

      const requestedFamilies = [includeOrders, includeFinance, includeInventory].filter(Boolean).length;
      if (requestedFamilies && Object.keys(warnings).length === requestedFamilies) {
        throw new Error(`All requested direct SP-API sources failed: ${Object.values(warnings).join('; ')}`);
      }

      let ordersImported = 0;
      let orderItemsImported = 0;
      let transactionsImported = 0;
      let inventoryImported = 0;
      let reimbursementsImported = 0;
      let catalogItemsImported = 0;
      const snapshotDate = marketplaceDate(new Date(), marketplaceTimeZone);
      const catalogCache = new Map();

      await withTenant(parsedTenantId, db => transaction(db, async () => {
        for (const sourceOrder of ordersResult.orders) {
          const order = normalizeOrder(sourceOrder);
          if (!order.orderId) continue;
          await db.query(
            `insert into orders(
               tenant_id,amazon_order_id,order_date,amazon_last_updated_at,total_amount,status,fulfillment_channel,sales_channel,raw
             ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
             on conflict(tenant_id,amazon_order_id) do update set
               order_date=excluded.order_date,
               amazon_last_updated_at=excluded.amazon_last_updated_at,
               total_amount=excluded.total_amount,
               status=excluded.status,
               fulfillment_channel=excluded.fulfillment_channel,
               sales_channel=excluded.sales_channel,
               raw=excluded.raw`,
            [
              parsedTenantId,
              order.orderId,
              order.createdTime,
              order.lastUpdatedTime,
              order.totalAmount,
              order.status,
              order.fulfillmentChannel,
              order.salesChannel,
              order.raw
            ]
          );
          ordersImported += 1;

          const normalizedItems = order.items.map(sourceItem => normalizeOrderItem(order.orderId, sourceItem));
          if (normalizedItems.length) {
            await db.query(
              `delete from order_items
               where tenant_id=$1 and amazon_order_id=$2
                 and not (source_key=any($3::text[]))`,
              [parsedTenantId, order.orderId, normalizedItems.map(item => item.sourceKey)]
            );
          }
          for (const item of normalizedItems) {
            await db.query(
              `insert into order_items(
                 tenant_id,source_key,amazon_order_item_id,amazon_order_id,asin,sku,title,quantity_ordered,
                 item_price,item_tax,promotion_discount,currency,raw
               ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
               on conflict(tenant_id,source_key) do update set
                 amazon_order_item_id=excluded.amazon_order_item_id,
                 amazon_order_id=excluded.amazon_order_id,
                 asin=excluded.asin,
                 sku=excluded.sku,
                 title=excluded.title,
                 quantity_ordered=excluded.quantity_ordered,
                 item_price=excluded.item_price,
                 item_tax=excluded.item_tax,
                 promotion_discount=excluded.promotion_discount,
                 currency=excluded.currency,
                 raw=excluded.raw`,
              [
                parsedTenantId,
                item.sourceKey,
                item.orderItemId,
                order.orderId,
                item.asin,
                item.sku,
                item.title,
                item.quantity,
                item.itemPrice,
                item.itemTax,
                item.promotionDiscount,
                item.currency,
                item.raw
              ]
            );
            orderItemsImported += 1;
          }
        }

        if (includeInventory && !warnings.inventory) {
          // A full, paginated inventory response is a snapshot. Replace the
          // marketplace-day snapshot so SKUs that disappeared do not retain a
          // stale fulfillable quantity.
          await db.query(
            'delete from inventory_snapshots where tenant_id=$1 and snapshot_date=$2',
            [parsedTenantId, snapshotDate]
          );
        }
        for (const summary of inventoryResult.inventorySummaries) {
          const sku = text(summary.sellerSku ?? summary.SellerSKU ?? summary.sellerSKU);
          if (!sku) continue;
          const fulfillableQuantity = summary.inventoryDetails?.fulfillableQuantity
            ?? summary.InventoryDetails?.FulfillableQuantity
            ?? summary.fulfillableQuantity
            ?? summary.FulfillableQuantity;
          await db.query(
            `insert into inventory_snapshots(tenant_id,sku,fulfillable_quantity,snapshot_date)
             values($1,$2,$3,$4)
             on conflict(tenant_id,sku,snapshot_date) do update set fulfillable_quantity=excluded.fulfillable_quantity`,
            [parsedTenantId, sku, parseAmazonInteger(fulfillableQuantity), snapshotDate]
          );
          inventoryImported += 1;
        }

        for (const transactionRow of financeResult.transactions) {
          const transactionId = text(
            transactionRow.transactionId
            ?? transactionRow.TransactionId
            ?? transactionRow.financialEventGroupId
            ?? transactionRow.FinancialEventGroupId
          );
          if (!transactionId) continue;
          const metadata = financeMetadata(transactionRow);
          const total = transactionRow.totalAmount ?? transactionRow.TotalAmount;
          const relatedOrderId = financeRelatedValue(transactionRow, ['ORDER_ID', 'AMAZON_ORDER_ID']);
          await db.query(
            `insert into finance_transactions(
               tenant_id,transaction_id,transaction_type,transaction_status,description,account_type,marketplace_id,
               posted_date,total_amount,currency,related_order_id,raw
             ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             on conflict(tenant_id,transaction_id) do update set
               transaction_type=excluded.transaction_type,
               transaction_status=excluded.transaction_status,
               description=excluded.description,
               account_type=excluded.account_type,
               marketplace_id=excluded.marketplace_id,
               posted_date=excluded.posted_date,
               total_amount=excluded.total_amount,
               currency=excluded.currency,
               related_order_id=excluded.related_order_id,
               raw=excluded.raw`,
            [
              parsedTenantId,
              transactionId,
              transactionRow.transactionType ?? transactionRow.TransactionType,
              metadata.status,
              metadata.description,
              metadata.accountType,
              metadata.marketplaceId ?? marketplaceId,
              transactionRow.postedDate ?? transactionRow.PostedDate,
              moneyValue(total),
              total?.currencyCode ?? total?.CurrencyCode ?? 'INR',
              relatedOrderId,
              transactionRow
            ]
          );
          await db.query(
            `delete from finance_transaction_items where tenant_id=$1 and transaction_id=$2`,
            [parsedTenantId, transactionId]
          );
          for (const component of flattenFinanceTransaction(transactionRow)) {
            await db.query(
              `insert into finance_transaction_items(
                 tenant_id,source_key,transaction_id,order_id,sku,asin,category,account_section,amount_description,
                 breakdown_path,is_summary,amount,currency,posted_date,raw
               ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               on conflict(tenant_id,source_key) do update set
                 order_id=excluded.order_id,
                 sku=excluded.sku,
                 asin=excluded.asin,
                 category=excluded.category,
                 account_section=excluded.account_section,
                 amount_description=excluded.amount_description,
                 breakdown_path=excluded.breakdown_path,
                 is_summary=excluded.is_summary,
                 amount=excluded.amount,
                 currency=excluded.currency,
                 posted_date=excluded.posted_date,
                 raw=excluded.raw`,
              [
                parsedTenantId,
                component.sourceKey,
                component.transactionId,
                component.orderId ?? null,
                component.sku ?? null,
                component.asin ?? null,
                component.category,
                component.accountSection,
                component.description ?? null,
                component.breakdownPath,
                component.isSummary === true,
                component.amount,
                component.currency ?? 'INR',
                component.postedDate,
                component.raw
              ]
            );
          }
          transactionsImported += 1;

          if (/reimburse/i.test(`${transactionRow.transactionType ?? ''} ${metadata.description ?? ''}`)) {
            const reimbursementKey = `finance-reimbursement:${transactionId}`;
            await db.query(
              `insert into reimbursements(
                 tenant_id,source_key,reimbursement_id,order_id,amount,currency,reason,sku,reimbursement_date,raw
               ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               on conflict(tenant_id,source_key) do update set
                 amount=excluded.amount,
                 reason=excluded.reason,
                 reimbursement_date=excluded.reimbursement_date,
                 raw=excluded.raw`,
              [
                parsedTenantId,
                reimbursementKey,
                transactionId,
                relatedOrderId,
                moneyValue(total),
                total?.currencyCode ?? total?.CurrencyCode ?? 'INR',
                metadata.description ?? transactionRow.transactionType ?? 'Finance reimbursement',
                financeRelatedValue(transactionRow, ['SKU', 'SELLER_SKU']),
                transactionRow.postedDate ?? transactionRow.PostedDate,
                transactionRow
              ]
            );
            reimbursementsImported += 1;
          }
        }
      }));

      // Catalog lookups are deliberately outside the write transaction. They
      // enrich only a bounded set of missing ASINs and never block core imports.
      const missingCatalogItems = await withTenant(parsedTenantId, async db => (
        await db.query(
          `select distinct asin from order_items
           where tenant_id=$1 and asin is not null and package_weight is null
           limit 25`,
          [parsedTenantId]
        )
      ).rows);
      for (const { asin } of missingCatalogItems) {
        let catalog = catalogCache.get(asin);
        if (!catalogCache.has(asin)) {
          catalog = await client.getCatalogItem(asin, marketplaceId).catch(() => null);
          catalogCache.set(asin, catalog);
        }
        if (!catalog) continue;
        catalogItemsImported += 1;
        const shipping = catalogShippingFacts(catalog);
        await withTenant(parsedTenantId, db => db.query(
          `update order_items set package_weight=$3,weight_unit=$4,package_dimensions=$5,catalog_raw=$6
           where tenant_id=$1 and asin=$2`,
          [
            parsedTenantId,
            asin,
            shipping.weight || null,
            shipping.weightUnit ?? null,
            shipping.dimensions,
            catalog
          ]
        ));
      }

      const ordersCoverageComplete = includeOrders
        && !warnings.orders
        && !ordersResult.nextToken;
      const financeCoverageComplete = includeFinance
        && !warnings.finance
        && !financeResult.nextToken;
      const inventoryCoverageComplete = includeInventory
        && !warnings.inventory
        && !inventoryResult.nextToken;
      const coverageComplete = (!includeOrders || ordersCoverageComplete)
        && (!includeFinance || financeCoverageComplete)
        && (!includeInventory || inventoryCoverageComplete);
      const incompleteSources = [
        includeOrders && !ordersCoverageComplete ? 'Orders' : null,
        includeFinance && !financeCoverageComplete ? 'Finances' : null,
        includeInventory && !inventoryCoverageComplete ? 'Inventory' : null
      ].filter(Boolean);
      const coverageError = incompleteSources.length
        ? `Incomplete SP-API coverage: ${incompleteSources.join(', ')}. Retry the sync before using range totals.`
        : null;
      await pool.query(
        `update sync_jobs set
           status=$2,
           completed_at=now(),
           rows_imported=$3,
           coverage_complete=$4,
           orders_coverage_complete=$5,
           finance_coverage_complete=$6,
           inventory_coverage_complete=$7,
           error_message=$8
         where id=$1`,
        [
          sync.rows[0].id,
          coverageComplete ? 'completed' : 'failed',
          ordersImported + orderItemsImported + transactionsImported + inventoryImported,
          coverageComplete,
          ordersCoverageComplete,
          financeCoverageComplete,
          inventoryCoverageComplete,
          coverageError ?? (Object.keys(warnings).length ? JSON.stringify(warnings) : null)
        ]
      );
      return {
        ordersImported,
        orderItemsImported,
        transactionsImported,
        inventoryImported,
        reimbursementsImported,
        catalogItemsImported,
        incrementalMode: !range && !options.full,
        incrementalSince: queryStart.toISOString(),
        incrementalUntil: queryEnd.toISOString(),
        coverageComplete,
        ordersCoverageComplete,
        financeCoverageComplete,
        inventoryCoverageComplete,
        coverageError,
        warnings
      };
    } catch (error) {
      await pool.query(
        `update sync_jobs set status='failed',completed_at=now(),error_message=$2 where id=$1`,
        [sync.rows[0].id, error instanceof Error ? error.message : 'unknown error']
      );
      throw error;
    }
  }, 1);
}

async function syncActiveTenants(reportType) {
  const parsedReportType = z.enum(REPORT_TYPES).parse(reportType);
  const tenants = await pool.query("select id from tenants where status='active'");
  const limit = pLimit(3);
  await Promise.all(
    tenants.rows.map(row => limit(() => syncReportForTenant({
      tenantId: row.id,
      reportType: parsedReportType
    })))
  );
}

async function syncActiveDirectTenants() {
  const tenants = await pool.query("select id from tenants where status='active'");
  const limit = pLimit(3);
  await Promise.all(tenants.rows.map(row => limit(
    () => syncRecentApiDataForTenant(row.id).catch(() => undefined)
  )));
}

export function startScheduler() {
  cron.schedule('0 1 * * *', () => {
    void syncActiveDirectTenants();
  });
  cron.schedule('0 2 * * *', () => {
    void Promise.all(NIGHTLY_REPORTS.map(reportType => syncActiveTenants(reportType)));
  });
}
