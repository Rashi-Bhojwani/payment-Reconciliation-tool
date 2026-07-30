import { extractFinanceSectionRows } from './finance-components.js';

const num = value => value == null || value === '' ? null : Number(value);
const amount = row => Number(row?.amount ?? row?.total_amount ?? 0) || 0;
const norm = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const compact = value => norm(value).replaceAll(' ', '');

const rawField = (raw, names) => {
  const entries = Object.entries(raw ?? {});
  for (const name of names) {
    const wanted = compact(name);
    const hit = entries.find(([key]) => compact(key) === wanted);
    if (hit && hit[1] !== '' && hit[1] != null) return hit[1];
  }
  return undefined;
};

const text = row => norm([
  row.parent_transaction_type,
  row.parentTransactionType,
  row.transaction_type,
  row.transactionType,
  row.transaction_description,
  row.transactionDescription,
  row.account_type,
  row.accountType,
  row.account_section,
  row.amount_type,
  row.amount_description,
  row.description,
  row.category
].filter(Boolean).join(' '));

const keyOf = row => row.source_row_id
  ?? row.id
  ?? `${row.transaction_id ?? row.settlement_id ?? ''}|${row.order_id ?? ''}|${row.order_item_id ?? row.sku ?? ''}|${row.category ?? row.amount_type ?? ''}|${row.amount_description ?? ''}|${row.posted_date ?? ''}|${amount(row)}`;

function dedupe(rows, key = keyOf) {
  const seen = new Set();
  const included = [];
  const duplicates = [];
  for (const row of rows) {
    const keyValue = key(row);
    (seen.has(keyValue) ? duplicates : included).push(row);
    seen.add(keyValue);
  }
  return { included, duplicates };
}

const isSummary = row => String(row.category ?? '').startsWith('summary_');
const isPrincipal = row => /principal|principle|item price/.test(norm(`${row.amount_type ?? ''} ${row.amount_description ?? ''} ${row.category ?? ''}`));
const isPromotion = row => /promotion|promo rebate/.test(text(row));
const isWithholding = row => /\b(tcs|tds)\b|withholding/.test(text(row));
const isReimbursement = row => /reimburse|safe t|lost|damaged|clawback/.test(text(row));
const feeAmountType = row => new Set(['itemfees', 'fbafees', 'amazonfees']).has(compact(row.amount_type));
const isFee = row => (
  feeAmountType(row)
  || /fee|commission|closing|storage|shipping label|service|advertis|chargeback|adjustment|easy ship|postage purchase|inbound transportation|order cancellation charge/.test(text(row))
) && !isReimbursement(row) && !isPrincipal(row) && !isPromotion(row);
const isProductGst = row => /product tax|shipping tax|gift wrap tax|\bgst collected|\bgst refund|goods and services tax/.test(text(row))
  && !/fee|commission|service/.test(text(row));
const isGenericTax = row => /\btax\b/.test(text(row))
  && !isProductGst(row)
  && !isWithholding(row)
  && !isFee(row);
const isTransfer = row => /transfer|deposit|bank account|withdrawal/.test(text(row));
const accountSection = row => compact(row.account_section ?? row.accountSection);
const isExpenseSection = row => accountSection(row).startsWith('expense');
const isIncomeSection = row => accountSection(row).startsWith('income');
const isGstSection = row => accountSection(row) === 'gst';
const isTaxSection = row => accountSection(row) === 'tax';

const toPaise = value => Math.round((Number(value) || 0) * 100);
const fromPaise = value => value / 100;
const round2 = value => fromPaise(toPaise(value));
const signedSum = rows => fromPaise(rows.reduce((sum, row) => sum + toPaise(amount(row)), 0));
const component = (category, label, value, rows, operation = '+') => ({
  category,
  label,
  amount: value,
  count: rows.length,
  operation
});

const utcDate = value => {
  const input = String(value ?? '');
  const match = input.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/);
  return match
    ? new Date(Date.UTC(+match[3], +match[2] - 1, +match[1], +(match[4] ?? 0), +(match[5] ?? 0), +(match[6] ?? 0)))
    : new Date(input);
};

const inRange = (value, range) => {
  const date = utcDate(value);
  return !Number.isNaN(date.getTime()) && date >= new Date(range.start) && date < new Date(range.end);
};

const statusEligible = status => !new Set([
  'cancelled',
  'canceled',
  'pending',
  'pendingavailability',
  'unshipped',
  'unfulfillable',
  'replacement'
]).has(compact(status));

const orderItemKey = row => rawField(row.raw, ['order-item-id', 'orderItemId', 'order-item-code', 'amazon-order-item-id'])
  ?? row.order_item_id
  ?? row.source_row_id
  ?? row.id;

