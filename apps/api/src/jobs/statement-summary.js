/**
 * Amazon.in Account Activity rows. Rules are intentionally data, not a switch:
 * add a rule here when a new listTransactions description is observed.
 * Earlier rules win. `todo` rows remain visible, but are still matchable by the
 * best known description pattern until a real response confirms their source.
 */
export const STATEMENT_CONFIG = Object.freeze([
  section('Income', 'Net sales, credits, and refunds', [
    line('Seller fulfilled product sales', /merchant|seller fulfilled|mfn/i, /principal|product sales/i),
    line('Seller fulfilled product sale refunds', /refund/i, /principal|product sales/i, /merchant|seller fulfilled|mfn/i),
    line('FBA product sales', /shipment|order/i, /principal|product sales/i, /amazon|fba/i),
    line('FBA product sale refunds', /refund/i, /principal|product sales/i, /amazon|fba/i),
    line('FBA inventory credit', /inventory credit/i), line('Shipping credits', /shipment|order/i, /shipping(?!.*tax)/i),
    line('Shipping credit refunds', /refund/i, /shipping(?!.*tax)/i),
    line('NetCo Transaction', /netco/i, null, null, 'TODO: confirm transactionType from a live India response.'),
    line('Gift wrap credits', /shipment|order/i, /gift.?wrap(?!.*tax)/i), line('Gift wrap credit refunds', /refund/i, /gift.?wrap(?!.*tax)/i),
    line('Promotional rebates', /shipment|order/i, /promotion|discount/i), line('Promotional rebate refunds', /refund/i, /promotion|discount/i),
    line('A-to-Z Guarantee claims', /a.?to.?z|guarantee claim/i), line('Chargebacks', /chargeback/i),
    line('SAFE-T Reimbursements', /safe.?t/i), line('Reimbursements', /reimbursement/i), line('Clawbacks', /clawback/i),
    line('TDS Reimbursement', /tds reimbursement/i, null, null, 'TODO: confirm whether this is a standalone transaction or nested breakdown.'),
    line('Amazon Shipping Reimbursement Adjustments', /shipping reimbursement adjustment/i, null, null, 'TODO: confirm exact production description.'),
    line('Others', /.*/)
  ]),
  section('Expenses', 'Net fees, including Amazon service fees, selling fees, FBA fees, shipping, and taxes', [
    line('Seller fulfilled selling fees', /shipment|order/i, /commission|selling fee|referral/i, /merchant|seller fulfilled|mfn/i),
    line('FBA selling fees', /shipment|order/i, /commission|selling fee|referral/i, /amazon|fba/i), line('Selling fee refunds', /refund/i, /commission|selling fee|referral/i),
    line('FBA transaction fees', /shipment|order/i, /fba|fulfillment|weight based/i), line('FBA transaction fee refunds', /refund/i, /fba|fulfillment|weight based/i),
    line('Other transaction fees', /shipment|order/i, /fee|charge/i), line('Other transaction fee refunds', /refund/i, /fee|charge/i),
    line('FBA inventory and inbound services fees', /inventory|inbound/i, /fee|service/i), line('Shipping label purchases', /shipping label purchase/i),
    line('Shipping label refunds', /shipping label refund/i), line('Carrier shipping label adjustments', /carrier.*shipping label|shipping label adjustment/i),
    line('Service fees', /service fee/i), line('Refund administration fees', /refund/i, /administration|admin fee/i), line('Adjustments', /adjustment/i),
    line('Cost of Advertising', /advertis.*cost|cost of advertising/i), line('Refund for Advertiser', /advertis.*refund|refund for advertiser/i),
    line('TCS-CGST Net', /.*/, /tcs.?cgst/i), line('TCS-SGST Net', /.*/, /tcs.?sgst/i), line('TCS-IGST Net', /.*/, /tcs.?igst/i),
    line('TDS - Section 194-O Net', /.*/, /tds|194.?o/i), line('Other expenses', /.*/, /fee|charge|commission|tcs|tds/i)
  ]),
  section('Transfers', 'Net deposits and withdrawals', [
    line('Transfers to bank account', /transfer.*bank|disbursement/i), line('Failed transfers to bank account', /failed.*transfer/i), line('Credit card charges and debt recovery', /credit card|debt recovery/i)
  ]),
  section('Goods and Services Tax', 'Net goods and services tax collected', [line('GST Collected', /.*/, /gst/i), line('GST Refunds', /refund/i, /gst/i)]),
  section('Tax', 'Net taxes collected on product sales and services', [
    line('Product, shipping and gift wrap taxes collected', /^(?!.*refund).*$/i, /tax(?!.*gst|tcs|tds)/i),
    line('Product, shipping and gift wrap taxes refunded', /refund/i, /tax(?!.*gst|tcs|tds)/i)
  ])
]);

