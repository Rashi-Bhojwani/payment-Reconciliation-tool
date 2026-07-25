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

export function flattenFinanceTransaction(transaction) {
  const items = transaction?.items ?? transaction?.Items;
  const transactionId = transaction?.transactionId ?? transaction?.TransactionId ?? transaction?.financialEventGroupId ?? transaction?.FinancialEventGroupId;
  const postedDate = transaction?.postedDate ?? transaction?.PostedDate ?? null;
  const currency = transaction?.totalAmount?.currencyCode ?? transaction?.TotalAmount?.CurrencyCode ?? 'INR';
  const transactionOrderId = identifierValue(transaction?.relatedIdentifiers ?? transaction?.RelatedIdentifiers, /order/i);
  const rows = [];
  function walk(value, context, inheritedLabel) {
    if (Array.isArray(value)) return value.forEach(entry => walk(entry, context, inheritedLabel));
    if (!value || typeof value !== 'object') return;
    const label = value.description ?? value.Description ?? value.type ?? value.Type ?? value.breakdownType ?? value.BreakdownType ?? inheritedLabel;
    const amountNode = value.amount ?? value.Amount ?? value.chargeAmount ?? value.ChargeAmount ?? value.feeAmount ?? value.FeeAmount;
    if (amountNode != null && label) rows.push({ transactionId, ...context, category: categorizeFinanceLabel(label), description: String(label), amount: money(amountNode), currency: amountNode?.currencyCode ?? amountNode?.CurrencyCode ?? currency, postedDate, raw: value });
    for (const [key, nested] of Object.entries(value)) if (nested && typeof nested === 'object' && !['amount', 'Amount', 'chargeAmount', 'ChargeAmount', 'feeAmount', 'FeeAmount'].includes(key)) walk(nested, context, label ?? key);
  }
  if (Array.isArray(items) && items.length) {
    for (const item of items) {
      const details = item.productDetails ?? item.ProductDetails ?? {};
      const context = { orderId: identifierValue(item.relatedIdentifiers ?? item.RelatedIdentifiers, /order/i) ?? transactionOrderId, sku: details.sku ?? details.Sku ?? details.sellerSku ?? details.SellerSKU, asin: details.asin ?? details.ASIN };
      walk(item.breakdown ?? item.Breakdown ?? [], context);
    }
  }
  if (!rows.length) rows.push({ transactionId, orderId: transactionOrderId, sku: identifierValue(transaction?.relatedIdentifiers ?? transaction?.RelatedIdentifiers, /sku/i), asin: undefined, category: categorizeFinanceLabel(transaction?.transactionType ?? transaction?.TransactionType), description: transaction?.transactionType ?? transaction?.TransactionType ?? 'Transaction total', amount: money(transaction?.totalAmount ?? transaction?.TotalAmount), currency, postedDate, raw: transaction });
  return rows.filter(row => row.transactionId);
}
