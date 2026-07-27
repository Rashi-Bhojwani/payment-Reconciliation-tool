import { createHash } from 'node:crypto';
import { number, pick, reportDate, text } from './report-parsing.js';

const aliases = {
  posted_at: ['date/time', 'date time', 'posted-date', 'posted date', 'postedAt'], settlement_id: ['settlement id', 'settlement-id', 'settlementId'],
  type: ['type', 'transaction type', 'transactionType'], order_id: ['order id', 'order-id', 'amazon-order-id', 'amazonOrderId'], sku: ['Sku', 'seller sku', 'sellerSku'],
  description: ['description', 'transaction description'], quantity: ['quantity', 'qty'], marketplace: ['marketplace', 'market place'], account_type: ['account type', 'accountType'],
  fulfillment: ['fulfillment', 'fulfilment', 'fulfillment channel'], order_city: ['order city', 'orderCity'], order_state: ['order state', 'orderState'], order_postal: ['order postal', 'orderPostal', 'order postal code'],
  product_sales: ['product sales', 'productSales'], shipping_credits: ['shipping credits', 'shippingCredits'], gift_wrap_credits: ['gift wrap credits', 'giftWrapCredits'],
  promotional_rebates: ['promotional rebates', 'promotionalRebates'], total_sales_tax_liable: ['Total sales tax liable(GST before adjusting TCS)', 'total sales tax liable', 'totalSalesTaxLiable'],
  tcs_cgst: ['TCS-CGST', 'tcs cgst', 'tcsCgst'], tcs_sgst: ['TCS-SGST', 'tcs sgst', 'tcsSgst'], tcs_igst: ['TCS-IGST', 'tcs igst', 'tcsIgst'],
  tds_194o: ['TDS (Section 194-O)', 'tds 194o', 'tds194o'], selling_fees: ['selling fees', 'sellingFees'], fba_fees: ['fba fees', 'fbaFees'],
  other_transaction_fees: ['other transaction fees', 'otherTransactionFees'], other: ['other'], total: ['total'], transaction_status: ['Transaction Status', 'transactionStatus'],
  transaction_release_date: ['Transaction Release Date', 'transactionReleaseDate', 'release date']
};
const numericFields = ['product_sales','shipping_credits','gift_wrap_credits','promotional_rebates','total_sales_tax_liable','tcs_cgst','tcs_sgst','tcs_igst','tds_194o','selling_fees','fba_fees','other_transaction_fees','other','total'];

export function mapSettlementRow(row) {
  const mapped = {};
  for (const [field, names] of Object.entries(aliases)) mapped[field] = text(pick(row, names)) ?? null;
  mapped.posted_at = reportDate(mapped.posted_at);
  mapped.transaction_release_date = reportDate(mapped.transaction_release_date);
  mapped.quantity = mapped.quantity == null ? null : Math.trunc(number(mapped.quantity));
  for (const field of numericFields) mapped[field] = number(mapped[field]);
  mapped.raw_row = row;
  mapped.dedupe_key = createHash('sha256').update(JSON.stringify([mapped.settlement_id,mapped.type,mapped.order_id,mapped.sku,mapped.description,mapped.posted_at,mapped.total])).digest('hex');
  return mapped;
}

