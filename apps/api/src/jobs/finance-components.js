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
  // Amazon's Finances v2024-06-19 model and sandbox examples use both
  // "Principal" and the misspelled "Principle".
  if (/principal|principle|itemprice|productcharge/.test(value)) return 'item_price';
  if (/reimbursement|safet/.test(value)) return 'reimbursement';
  if (/chargeback/.test(value)) return 'chargeback';
  if (/refund|return/.test(value)) return 'refund';
  if (/tax|tcs|tds|gst/.test(value)) return 'tax';
  if (/adjustment/.test(value)) return 'adjustment';
  return 'other';
}

function compact(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function namedIdentifier(value, names) {
  const wanted = new Set(names.map(compact));
  if (Array.isArray(value)) {
    const match = value.find(entry => wanted.has(compact(
      entry?.relatedIdentifierName
      ?? entry?.RelatedIdentifierName
      ?? entry?.itemRelatedIdentifierName
      ?? entry?.ItemRelatedIdentifierName
    )));
    return match?.relatedIdentifierValue
      ?? match?.RelatedIdentifierValue
      ?? match?.itemRelatedIdentifierValue
      ?? match?.ItemRelatedIdentifierValue;
  }
  if (!value || typeof value !== 'object') return undefined;
  return Object.entries(value).find(([key]) => wanted.has(compact(key)))?.[1];
}

function breakdownsOf(value) {
  if (!value || typeof value !== 'object') return [];
  const candidate = value.breakdowns ?? value.Breakdowns ?? value.breakdown ?? value.Breakdown;
  if (Array.isArray(candidate)) return candidate;
  if (!candidate || typeof candidate !== 'object') return [];
  const nested = candidate.breakdowns ?? candidate.Breakdowns ?? candidate.breakdown ?? candidate.Breakdown;
  return Array.isArray(nested) ? nested : [];
}

function breakdownLabel(value) {
  return value?.description
    ?? value?.Description
    ?? value?.type
    ?? value?.Type
    ?? value?.breakdownType
    ?? value?.BreakdownType;
}

function breakdownAmount(value) {
  return value?.amount
    ?? value?.Amount
    ?? value?.breakdownAmount
    ?? value?.BreakdownAmount
    ?? value?.chargeAmount
    ?? value?.ChargeAmount
    ?? value?.feeAmount
    ?? value?.FeeAmount;
}

function summaryCategory(label) {
  const value = String(label ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (/totalproductcharge|productcharge/.test(value)) return 'summary_product_charges';
  if (/promotionalrebate|promotion/.test(value)) return 'summary_promotional_rebates';
  if (/amazonfees|sellingfees/.test(value)) return 'summary_amazon_fees';
  if (/^other$|othertransactions|otheramount/.test(value)) return 'summary_other';
  return null;
}

function sectionSummaryCategory(label) {
  const value = compact(label);
  if (/^(income|sales)$/.test(value)) return 'summary_income';
  if (/^(expenses?|deductions?)$/.test(value)) return 'summary_expenses';
  if (/^refunds?$/.test(value)) return 'summary_refunds';
  if (/^(goodsandservicestax|gst)$/.test(value)) return 'summary_gst';
  if (/^tax(es)?$/.test(value)) return 'summary_tax';
  return null;
}

function productContext(item) {
  const contexts = item?.contexts ?? item?.Contexts;
  if (!Array.isArray(contexts)) return {};
  return contexts.find(context => /productcontext/i.test(String(context?.contextType ?? context?.ContextType ?? '')))
    ?? contexts.find(context => context?.sku ?? context?.Sku ?? context?.asin ?? context?.ASIN)
    ?? {};
}

export function flattenFinanceTransaction(transaction) {
  const items = transaction?.items ?? transaction?.Items;
  const transactionId = transaction?.transactionId ?? transaction?.TransactionId ?? transaction?.financialEventGroupId ?? transaction?.FinancialEventGroupId;
  const postedDate = transaction?.postedDate ?? transaction?.PostedDate ?? null;
  const currency = transaction?.totalAmount?.currencyCode ?? transaction?.TotalAmount?.CurrencyCode ?? 'INR';
  const transactionOrderId = namedIdentifier(
    transaction?.relatedIdentifiers ?? transaction?.RelatedIdentifiers,
    ['ORDER_ID', 'AMAZON_ORDER_ID']
  );
  const rows = [];
  function walk(value, context, path = []) {
    if (!value || typeof value !== 'object') return;
    const label = breakdownLabel(value);
    const amountNode = breakdownAmount(value);
    const childBreakdowns = breakdownsOf(value);
    const nextPath = label ? [...path, String(label)] : path;
    // Amazon sometimes supplies a parent total alongside its nested component
    // amounts. Preserve those explicit Seller Central column totals under a
    // summary category; calculations select either summaries or leaves, never
    // both. This lets the UI match Transaction View without guessing buckets.
    const hasChildren = childBreakdowns.length > 0;
    const summary = hasChildren ? summaryCategory(label) : null;
    const common = {
      transactionId,
      ...context,
      currency: amountNode?.currencyCode ?? amountNode?.CurrencyCode ?? currency,
      postedDate,
      breakdownPath: nextPath.join(' > '),
      raw: value
    };
    if (amountNode != null && summary) rows.push({ ...common, category: summary, description: String(label), amount: money(amountNode) });
    if (amountNode != null && label && !hasChildren) rows.push({ ...common, category: categorizeFinanceLabel(label), description: String(label), amount: money(amountNode) });
    for (const child of childBreakdowns) walk(child, context, nextPath);
  }

  if (Array.isArray(items) && items.length) {
    for (const item of items) {
      const details = item.productDetails ?? item.ProductDetails ?? item.productContext ?? item.ProductContext ?? productContext(item);
      const context = {
        orderId: namedIdentifier(item.relatedIdentifiers ?? item.RelatedIdentifiers, ['ORDER_ID', 'AMAZON_ORDER_ID']) ?? transactionOrderId,
        sku: details.sku ?? details.Sku ?? details.sellerSku ?? details.SellerSKU,
        asin: details.asin ?? details.ASIN
      };
      for (const entry of breakdownsOf(item)) walk(entry, context);
    }

    // Item leaves are the granular source used by product KPIs. The
    // transaction-level roots are still needed for Amazon Account Activity,
    // but only store their section totals here so the item values are not
    // duplicated.
    for (const root of breakdownsOf(transaction)) {
      const label = breakdownLabel(root);
      const amountNode = breakdownAmount(root);
      const category = sectionSummaryCategory(label);
      if (label && amountNode != null && category) {
        rows.push({
          transactionId,
          orderId: transactionOrderId,
          sku: undefined,
          asin: undefined,
          category,
          description: String(label),
          amount: money(amountNode),
          currency: amountNode?.currencyCode ?? amountNode?.CurrencyCode ?? currency,
          postedDate,
          breakdownPath: String(label),
          raw: root
        });
      }
    }
  }

  // Some 2024-06-19 responses put breakdowns directly on the transaction and
  // expose SKU/ASIN separately in contexts rather than an items array.
  if (!rows.length) {
    const contextNode = (transaction?.contexts ?? transaction?.Contexts ?? [])[0] ?? {};
    const details = contextNode.productContext ?? contextNode.ProductContext ?? contextNode;
    const context = { orderId: transactionOrderId, sku: details.sku ?? details.Sku, asin: details.asin ?? details.ASIN };
    for (const entry of breakdownsOf(transaction)) walk(entry, context);
  }
  if (!rows.length) rows.push({
    transactionId,
    orderId: transactionOrderId,
    sku: namedIdentifier(transaction?.relatedIdentifiers ?? transaction?.RelatedIdentifiers, ['SKU', 'SELLER_SKU']),
    asin: undefined,
    category: categorizeFinanceLabel(transaction?.transactionType ?? transaction?.TransactionType),
    description: transaction?.transactionType ?? transaction?.TransactionType ?? 'Transaction total',
    amount: money(transaction?.totalAmount ?? transaction?.TotalAmount),
    currency,
    postedDate,
    raw: transaction
  });
  return rows.filter(row => row.transactionId);
}

function sectionFromPath(path, transaction) {
  const labels = path.map(compact);
  const joined = labels.join(' ');

  // Tax charged on an Amazon fee remains an expense. Product/shipping/gift
  // wrap tax is the seller's GST activity. TCS/TDS is a deduction.
  if (/tcs|tds|withholding/.test(joined)) return 'expenses';
  if (/commission|closingfee|fbafee|amazonfee|sellingfee|servicefee|storagefee|shippinglabel|easyship|postage|advertis|chargeback|inboundtransport/.test(joined)) return 'expenses';
  if (/producttax|shippingtax|giftwraptax|goodsandservicestax|gstcollected|gstrefund/.test(joined)) return 'gst';

  // A nested explicit section is more specific than an outer "Sales" or
  // "Refunds" total, so inspect from the leaf back to the root.
  for (let index = labels.length - 1; index >= 0; index -= 1) {
    const label = labels[index];
    if (/^(expenses?|deductions?)$/.test(label)) return 'expenses';
    if (/^(goodsandservicestax|gst)$/.test(label)) return 'gst';
    if (/^tax(es)?$/.test(label)) return 'tax';
    if (/^(income|sales)$/.test(label)) return 'income';
  }

  if (/principal|principle|itemprice|productcharges?/.test(joined)) return 'income';
  // Seller-funded promotions reduce sales in the dashboard's Net Sales
  // definition; keep them with income so they are not counted again as an
  // Amazon-fee deduction.
  if (/promotion|discount/.test(joined)) return 'income';
  if (/refund/.test(joined)) return 'income';

  const transactionText = compact(`${transaction?.transaction_type ?? ''} ${transaction?.transactionType ?? ''} ${transaction?.description ?? ''}`);
  if (/refund/.test(transactionText)) return 'income';
  return null;
}

/**
 * Rebuilds the Amazon Account Activity sections from the authoritative
 * transaction-level Finances v2024-06-19 breakdown tree.
 *
 * The API's `accountType` is an account name such as "Standard Orders"; it is
 * not the Income/Expenses section. Section meaning comes from the breakdown
 * ancestry, which must be retained while walking to leaf amounts.
 */
export function extractFinanceSectionRows(transactions = []) {
  const rows = [];

  for (const transactionRow of transactions) {
    const transaction = transactionRow?.raw && typeof transactionRow.raw === 'object'
      ? transactionRow.raw
      : transactionRow;
    const transactionId = transactionRow?.transaction_id
      ?? transaction?.transactionId
      ?? transaction?.TransactionId
      ?? transaction?.financialEventGroupId
      ?? transaction?.FinancialEventGroupId;
    if (!transactionId) continue;

    const postedDate = transactionRow?.posted_date ?? transaction?.postedDate ?? transaction?.PostedDate ?? null;
    const transactionType = transactionRow?.transaction_type ?? transaction?.transactionType ?? transaction?.TransactionType;
    const transactionDescription = transaction?.description ?? transaction?.Description;
    const accountType = transaction?.sellingPartnerMetadata?.accountType
      ?? transaction?.sellingPartnerMetadata?.AccountType
      ?? transaction?.SellingPartnerMetadata?.AccountType
      ?? transaction?.SellingPartnerMetadata?.accountType
      ?? transaction?.accountType
      ?? transaction?.AccountType;
    const orderId = transactionRow?.related_order_id ?? namedIdentifier(
      transaction?.relatedIdentifiers ?? transaction?.RelatedIdentifiers,
      ['ORDER_ID', 'AMAZON_ORDER_ID']
    );

    function addRow(node, path, indexPath, value, suffix = '') {
      const section = sectionFromPath(path, { ...transaction, transaction_type: transactionType });
      if (!section || !Number.isFinite(value) || value === 0) return;
      rows.push({
        source_row_id: `finance-section:${transactionId}:${indexPath.join('.')}${suffix}`,
        transaction_id: transactionId,
        order_id: orderId,
        transaction_type: transactionType,
        transaction_description: transactionDescription,
        account_type: accountType,
        account_section: section,
        amount_type: 'Finance breakdown',
        amount_description: path.join(' > '),
        category: `account_${section}`,
        amount: value,
        posted_date: postedDate,
        raw: node
      });
    }

    function walk(node, path = [], indexPath = []) {
      const label = breakdownLabel(node);
      const nextPath = label ? [...path, String(label)] : path;
      const children = breakdownsOf(node);
      const amountNode = breakdownAmount(node);
      const nodeAmount = amountNode == null ? null : money(amountNode);

      if (!children.length) {
        if (nodeAmount != null) addRow(node, nextPath, indexPath, nodeAmount);
        return nodeAmount ?? 0;
      }

      let childTotalPaise = 0;
      children.forEach((child, childIndex) => {
        childTotalPaise += Math.round(walk(child, nextPath, [...indexPath, childIndex]) * 100);
      });

      if (nodeAmount != null) {
        const remainderPaise = Math.round(nodeAmount * 100) - childTotalPaise;
        if (remainderPaise !== 0) addRow(node, nextPath, indexPath, remainderPaise / 100, ':remainder');
        return nodeAmount;
      }
      return childTotalPaise / 100;
    }

    breakdownsOf(transaction).forEach((root, rootIndex) => walk(root, [], [rootIndex]));
  }

  return rows;
}