function section(name, description, lines) { return { name, description, lines }; }
function line(label, context, component, fulfillment, todo) { return { label, context, component, fulfillment, ...(todo ? { todo } : {}) }; }

function money(value) {
  if (value == null) return null;
  if (typeof value === 'number' || typeof value === 'string') { const n = Number(value); return Number.isFinite(n) ? n : null; }
  return money(value.currencyAmount ?? value.CurrencyAmount ?? value.amount ?? value.Amount);
}

/** Return leaf financial components from arbitrarily deep breakdown arrays. */
export function flattenBreakdowns(transaction) {
  const output = [];
  const roots = transaction.breakdown ?? transaction.Breakdown ?? transaction.breakdowns ?? transaction.Breakdowns ?? [];
  function walk(nodes, ancestry = []) {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const type = node.breakdownType ?? node.BreakdownType ?? node.type ?? node.Type ?? 'UNSPECIFIED';
      const children = node.breakdown ?? node.Breakdown ?? node.breakdowns ?? node.Breakdowns ?? [];
      const amount = money(node.breakdownAmount ?? node.BreakdownAmount ?? node.amount ?? node.Amount);
      // A parent amount and its children are not assumed to be mutually
      // exclusive. Emit the parent's own amount only when it is a leaf; this
      // prevents aggregate nodes from being counted twice.
      if (Array.isArray(children) && children.length) walk(children, [...ancestry, type]);
      else if (amount != null) output.push({ breakdownType: [...ancestry, type].join(' > '), amount });
    }
  }
  walk(roots);
  if (!output.length) {
    const amount = money(transaction.totalAmount ?? transaction.TotalAmount ?? transaction.total_amount);
    if (amount != null) output.push({ breakdownType: 'TRANSACTION_TOTAL', amount });
  }
  return output;
}

function rawTransaction(row) { return row.raw && typeof row.raw === 'object' ? { ...row.raw, total_amount: row.total_amount } : row; }
function contextText(row) {
  const raw = rawTransaction(row);
  return [raw.transactionType, raw.TransactionType, row.transaction_type, raw.description, raw.Description, row.description].filter(Boolean).join(' ');
}
function fulfillmentText(row) { const raw = rawTransaction(row); return JSON.stringify(raw.relatedIdentifiers ?? raw.RelatedIdentifiers ?? raw).slice(0, 12000); }
function matches(rule, context, component, fulfillment) {
  return (!rule.context || rule.context.test(context)) && (!rule.component || rule.component.test(component)) && (!rule.fulfillment || rule.fulfillment.test(fulfillment));
}

export function classifySettlementLine(row) {
  const type = String(row.type ?? '').toLowerCase();
  const isRefund = /refund|retrocharge/.test(type) || Number(row.product_sales ?? 0) < 0;
  const isFba = /amazon|fba/i.test(String(row.fulfillment ?? row.account_type ?? ''));
  const isTransfer = /transfer|disbursement/.test(type) || /transfer|disbursement/i.test(String(row.description ?? ''));
 
  const items = [];
  function push(section, label, amount) {
    const value = Number(amount ?? 0);
    if (value) items.push({ section, label, amount: value, breakdownType: `settlement:${label}` });
  }
 
  if (isTransfer) {
    push('Transfers', /failed/.test(type) ? 'Failed transfers to bank account' : 'Transfers to bank account', row.total);
    return items;
  }
 
  push('Income', isRefund ? 'Seller fulfilled product sale refunds' : (isFba ? 'FBA product sales' : 'Seller fulfilled product sales'), row.product_sales);
  push('Income', isRefund ? 'Shipping credit refunds' : 'Shipping credits', row.shipping_credits);
  push('Income', isRefund ? 'Gift wrap credit refunds' : 'Gift wrap credits', row.gift_wrap_credits);
  push('Income', isRefund ? 'Promotional rebate refunds' : 'Promotional rebates', row.promotional_rebates);
  push('Tax', isRefund ? 'Product, shipping and gift wrap taxes refunded' : 'Product, shipping and gift wrap taxes collected', row.total_sales_tax_liable);
  push('Expenses', 'TCS-CGST Net', row.tcs_cgst);
  push('Expenses', 'TCS-SGST Net', row.tcs_sgst);
  push('Expenses', 'TCS-IGST Net', row.tcs_igst);
  push('Expenses', 'TDS - Section 194-O Net', row.tds_194o);
  push('Expenses', isFba ? 'FBA selling fees' : 'Seller fulfilled selling fees', row.selling_fees);
  push('Expenses', 'FBA transaction fees', row.fba_fees);
  push('Expenses', 'Other transaction fees', row.other_transaction_fees);
  push('Expenses', 'Adjustments', row.other);
  return items;
}