export function parseDelimited(content) {
  const lines = String(content).replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  const headerIndex = lines.findIndex(line => /(date\/time|posted[ -]date)/i.test(line) && /settlement[ -]?id/i.test(line));
  if (headerIndex < 0) return [];
  const delimiter = lines[headerIndex].includes('\t') ? '\t' : ',';
  const parseLine = line => { const out=[]; let value=''; let quoted=false; for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===delimiter&&!quoted){out.push(value);value='';}else value+=c;}out.push(value);return out; };
  const headers = parseLine(lines[headerIndex]).map(value => value.trim());
  return lines.slice(headerIndex + 1).map(parseLine).filter(values => values.some(Boolean)).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function classicMoneyField(row) {
  const amountType = text(pick(row, ['amount-type'])) ?? '';
  const description = text(pick(row, ['amount-description'])) ?? '';
  const label = `${amountType} ${description}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (/tcs.*cgst/.test(label)) return 'tcs_cgst';
  if (/tcs.*sgst/.test(label)) return 'tcs_sgst';
  if (/tcs.*igst/.test(label)) return 'tcs_igst';
  if (/tds|194o|withheldtax/.test(label)) return 'tds_194o';
  if (/tax/.test(label)) return 'total_sales_tax_liable';
  if (/promotion|promo/.test(label)) return 'promotional_rebates';
  if (/giftwrap/.test(label) && !/fee|chargeback/.test(label)) return 'gift_wrap_credits';
  if (/shipping/.test(label) && !/fee|chargeback|label/.test(label)) return 'shipping_credits';
  if (/principal|productcharge/.test(label)) return 'product_sales';
  if (/commission|referral|closing|sellingfee/.test(label)) return 'selling_fees';
  if (/fba|fulfillment|storage|inbound/.test(label)) return 'fba_fees';
  if (/fee|chargeback|shippinglabel|advertis/.test(label)) return 'other_transaction_fees';
  return 'other';
}

function mapClassicSettlementRow(row) {
  const amount = number(pick(row, ['amount']));
  const amountType = text(pick(row, ['amount-type'])) ?? '';
  const amountDescription = text(pick(row, ['amount-description'])) ?? '';
  const mapped = {
    posted_at: reportDate(pick(row, ['posted-date-time', 'posted-date'])),
    settlement_id: text(pick(row, ['settlement-id'])) ?? null,
    type: text(pick(row, ['transaction-type'])) ?? amountType ?? null,
    order_id: text(pick(row, ['order-id'])) ?? null,
    sku: text(pick(row, ['sku'])) ?? null,
    description: [amountType, amountDescription].filter(Boolean).join(' · ') || null,
    quantity: Math.trunc(number(pick(row, ['quantity-purchased']))),
    marketplace: text(pick(row, ['marketplace-name'])) ?? null,
    account_type: 'Amazon settlement transactions',
    fulfillment: text(pick(row, ['fulfillment-id'])) ?? null,
    order_city: null, order_state: null, order_postal: null,
    product_sales: 0, shipping_credits: 0, gift_wrap_credits: 0, promotional_rebates: 0,
    total_sales_tax_liable: 0, tcs_cgst: 0, tcs_sgst: 0, tcs_igst: 0, tds_194o: 0,
    selling_fees: 0, fba_fees: 0, other_transaction_fees: 0, other: 0,
    total: amount, transaction_status: 'Released',
    transaction_release_date: reportDate(pick(row, ['deposit-date'])), raw_row: row
  };
  mapped[classicMoneyField(row)] = amount;
  mapped.dedupe_key = createHash('sha256').update(JSON.stringify([mapped.settlement_id,mapped.type,mapped.order_id,mapped.sku,mapped.description,mapped.posted_at,amount,row['order-item-code'],row['shipment-id']])).digest('hex');
  return mapped;
}
export function parseSettlementContent(content) {
  // Amazon does not provide a row id and can emit multiple byte-identical
  // transaction lines. A hash alone would collapse those legitimate rows and
  // make every aggregate smaller than Seller Central. Preserve their stable
  // report order with a per-identity occurrence suffix.
  const parsedRows = parseDelimited(content);
  const classic = parsedRows.some(row => Object.hasOwn(row, 'amount-type') && Object.hasOwn(row, 'amount'));
  // Classic V2 files contain a settlement header row with total-amount but no
  // component amount. Exclude it: counting it alongside the component lines
  // is the most common reason dashboards are exactly one payout too high.
  const sourceRows = classic ? parsedRows.filter(row => text(row['amount']) != null) : parsedRows;
  const occurrences = new Map();
  return sourceRows.map(row => {
    const mapped = classic ? mapClassicSettlementRow(row) : mapSettlementRow(row);
    const occurrence = occurrences.get(mapped.dedupe_key) ?? 0;
    occurrences.set(mapped.dedupe_key, occurrence + 1);
    // Keep occurrence zero compatible with rows imported before duplicate-line
    // support, so the corrective rolling sync updates rather than doubles them.
    if (occurrence > 0) mapped.dedupe_key = `${mapped.dedupe_key}:${occurrence}`;
    return mapped;
  });
}
export { aliases as SETTLEMENT_HEADER_ALIASES, numericFields as SETTLEMENT_NUMERIC_FIELDS };