const returnKey = row => rawField(row.raw, ['return-event-id', 'event-id', 'rma-id', 'amazon-rma-id'])
  ?? `${row.order_id ?? ''}|${rawField(row.raw, ['order-item-id', 'orderItemId']) ?? row.order_item_id ?? ''}|${row.sku ?? ''}|${row.return_date ?? ''}|${row.quantity ?? ''}`;

const financialKey = row => `${row.transaction_id ?? row.settlement_id ?? ''}|${row.order_id ?? ''}|${rawField(row.raw, ['order-item-id', 'orderItemId', 'order-item-code']) ?? row.order_item_id ?? row.sku ?? ''}|${row.category ?? row.amount_type ?? ''}|${row.amount_description ?? ''}|${row.posted_date ?? ''}|${amount(row)}`;

const gstKey = row => `${rawField(row.raw, ['invoice-number', 'invoice number', 'document-number', 'credit-note-number']) ?? row.document_number ?? row.source_row_id ?? row.id}|${rawField(row.raw, ['line-item-id', 'invoice-line-id', 'order-item-id']) ?? row.line_id ?? row.sku ?? ''}`;

const dateOrdinal = (value, timeZone) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = type => Number(parts.find(part => part.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'));
};

export function inclusiveDays(start, end, timeZone = 'Asia/Kolkata') {
  const startOrdinal = dateOrdinal(start, timeZone);
  const endOrdinal = dateOrdinal(end, timeZone);
  if (startOrdinal == null || endOrdinal == null) return 1;
  return Math.max(1, Math.round((endOrdinal - startOrdinal) / 864e5));
}

export function calculateDashboardMetrics(input, range) {
  const orderAudit = dedupe(input.orders ?? [], row => row.amazon_order_id);
  const eligibleOrders = orderAudit.included.filter(row => statusEligible(row.status));
  const eligibleIds = new Set(eligibleOrders.map(row => row.amazon_order_id));
  const itemAudit = dedupe(
    (input.orderItems ?? []).filter(row => eligibleIds.has(row.amazon_order_id)),
    row => orderItemKey(row) ?? keyOf(row)
  );
  const returnAudit = dedupe(input.returns ?? [], returnKey);

  const shippedAvailable = itemAudit.included.length > 0
    && itemAudit.included.every(row => num(row.quantity_ordered) != null);
  const returnQuantitiesAvailable = returnAudit.included.every(row => num(row.quantity) != null);
  const returnsCoverageDeclared = typeof input.coverage?.returnsComplete === 'boolean';
  const returnsAvailable = returnsCoverageDeclared
    ? input.coverage.returnsComplete && returnQuantitiesAvailable
    : returnAudit.included.length > 0 && returnQuantitiesAvailable;
  const shippedUnits = shippedAvailable
    ? itemAudit.included.reduce((sum, row) => sum + num(row.quantity_ordered), 0)
    : null;
  const returnedUnits = returnsAvailable
    ? returnAudit.included.reduce((sum, row) => sum + num(row.quantity), 0)
    : null;
  const netQty = shippedUnits == null || returnedUnits == null
    ? null
    : shippedUnits - returnedUnits;

  const financeAudit = dedupe((input.financeItems ?? []).filter(row => !isSummary(row)), financialKey);
  const settlementAudit = dedupe(input.settlementRows ?? [], financialKey);
  const inferredSettlementComplete = settlementAudit.included.some(isPrincipal)
    && settlementAudit.included.some(row => isFee(row) || isWithholding(row))
    && settlementAudit.included.some(isProductGst);
  const settlementComplete = input.coverage?.settlementsComplete === true || inferredSettlementComplete;
  const financialRows = settlementComplete ? settlementAudit.included : financeAudit.included;
  const financialDuplicates = settlementComplete ? settlementAudit.duplicates : financeAudit.duplicates;
  const financialSource = settlementComplete ? 'Amazon Settlement report' : 'Amazon Finances API';

  const principalRows = financialRows.filter(isPrincipal);
  const grossRows = principalRows.filter(row => amount(row) > 0);
  // A negative product-principal line is a refund/reversal even when Amazon
  // omits "Refund" from one of the surrounding metadata fields.
  const refundPrincipalRows = principalRows.filter(row => amount(row) < 0);
  const promoRows = financialRows.filter(isPromotion);
  const promoDebits = promoRows.filter(row => amount(row) < 0);
  const promoRefunds = promoRows.filter(row => amount(row) > 0);
  const grossSales = signedSum(grossRows);
  const productRefunds = Math.abs(signedSum(refundPrincipalRows));
  const netPromotions = round2(Math.abs(signedSum(promoDebits)) - signedSum(promoRefunds));
  const netSales = round2(grossSales - productRefunds - netPromotions);

  const fallbackExpenseRows = financialRows.filter(row => (
    isExpenseSection(row) || isFee(row) || isWithholding(row)
  ) && !isProductGst(row) && !isGenericTax(row) && !isPrincipal(row) && !isReimbursement(row));
  const fallbackProductGstRows = financialRows.filter(isProductGst);
  const fallbackGenericTaxRows = financialRows.filter(isGenericTax);
  const fallbackIncomeRows = financialRows.filter(row => (
    !isExpenseSection(row)
    && !isFee(row)
    && !isWithholding(row)
    && !isProductGst(row)
    && !isGenericTax(row)
    && !isTransfer(row)
    && (isIncomeSection(row) || !accountSection(row) || isReimbursement(row))
  ));

  // Finances API accountType is normally "Standard Orders". The authoritative
  // Income/Expenses/GST classification comes from the transaction breakdown
  // ancestry, reconstructed from finance_transactions.raw.
  const financeSectionAudit = dedupe(
    settlementComplete ? [] : extractFinanceSectionRows(input.financeTransactions ?? []),
    keyOf
  );
  const sectionedTransactionIds = new Set(
    financeSectionAudit.included
      .map(row => row.transaction_id)
      .filter(Boolean)
  );
  const sectionOrFallback = (predicate, fallback) => {
    const parsedRows = financeSectionAudit.included.filter(predicate);
    if (!financeSectionAudit.included.length) return fallback;
    // Keep legacy/fallback rows only for transactions whose raw breakdown tree
    // could not be reconstructed at all. This preserves reimbursements and
    // older finance payloads without double-counting parsed transactions.
    return [
      ...parsedRows,
      ...fallback.filter(row => !row.transaction_id || !sectionedTransactionIds.has(row.transaction_id))
    ];
  };
  const expenseRows = sectionOrFallback(isExpenseSection, fallbackExpenseRows);
  const productGstRows = sectionOrFallback(isGstSection, fallbackProductGstRows);
  const genericTaxRows = sectionOrFallback(isTaxSection, fallbackGenericTaxRows);
  const incomeRows = sectionOrFallback(isIncomeSection, fallbackIncomeRows);

  const expenseDebits = Math.abs(signedSum(expenseRows.filter(row => amount(row) < 0)));
  const expenseCredits = signedSum(expenseRows.filter(row => amount(row) > 0));
  const deductions = round2(expenseDebits - expenseCredits);
  const sectionWithholdingRows = expenseRows.filter(isWithholding);
  const fallbackWithholdingRows = financialRows.filter(isWithholding);
  const withholdingRows = sectionWithholdingRows.length ? sectionWithholdingRows : fallbackWithholdingRows;
  const tcsTds = Math.abs(signedSum(withholdingRows));
  const operationalFees = round2(deductions - tcsTds);

  const financeReimbursements = financialRows.filter(isReimbursement);
  const reportReimbursementAudit = dedupe(input.reimbursements ?? []);
  const reimbursementRows = financeReimbursements.length
    ? financeReimbursements
    : reportReimbursementAudit.included;
  const reimbursements = signedSum(reimbursementRows);

  const headerAudit = dedupe(
    (input.settlementHeaders ?? []).filter(row => row.deposit_date && inRange(row.deposit_date, range) && !/failed/.test(text(row))),
    row => row.settlement_id ?? keyOf(row)
  );
  const transferRows = headerAudit.included.map(row => ({
    ...row,
    amount: -Math.abs(Number(row.total_amount ?? row.amount ?? 0))
  }));
  const settled = Math.abs(signedSum(transferRows));

  const gstImported = (input.gstInvoices ?? []).filter(row => (
    Object.keys(row.raw ?? {}).length > 0
    && !/synthetic|order item estimate/.test(norm(`${row.source ?? ''} ${JSON.stringify(row.raw ?? {})}`))
  ));
  const gstAudit = dedupe(gstImported, gstKey);
  const gstAvailable = gstAudit.included.length > 0;
  const gstInvoiceValue = gstAvailable
    ? fromPaise(gstAudit.included.reduce((sum, row) => {
      const kind = norm(`${rawField(row.raw, ['document-type', 'invoice-type', 'transaction-type']) ?? row.document_type ?? ''}`);
      const paise = toPaise(row.taxable_value);
      return sum + (/credit|refund/.test(kind) ? -Math.abs(paise) : paise);
    }, 0))
    : null;

  const gst = signedSum(productGstRows);
  const tax = signedSum(genericTaxRows);
  const income = signedSum(incomeRows);
  const expenses = signedSum(expenseRows);
  const transfers = signedSum(transferRows);
  const days = inclusiveDays(range.start, range.end, input.marketplaceTimeZone ?? 'Asia/Kolkata');
  const unitRate = returnedUnits == null || shippedUnits == null
    ? null
    : shippedUnits === 0
      ? (returnedUnits > 0 ? null : 0)
      : returnedUnits / shippedUnits * 100;
  const refundValueRate = grossSales ? productRefunds / grossSales * 100 : null;

  const diagnostics = {
    sourcePolicy: {
      financial: `${financialSource} (${settlementComplete ? 'complete statement takes precedence' : 'settlement incomplete; Finances fallback'})`,
      accountSections: financeSectionAudit.included.length
        ? 'Finances transaction breakdown hierarchy'
        : `${financialSource} leaf classification fallback`,
      reimbursements: financeReimbursements.length ? financialSource : 'Reimbursements report fallback',
      gst: 'Imported GST B2B/B2C rows only',
      settled: 'Settlement headers filtered by deposit_date'
    },
    includedRows: financialRows.length,
    excludedRows: settlementComplete ? financeAudit.included.length : settlementAudit.included.length,
    duplicateRows: financialDuplicates.length
      + financeSectionAudit.duplicates.length
      + itemAudit.duplicates.length
      + returnAudit.duplicates.length
      + gstAudit.duplicates.length,
    categoryTotals: {
      grossSales,
      productRefunds,
      netPromotions,
      expenseDebits,
      expenseCredits,
      tcsTds,
      operationalFees,
      gst,
      tax,
      transfers
    }
  };

  const metric = (
    value,
    unit,
    formula,
    components,
    rows,
    source = financialSource,
    status = value == null ? 'Unavailable' : null
  ) => ({ value, unit, formula, components, rows, source, status, range, diagnostics });

  const metrics = {
    netSales: metric(
      netSales,
      'amount',
      'Gross product Principal sales − Refund Principal lines − net seller-funded promotions',
      [
        component('gross_sales', 'Gross product sales', grossSales, grossRows),
        component('product_refunds', 'Product refunds', -productRefunds, refundPrincipalRows, '−'),
        component('promotions', 'Net seller-funded promotions', -netPromotions, promoRows, '−')
      ],
      [...grossRows, ...refundPrincipalRows, ...promoRows]
    ),
    netQty: metric(
      netQty,
      'quantity',
      'Shipped units − physically returned units; cancelled, pending/unshipped, unfulfillable, and replacement statuses excluded',
      [
        component('shipped_units', 'Shipped units', shippedUnits, itemAudit.included),
        component('returned_units', 'Returned units', returnedUnits == null ? null : -returnedUnits, returnAudit.included, '−')
      ],
      [...itemAudit.included, ...returnAudit.included],
      'Orders API item quantities + Returns report quantities',
      netQty == null ? 'Unavailable / source mismatch — missing Orders API item quantities or completed Returns-report coverage' : null
    ),
    orders: metric(
      eligibleOrders.length,
      'quantity',
      'Distinct eligible Amazon order IDs by order_date; cancelled, pending/unshipped, unfulfillable, and replacement statuses excluded',
      [component('eligible_orders', 'Eligible distinct orders', eligibleOrders.length, eligibleOrders)],
      eligibleOrders,
      'Orders API'
    ),
    returns: metric(
      returnedUnits,
      'quantity',
      'Sum of Amazon return quantity; zero requires completed Amazon Returns-report coverage',
      [component('returned_units', 'Returned quantity', returnedUnits, returnAudit.included)],
      returnAudit.included,
      'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
      returnedUnits == null ? 'Unavailable — completed Returns-report coverage is missing' : null
    ),
    settled: metric(
      settled,
      'amount',
      'Absolute value of successful bank deposits with deposit_date in the selected range',
      [component('successful_transfers', 'Successful bank transfers', settled, headerAudit.included)],
      headerAudit.included,
      'Settlement headers'
    ),
    deductions: metric(
      deductions,
      'amount',
      'Gross expense debits − expense refunds/credits (includes TCS/TDS)',
      [
        component('expense_debits', 'Gross expense debits', expenseDebits, expenseRows.filter(row => amount(row) < 0)),
        component('expense_credits', 'Expense refunds/credits', -expenseCredits, expenseRows.filter(row => amount(row) > 0), '−'),
        component('tcs_tds', 'TCS/TDS included', tcsTds, withholdingRows),
        component('operational_fees', 'Operational fees excluding TCS/TDS', operationalFees, expenseRows.filter(row => !isWithholding(row)))
      ],
      expenseRows,
      financeSectionAudit.included.length ? 'Amazon Finances API breakdown hierarchy' : financialSource
    ),
    reimbursements: metric(
      reimbursements,
      'amount',
      'Reimbursement credits − reimbursement reversals',
      [component('net_reimbursements', 'Net reimbursements', reimbursements, reimbursementRows)],
      reimbursementRows,
      financeReimbursements.length ? financialSource : 'Reimbursements report'
    ),
    drr: metric(
      round2(netSales / days),
      'amount',
      `Net Sales ÷ ${days} calendar days derived from the selected half-open range`,
      [
        component('net_sales', 'Net Sales', netSales, []),
        component('days', 'Calendar days', days, [])
      ],
      []
    ),
    feeImpact: metric(
      grossSales ? operationalFees / grossSales * 100 : null,
      'percentage',
      'Operational Amazon fees excluding TCS/TDS ÷ gross product sales × 100',
      [
        component('operational_fees', 'Operational fees', operationalFees, expenseRows.filter(row => !isWithholding(row))),
        component('gross_sales', 'Gross product sales', grossSales, grossRows)
      ],
      expenseRows
    ),
    returnRate: metric(
      unitRate,
      'percentage',
      'Physically returned units ÷ shipped units × 100',
      [
        component('returned_units', 'Returned units', returnedUnits, returnAudit.included),
        component('shipped_units', 'Shipped units', shippedUnits, itemAudit.included)
      ],
      [...returnAudit.included, ...itemAudit.included],
      'Orders API item quantities + GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
      unitRate == null ? 'Unavailable / source mismatch — shipped quantity or completed Returns-report coverage is missing' : null
    ),
    refundValueRate: metric(
      refundValueRate,
      'percentage',
      'Product refund Principal value ÷ gross product Principal sales × 100',
      [
        component('product_refunds', 'Product refunds', productRefunds, refundPrincipalRows),
        component('gross_sales', 'Gross product sales', grossSales, grossRows)
      ],
      [...refundPrincipalRows, ...grossRows]
    ),
    gstValue: metric(
      gstInvoiceValue,
      'amount',
      'Genuine GST sales-invoice taxable value − genuine credit-note/refund taxable value',
      [component('net_taxable_value', 'Net taxable invoice value', gstInvoiceValue, gstAudit.included)],
      gstAudit.included,
      'Imported GST B2B/B2C reports',
      gstAvailable ? null : 'Unavailable'
    )
  };

  const group = rows => {
    const map = new Map();
    for (const row of rows) {
      const name = row.amount_description ?? row.category ?? row.transaction_type ?? 'Other';
      const old = map.get(name) ?? {
        category: norm(name).replaceAll(' ', '_'),
        label: name,
        amountPaise: 0,
        count: 0
      };
      old.amountPaise += toPaise(amount(row));
      old.count += 1;
      map.set(name, old);
    }
    return [...map.values()].map(({ amountPaise, ...row }) => ({
      ...row,
      amount: fromPaise(amountPaise)
    }));
  };

  const accountActivitySource = financeSectionAudit.included.length
    ? 'Amazon Finances API breakdown hierarchy'
    : financialSource;
  const statement = {
    income: metric(income, 'amount', 'Net Amazon Income statement lines', group(incomeRows), incomeRows, accountActivitySource),
    expenses: metric(expenses, 'amount', 'Expense debits plus expense refunds/credits; includes TCS/TDS', group(expenseRows), expenseRows, accountActivitySource),
    tax: metric(tax, 'amount', 'Amazon generic Tax section only', group(genericTaxRows), genericTaxRows, accountActivitySource),
    transfers: metric(transfers, 'amount', 'Signed successful bank transfers by deposit_date', group(transferRows), transferRows, 'Settlement headers'),
    gst: metric(gst, 'amount', 'Product/shipping/gift-wrap GST collected plus GST refunds', group(productGstRows), productGstRows, accountActivitySource)
  };

  const reconciliationValue = fromPaise(
    [income, expenses, tax, gst, transfers].reduce((sum, value) => sum + toPaise(value), 0)
  );
  const reconciliation = {
    value: reconciliationValue,
    balanced: reconciliationValue === 0,
    formula: 'Income + Expenses + Tax + GST + Transfers',
    components: { income, expenses, tax, gst, transfers }
  };

  return { metrics, statement, reconciliation, diagnostics };
}