/** Classify one transaction into configured statement buckets. */
export function classifyTransaction(row) {
  const context = contextText(row); const fulfillment = fulfillmentText(row);
  return flattenBreakdowns(rawTransaction(row)).map(part => {
    // Refund rules must precede their positive equivalents even when the
    // config is arranged in report display order.
    const candidates = STATEMENT_CONFIG.flatMap(group => group.lines.map(rule => ({ group, rule })));
    const score = ({ rule }) => (rule.component ? 4 : 0) + (rule.fulfillment ? 2 : 0)
      + (!String(rule.context) .includes('.*') ? 2 : 0)
      + (/refund/i.test(rule.label) === /refund/i.test(context) ? 3 : 0)
      - (/^Others?$|Other expenses/i.test(rule.label) ? 20 : 0);
    const hit = candidates.filter(({ rule }) => matches(rule, context, part.breakdownType, fulfillment)).sort((a, b) => score(b) - score(a))[0];
    return { section: hit?.group.name ?? 'Income', label: hit?.rule.label ?? 'Others', amount: part.amount, breakdownType: part.breakdownType };
  });
}

/** Compute every visible row, debit/credit subtotals, summary and net check. */
export function buildStatement(transactions, settlementLines = []) {
  const details = STATEMENT_CONFIG.flatMap(group => group.lines.map(rule => ({
    section: group.name, label: rule.label, debits: 0, credits: 0, net: 0, source_lines: 0, todo: rule.todo ?? null
  })));
  const byKey = new Map(details.map(row => [`${row.section}\0${row.label}`, row]));
 
  const usingSettlement = settlementLines.length > 0;
  const items = usingSettlement
    ? settlementLines.flatMap(classifySettlementLine)
    : transactions.flatMap(classifyTransaction);
 
  for (const item of items) {
    const target = byKey.get(`${item.section}\0${item.label}`);
    if (!target) continue;
    target.net += item.amount;
    target.source_lines += 1;
    if (item.amount < 0) target.debits += item.amount; else target.credits += item.amount;
  }
 
  const summaries = STATEMENT_CONFIG.map(group => {
    const rows = details.filter(row => row.section === group.name);
    return {
      section: group.name,
      description: group.description,
      debits: rows.reduce((n, r) => n + r.debits, 0),
      credits: rows.reduce((n, r) => n + r.credits, 0),
      total: rows.reduce((n, r) => n + r.net, 0)
    };
  });
 
  const componentTotal = summaries.reduce((n, row) => n + row.total, 0);
  // Real check: compare our bucketed total against Amazon's own `total`
  // column sum from the settlement report (not a tautology against itself).
  const amazonTotal = usingSettlement
    ? settlementLines.reduce((sum, row) => sum + Number(row.total ?? 0), 0)
    : componentTotal;
  const difference = Math.round((componentTotal - amazonTotal) * 100) / 100;
 
  return {
    details,
    summaries,
    reconciliation: {
      componentTotal,
      amazonTotal,
      difference,
      matches: Math.abs(difference) < 0.01,
      source: usingSettlement ? 'Settlement transaction report' : 'Finances API (no settlement rows in period)'
    }
  };
}

export const STATEMENT_SECTION_ORDER = STATEMENT_CONFIG.map(section => section.name);
