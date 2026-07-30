import crypto from 'node:crypto';

const REPORT_TYPES = Object.freeze({
  settlement: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
  gstB2b: 'GET_GST_MTR_B2B_CUSTOM',
  gstB2c: 'GET_GST_MTR_B2C_CUSTOM',
  returns: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
  reimbursements: 'GET_FBA_REIMBURSEMENTS_DATA',
  salesTraffic: 'GET_SALES_AND_TRAFFIC_REPORT',
  inventory: 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'
});

export function text(value) {
  if (value == null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function compact(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function pickReportValue(row, names) {
  const values = new Map(Object.entries(row ?? {}).map(([key, value]) => [compact(key), value]));
  for (const name of names) {
    const value = values.get(compact(name));
    if (value != null && String(value).trim() !== '') return value;
  }
  return undefined;
}

/**
 * Parses Amazon money without assuming that comma is always a thousands
 * separator. Settlement reports use the seller account locale and can contain
 * both `1,234.56` and `1.234,56`.
 */
export function parseAmazonAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let input = String(value ?? '').trim();
  if (!input) return 0;

  const negative = (input.includes('(') && input.includes(')')) || /[-−]/.test(input);
  input = input
    .replace(/[()−-]/g, '')
    .replace(/[^\d.,]/g, '');
  if (!input) return 0;

  const comma = input.lastIndexOf(',');
  const dot = input.lastIndexOf('.');
  let normalized;
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    const grouping = decimal === ',' ? /\./g : /,/g;
    normalized = input.replace(grouping, '').replace(decimal, '.');
  } else {
    const separator = comma >= 0 ? ',' : dot >= 0 ? '.' : null;
    if (!separator) {
      normalized = input;
    } else {
      const parts = input.split(separator);
      const last = parts.at(-1) ?? '';
      const decimal = last.length > 0 && last.length <= 2;
      normalized = decimal
        ? `${parts.slice(0, -1).join('')}.${last}`
        : parts.join('');
    }
  }

  const result = Number(normalized);
  if (!Number.isFinite(result)) return 0;
  return negative ? -Math.abs(result) : result;
}

export function parseAmazonInteger(value) {
  return Math.trunc(parseAmazonAmount(value));
}

/**
 * Normalizes the localized dates used by Amazon flat-file reports. Date-only
 * values stay date-only so the database does not shift them across a timezone.
 */
export function parseAmazonDate(value, { dateOnly = false } = {}) {
  const input = text(value);
  if (!input) return null;

  const localized = input.match(
    /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s*(UTC|GMT|IST|Z|[+-]\d{2}:?\d{2}))?$/i
  );
  if (localized) {
    const [, day, month, year, hour = '00', minute = '00', second = '00', zone] = localized;
    const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    if (dateOnly || (!localized[4] && !zone)) return date;
    const offset = !zone || /^(UTC|GMT|Z)$/i.test(zone)
      ? 'Z'
      : /^IST$/i.test(zone)
        ? '+05:30'
        : zone.includes(':')
          ? zone
          : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const parsed = new Date(`${date}T${hour.padStart(2, '0')}:${minute}:${second}${offset}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const isoDate = input.match(/^\d{4}-\d{2}-\d{2}$/);
  if (isoDate) return input;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  return dateOnly ? parsed.toISOString().slice(0, 10) : parsed.toISOString();
}

export function parseTsv(content) {
  const normalized = String(content ?? '').replace(/^\uFEFF/, '').trimEnd();
  if (!normalized.trim()) return [];
  const [headerLine, ...lines] = normalized.split(/\r?\n/);
  const headers = headerLine.split('\t').map(header => header.trim());
  return lines
    .filter(line => line.trim() !== '')
    .map((line, rowIndex) => ({
      row: Object.fromEntries(headers.map((header, index) => [header, line.split('\t')[index] ?? ''])),
      rowIndex
    }));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
}

export function sourceKey(reportType, identity, occurrence = 0) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([reportType, canonicalize(identity), occurrence]))
    .digest('hex');
}

function withOccurrenceKeys(reportType, values, identity) {
  const occurrences = new Map();
  return values.map(value => {
    const canonicalIdentity = JSON.stringify(canonicalize(identity(value)));
    const occurrence = occurrences.get(canonicalIdentity) ?? 0;
    occurrences.set(canonicalIdentity, occurrence + 1);
    return { ...value, sourceKey: sourceKey(reportType, identity(value), occurrence) };
  });
}

export function parseSettlementReport(content, reportId = null) {
  const sourceRows = parseTsv(content).map(({ row }) => row);
  const statementRows = sourceRows.filter(row => (
    text(pickReportValue(row, ['settlement-id', 'settlement id']))
    && (
      pickReportValue(row, ['deposit-date', 'deposit date'])
      || pickReportValue(row, ['settlement-start-date', 'settlement start date'])
      || pickReportValue(row, ['total-amount', 'total amount'])
    )
    && pickReportValue(row, ['amount']) == null
  ));

  const statementsById = new Map();
  for (const raw of statementRows) {
    const settlementId = text(pickReportValue(raw, ['settlement-id', 'settlement id']));
    if (!settlementId) continue;
    statementsById.set(settlementId, {
      settlementId,
      settlementStartDate: parseAmazonDate(pickReportValue(raw, ['settlement-start-date', 'settlement start date'])),
      settlementEndDate: parseAmazonDate(pickReportValue(raw, ['settlement-end-date', 'settlement end date'])),
      depositDate: parseAmazonDate(pickReportValue(raw, ['deposit-date', 'deposit date'])),
      totalAmount: parseAmazonAmount(pickReportValue(raw, ['total-amount', 'total amount'])),
      currency: text(pickReportValue(raw, ['currency'])) ?? 'INR',
      reportId,
      raw
    });
  }

  const monetaryRows = sourceRows
    .filter(raw => pickReportValue(raw, ['amount']) != null)
    .map(raw => ({
      settlementId: text(pickReportValue(raw, ['settlement-id', 'settlement id'])),
      orderId: text(pickReportValue(raw, ['order-id', 'order id', 'amazon-order-id'])),
      transactionType: text(pickReportValue(raw, ['transaction-type', 'transaction type'])),
      amountType: text(pickReportValue(raw, ['amount-type', 'amount type'])),
      amountDescription: text(pickReportValue(raw, ['amount-description', 'amount description'])),
      amount: parseAmazonAmount(pickReportValue(raw, ['amount'])),
      currency: text(pickReportValue(raw, ['currency'])) ?? 'INR',
      postedDate: parseAmazonDate(pickReportValue(raw, ['posted-date-time', 'posted date time', 'posted-date', 'posted date'])),
      orderItemCode: text(pickReportValue(raw, ['order-item-code', 'order item code'])),
      sku: text(pickReportValue(raw, ['sku', 'merchant-order-item-id'])),
      quantity: pickReportValue(raw, ['quantity-purchased', 'quantity purchased', 'quantity']) == null
        ? null
        : parseAmazonInteger(pickReportValue(raw, ['quantity-purchased', 'quantity purchased', 'quantity'])),
      reportId,
      raw
    }));

  return {
    statements: [...statementsById.values()],
    rows: withOccurrenceKeys(REPORT_TYPES.settlement, monetaryRows, row => ({
      settlementId: row.settlementId,
      orderId: row.orderId,
      transactionType: row.transactionType,
      amountType: row.amountType,
      amountDescription: row.amountDescription,
      amount: row.amount,
      currency: row.currency,
      postedDate: row.postedDate,
      orderItemCode: row.orderItemCode,
      sku: row.sku,
      quantity: row.quantity
    }))
  };
}

function taxComponent(row, component) {
  const wanted = compact(component);
  return Object.entries(row).reduce((sum, [key, value]) => {
    const normalized = compact(key);
    const isComponent = normalized.includes(wanted) && (
      normalized.endsWith(`${wanted}tax`)
      || normalized.endsWith(`${wanted}amount`)
      || normalized === wanted
    );
    return sum + (isComponent ? parseAmazonAmount(value) : 0);
  }, 0);
}

function signedDocumentAmount(value, transactionType) {
  const parsed = parseAmazonAmount(value);
  return /refund|credit|return|cancel/i.test(String(transactionType ?? ''))
    ? -Math.abs(parsed)
    : parsed;
}

export function parseGstReport(content, invoiceType) {
  const reportType = invoiceType === 'b2b' ? REPORT_TYPES.gstB2b : REPORT_TYPES.gstB2c;
  const rows = parseTsv(content).map(({ row: raw }) => {
    const transactionType = text(pickReportValue(raw, ['transaction-type', 'transaction type', 'document-type']));
    const documentNumber = text(pickReportValue(raw, ['invoice-number', 'invoice number', 'credit-note-number', 'document-number']));
    return {
      invoiceType,
      orderId: text(pickReportValue(raw, ['order-id', 'order id', 'amazon-order-id'])),
      documentNumber,
      lineId: text(pickReportValue(raw, [
        'shipment-item-id',
        'shipment item id',
        'line-item-id',
        'invoice-line-id',
        'order-item-id'
      ])),
      transactionType,
      sku: text(pickReportValue(raw, ['sku', 'seller-sku', 'seller sku'])),
      asin: text(pickReportValue(raw, ['asin'])),
      quantity: pickReportValue(raw, ['quantity']) == null ? null : parseAmazonInteger(pickReportValue(raw, ['quantity'])),
      taxableValue: signedDocumentAmount(
        pickReportValue(raw, ['tax-exclusive-gross', 'tax exclusive gross', 'taxable-value', 'taxable value']),
        transactionType
      ),
      invoiceAmount: signedDocumentAmount(
        pickReportValue(raw, ['invoice-amount', 'invoice amount', 'tax-inclusive-gross', 'tax inclusive gross']),
        transactionType
      ),
      taxTotal: signedDocumentAmount(
        pickReportValue(raw, ['total-tax-amount', 'total tax amount', 'total-tax', 'total tax']),
        transactionType
      ),
      cgst: signedDocumentAmount(taxComponent(raw, 'cgst'), transactionType),
      sgst: signedDocumentAmount(taxComponent(raw, 'sgst'), transactionType),
      utgst: signedDocumentAmount(taxComponent(raw, 'utgst'), transactionType),
      igst: signedDocumentAmount(taxComponent(raw, 'igst'), transactionType),
      cess: signedDocumentAmount(taxComponent(raw, 'cess'), transactionType),
      invoiceDate: parseAmazonDate(
        pickReportValue(raw, ['invoice-date', 'invoice date', 'transaction-date', 'shipment-date']),
        { dateOnly: true }
      ),
      raw
    };
  });
  return withOccurrenceKeys(reportType, rows, row => ({
    documentNumber: row.documentNumber,
    orderId: row.orderId,
    lineId: row.lineId,
    transactionType: row.transactionType,
    sku: row.sku,
    asin: row.asin,
    quantity: row.quantity,
    taxableValue: row.taxableValue,
    invoiceAmount: row.invoiceAmount,
    taxTotal: row.taxTotal,
    invoiceDate: row.invoiceDate
  }));
}

function returnLifecycleStatus(amazonStatus, disposition) {
  const value = `${amazonStatus ?? ''} ${disposition ?? ''}`.toLowerCase();
  if (/damaged|defective|expired|unsellable|carrier|warehouse/.test(value)) return 'received_not_in_hand';
  // This report contains units Amazon has received at a fulfillment center.
  return 'received';
}

export function parseReturnsReport(content) {
  const rows = parseTsv(content).map(({ row: raw }) => {
    const amazonStatus = text(pickReportValue(raw, ['status']));
    const disposition = text(pickReportValue(raw, ['detailed-disposition', 'detailed disposition', 'disposition']));
    return {
      orderId: text(pickReportValue(raw, ['order-id', 'order id', 'amazon-order-id'])),
      orderItemId: text(pickReportValue(raw, ['order-item-id', 'order item id'])),
      sku: text(pickReportValue(raw, ['sku', 'seller-sku'])),
      asin: text(pickReportValue(raw, ['asin'])),
      fnsku: text(pickReportValue(raw, ['fnsku'])),
      returnReason: text(pickReportValue(raw, ['reason', 'return-reason', 'return reason'])),
      disposition,
      amazonStatus,
      status: returnLifecycleStatus(amazonStatus, disposition),
      returnDate: parseAmazonDate(pickReportValue(raw, ['return-date', 'return date', 'date']), { dateOnly: true }),
      quantity: pickReportValue(raw, ['quantity', 'quantity-returned']) == null
        ? null
        : parseAmazonInteger(pickReportValue(raw, ['quantity', 'quantity-returned'])),
      fulfillmentCenterId: text(pickReportValue(raw, ['fulfillment-center-id', 'fulfillment center id'])),
      raw
    };
  });
  return withOccurrenceKeys(REPORT_TYPES.returns, rows, row => ({
    orderId: row.orderId,
    orderItemId: row.orderItemId,
    sku: row.sku,
    asin: row.asin,
    returnDate: row.returnDate,
    quantity: row.quantity,
    disposition: row.disposition,
    returnReason: row.returnReason
  }));
}

export function parseReimbursementsReport(content) {
  const rows = parseTsv(content).map(({ row: raw }) => ({
    reimbursementId: text(pickReportValue(raw, ['reimbursement-id', 'reimbursement id'])),
    orderId: text(pickReportValue(raw, ['amazon-order-id', 'amazon order id', 'order-id'])),
    sku: text(pickReportValue(raw, ['sku', 'seller-sku'])),
    fnsku: text(pickReportValue(raw, ['fnsku'])),
    asin: text(pickReportValue(raw, ['asin'])),
    reason: text(pickReportValue(raw, ['reason', 'reason-code', 'approval-reason'])),
    amount: parseAmazonAmount(pickReportValue(raw, ['amount-total', 'amount total', 'total-amount', 'reimbursement amount'])),
    amountPerUnit: parseAmazonAmount(pickReportValue(raw, ['amount-per-unit', 'amount per unit'])),
    currency: text(pickReportValue(raw, ['currency-unit', 'currency unit', 'currency'])) ?? 'INR',
    quantityCash: parseAmazonInteger(pickReportValue(raw, ['quantity-reimbursed-cash', 'quantity reimbursed cash'])),
    quantityInventory: parseAmazonInteger(pickReportValue(raw, ['quantity-reimbursed-inventory', 'quantity reimbursed inventory'])),
    quantityTotal: parseAmazonInteger(pickReportValue(raw, ['quantity-reimbursed-total', 'quantity reimbursed total'])),
    reimbursementDate: parseAmazonDate(
      pickReportValue(raw, ['approval-date', 'approval date', 'reimbursement-date']),
      { dateOnly: true }
    ),
    raw
  }));
  return withOccurrenceKeys(REPORT_TYPES.reimbursements, rows, row => ({
    reimbursementId: row.reimbursementId,
    orderId: row.orderId,
    sku: row.sku,
    reason: row.reason,
    amount: row.amount,
    quantityCash: row.quantityCash,
    quantityInventory: row.quantityInventory,
    reimbursementDate: row.reimbursementDate
  }));
}

function monetaryAmount(value) {
  if (value && typeof value === 'object') return parseAmazonAmount(value.amount ?? value.currencyAmount);
  return parseAmazonAmount(value);
}

function salesTrafficMetrics(sales = {}, traffic = {}) {
  return {
    sessions: parseAmazonInteger(traffic.sessions),
    pageViews: parseAmazonInteger(traffic.pageViews),
    browserSessions: parseAmazonInteger(traffic.browserSessions),
    mobileAppSessions: parseAmazonInteger(traffic.mobileAppSessions),
    browserPageViews: parseAmazonInteger(traffic.browserPageViews ?? traffic.browerPageViews),
    mobileAppPageViews: parseAmazonInteger(traffic.mobileAppPageViews),
    unitsOrdered: parseAmazonInteger(sales.unitsOrdered),
    totalOrderItems: parseAmazonInteger(sales.totalOrderItems),
    orderedProductSales: monetaryAmount(sales.orderedProductSales),
    featuredOfferPercentage: parseAmazonAmount(traffic.buyBoxPercentage ?? traffic.featuredOfferPercentage),
    unitsRefunded: parseAmazonInteger(sales.unitsRefunded),
    refundRate: parseAmazonAmount(sales.refundRate),
    shippedProductSales: monetaryAmount(sales.shippedProductSales),
    unitsShipped: parseAmazonInteger(sales.unitsShipped),
    ordersShipped: parseAmazonInteger(sales.ordersShipped),
    orderedProductSalesB2b: monetaryAmount(sales.orderedProductSalesB2B),
    unitsOrderedB2b: parseAmazonInteger(sales.unitsOrderedB2B),
    totalOrderItemsB2b: parseAmazonInteger(sales.totalOrderItemsB2B),
    averageSalesPerOrderItem: monetaryAmount(sales.averageSalesPerOrderItem),
    averageSalesPerOrderItemB2b: monetaryAmount(sales.averageSalesPerOrderItemB2B),
    averageUnitsPerOrderItem: parseAmazonAmount(sales.averageUnitsPerOrderItem),
    averageUnitsPerOrderItemB2b: parseAmazonAmount(sales.averageUnitsPerOrderItemB2B),
    averageSellingPrice: monetaryAmount(sales.averageSellingPrice),
    unitSessionPercentage: parseAmazonAmount(traffic.unitSessionPercentage),
    orderItemSessionPercentage: parseAmazonAmount(traffic.orderItemSessionPercentage)
  };
}

export function parseSalesTrafficReport(content, fallbackRange = {}) {
  const serialized = String(content ?? '').trim();
  const parsed = serialized ? JSON.parse(serialized) : {};
  const specification = parsed.reportSpecification ?? {};
  const periodStart = text(specification.dataStartTime) ?? fallbackRange.start?.slice(0, 10) ?? null;
  const periodEnd = text(specification.dataEndTime) ?? fallbackRange.end?.slice(0, 10) ?? null;

  const daily = (parsed.salesAndTrafficByDate ?? []).map(row => ({
    date: text(row.date),
    ...salesTrafficMetrics(row.salesByDate, row.trafficByDate),
    currency: row.salesByDate?.orderedProductSales?.currencyCode ?? null,
    raw: row
  })).filter(row => row.date);

  const asin = (parsed.salesAndTrafficByAsin ?? []).map(row => ({
    periodStart,
    periodEnd,
    parentAsin: text(row.parentAsin),
    childAsin: text(row.childAsin),
    sku: text(row.sku),
    ...salesTrafficMetrics(row.salesByAsin, row.trafficByAsin),
    currency: row.salesByAsin?.orderedProductSales?.currencyCode ?? null,
    raw: row
  })).filter(row => row.parentAsin || row.childAsin || row.sku);

  return { daily, asin, periodStart, periodEnd };
}

export function parseInventoryReport(content, snapshotDate = new Date().toISOString().slice(0, 10)) {
  return parseTsv(content).map(({ row: raw }) => ({
    sku: text(pickReportValue(raw, ['sku', 'seller-sku', 'seller sku'])),
    fulfillableQuantity: parseAmazonInteger(
      pickReportValue(raw, ['afn-fulfillable-quantity', 'afn fulfillable quantity', 'fulfillable-quantity'])
    ),
    snapshotDate,
    raw
  })).filter(row => row.sku);
}
