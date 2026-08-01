function money(value) {
  const candidate = value && typeof value === 'object' ? value.currencyAmount ?? value.CurrencyAmount ?? value.amount ?? value.Amount : value;
  const parsed = Number(String(candidate ?? '').replace(/[,₹$]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function categorizeFinanceLabel(label) {
  const value = String(label ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (/refundcommission/.test(value)) return 'refund_commission';
  if (/referral|commission/.test(value)) return 'referral_commission';
  if (/fbaperunit|fulfillmentperunit/.test(value)) return 'fulfillment_fee_per_unit';
  if (/fbaweight|weightbased/.test(value)) return 'fulfillment_fee_weight';
  if (/fulfillment/.test(value)) return 'fulfillment_fee_per_order';
  if (/closing/.test(value)) return 'closing_fee';
  if (/digitalservice/.test(value)) return 'digital_services_fee';
  if (/storage/.test(value)) return 'storage_fee';
  if (/giftwrap.*fee|giftwrapchargeback/.test(value)) return 'gift_wrap_fee';
  if (/giftwrap/.test(value)) return 'gift_wrap';
  if (/shipping.*fee|shippingchargeback/.test(value)) return 'shipping_fee';
  if (/shipping/.test(value)) return 'shipping_charge';
  if (/promotion|discount/.test(value)) return 'promotion';
  if (/principal|itemprice|productcharge/.test(value)) return 'item_price';
  if (/reimbursement|safet/.test(value)) return 'reimbursement';
  if (/chargeback/.test(value)) return 'chargeback';
  if (/refund|return/.test(value)) return 'refund';
  if (/tax|tcs|tds|gst/.test(value)) return 'tax';
  if (/adjustment/.test(value)) return 'adjustment';
  return 'other';
}

function identifierValue(value, pattern) {
  if (Array.isArray(value)) {
    const match = value.find(entry => pattern.test(String(entry?.relatedIdentifierName ?? entry?.RelatedIdentifierName ?? '')));
    return match?.relatedIdentifierValue ?? match?.RelatedIdentifierValue;
  }
  if (!value || typeof value !== 'object') return undefined;
  return Object.entries(value).find(([key]) => pattern.test(key))?.[1];
}

// Per the Finances API v2024-06-19 schema, SKU/ASIN are not direct fields of
// an Item or Transaction - they live on a polymorphic Context entry whose
// contextType is "ProductContext" (contexts: [{contextType, asin, sku,
// quantityShipped, fulfillmentNetwork}, ...]). There is no "productDetails"
// or "productContext" field anywhere in the real response.
function productContext(contexts) {
  const list = Array.isArray(contexts) ? contexts : [];
  const match = list.find(entry => /^productcontext$/i.test(String(entry?.contextType ?? entry?.ContextType ?? '')));
  return { sku: match?.sku ?? match?.Sku ?? match?.sellerSku ?? match?.SellerSKU, asin: match?.asin ?? match?.ASIN };
}

function summaryCategory(label) {
  const value = String(label ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (/totalproductcharge|productcharge/.test(value)) return 'summary_product_charges';
  if (/promotionalrebate|promotion/.test(value)) return 'summary_promotional_rebates';
  if (/amazonfees|sellingfees/.test(value)) return 'summary_amazon_fees';
  if (/^other$|othertransactions|otheramount/.test(value)) return 'summary_other';
  return null;
}

// Some breakdown leaves carry only a generic sub-component name - "Base"
// (the pre-tax amount) and "Tax" (GST on it) are the confirmed real-world
// case (verified live: every single "Base"/"Tax" pair in a real account's
// Deferred transactions was exactly an 18.00% ratio - India's GST rate -
// with no exception). On their own these are meaningless for
// classification: "Base" could be the pre-tax amount of *any* fee, and a
// bare "Tax" line is indistinguishable from withholding or product tax.
// Their parent node's own label (e.g. "Commission", "FBAPerUnitFulfillmentFee")
// is the only thing that actually says what the fee *is*, and the original
// code discarded it entirely whenever the leaf had any label of its own -
// inheritedLabel was a pure fallback, never combined with the leaf's own
// description. Prefixing the parent's label back on for just this known
// generic set restores that context without changing the label used for
// leaves that already carry Amazon's own specific name (a "Commission" leaf
// still classifies as "Commission", not "SomeParent Commission").
const GENERIC_LEAF_LABELS = new Set(['base', 'tax', 'amount', 'fee', 'total']);

export function flattenFinanceTransaction(transaction) {
  const items = transaction?.items ?? transaction?.Items ?? transaction?.contexts ?? transaction?.Contexts;
  const transactionId = transaction?.transactionId ?? transaction?.TransactionId ?? transaction?.financialEventGroupId ?? transaction?.FinancialEventGroupId;
  const postedDate = transaction?.postedDate ?? transaction?.PostedDate ?? null;
  const currency = transaction?.totalAmount?.currencyCode ?? transaction?.TotalAmount?.CurrencyCode ?? 'INR';
  const transactionOrderId = identifierValue(transaction?.relatedIdentifiers ?? transaction?.RelatedIdentifiers, /order/i);
  const rows = [];
  function walk(value, context, inheritedLabel) {
    if (Array.isArray(value)) return value.forEach(entry => walk(entry, context, inheritedLabel));
    if (!value || typeof value !== 'object') return;
    const ownLabel = value.description ?? value.Description ?? value.type ?? value.Type ?? value.breakdownType ?? value.BreakdownType;
    const isGenericOwnLabel = ownLabel && GENERIC_LEAF_LABELS.has(String(ownLabel).trim().toLowerCase());
    const label = isGenericOwnLabel && inheritedLabel && String(inheritedLabel).toLowerCase() !== String(ownLabel).toLowerCase()
      ? `${inheritedLabel} ${ownLabel}`
      : (ownLabel ?? inheritedLabel);
    const amountNode = value.amount ?? value.Amount ?? value.breakdownAmount ?? value.BreakdownAmount ?? value.chargeAmount ?? value.ChargeAmount ?? value.feeAmount ?? value.FeeAmount;
    const childBreakdowns = value.breakdown ?? value.Breakdown ?? value.breakdowns ?? value.Breakdowns;
    // Amazon sometimes supplies a parent total alongside its nested component
    // amounts. Preserve those explicit Seller Central column totals under a
    // summary category; calculations select either summaries or leaves, never
    // both. This lets the UI match Transaction View without guessing buckets.
    const hasChildren = Array.isArray(childBreakdowns) ? childBreakdowns.length > 0 : Boolean(childBreakdowns && typeof childBreakdowns === 'object');
    const summary = hasChildren ? summaryCategory(label) : null;
    if (amountNode != null && summary) rows.push({ transactionId, ...context, category: summary, description: String(label), amount: money(amountNode), currency: amountNode?.currencyCode ?? amountNode?.CurrencyCode ?? currency, postedDate, raw: value });
    if (amountNode != null && label && !hasChildren) rows.push({ transactionId, ...context, category: categorizeFinanceLabel(label), description: String(label), amount: money(amountNode), currency: amountNode?.currencyCode ?? amountNode?.CurrencyCode ?? currency, postedDate, raw: value });
    for (const [key, nested] of Object.entries(value)) if (nested && typeof nested === 'object' && !['amount', 'Amount', 'breakdownAmount', 'BreakdownAmount', 'chargeAmount', 'ChargeAmount', 'feeAmount', 'FeeAmount'].includes(key)) walk(nested, context, label ?? key);
  }
  if (Array.isArray(items) && items.length) {
    for (const item of items) {
      const details = productContext(item.contexts ?? item.Contexts);
      const context = { orderId: identifierValue(item.relatedIdentifiers ?? item.RelatedIdentifiers, /order/i) ?? transactionOrderId, sku: details.sku, asin: details.asin };
      walk(item.breakdown ?? item.Breakdown ?? item.breakdowns ?? item.Breakdowns ?? [], context);
    }
  }
  // Some 2024-06-19 responses put breakdowns directly on the transaction and
  // expose SKU/ASIN separately in contexts rather than an items array.
  if (!rows.length) {
    const details = productContext(transaction?.contexts ?? transaction?.Contexts);
    walk(transaction?.breakdown ?? transaction?.Breakdown ?? transaction?.breakdowns ?? transaction?.Breakdowns ?? [], { orderId: transactionOrderId, sku: details.sku, asin: details.asin });
  }
  // transactionType is a structural field (its only documented value is
  // "Shipment" - it never carries a semantic reason). The actual reason for
  // the transaction ("Order Payment", "Refund Order", a reimbursement, etc.)
  // is in `description`. Categorizing off transactionType here would silently
  // bucket every unbroken-down transaction as "other".
  if (!rows.length) {
    const label = transaction?.description ?? transaction?.Description ?? transaction?.transactionType ?? transaction?.TransactionType ?? 'Transaction total';
    const details = productContext(transaction?.contexts ?? transaction?.Contexts);
    rows.push({ transactionId, orderId: transactionOrderId, sku: details.sku, asin: details.asin, category: categorizeFinanceLabel(label), description: String(label), amount: money(transaction?.totalAmount ?? transaction?.TotalAmount), currency, postedDate, raw: transaction });
  }
  return rows.filter(row => row.transactionId);
}
