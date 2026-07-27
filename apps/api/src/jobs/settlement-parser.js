import { createHash } from 'node:crypto';

export function text(value) { return value == null ? undefined : String(value).trim() || undefined; }
export function number(value) { const parsed = Number(String(value ?? '').replace(/[,₹$]/g, '')); return Number.isFinite(parsed) ? parsed : 0; }
export function reportDate(value) {
  const input = text(value); if (!input) return null;
  const match = input.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(.*))?$/);
  if (!match) return input;
  const [, day, month, year, time] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}${time ? ` ${time}` : ''}`;
}
export function pick(row, names) {
  const normalized = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const values = new Map(Object.entries(row).map(([key, value]) => [normalized(key), value]));
  for (const name of names) { const value = values.get(normalized(name)); if (value != null && String(value).trim() !== '') return value; }
  return undefined;
}

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
  const headerIndex = lines.findIndex(line => /date\/time/i.test(line) && /settlement[ -]?id/i.test(line));
  if (headerIndex < 0) return [];
  const delimiter = lines[headerIndex].includes('\t') ? '\t' : ',';
  const parseLine = line => { const out=[]; let value=''; let quoted=false; for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===delimiter&&!quoted){out.push(value);value='';}else value+=c;}out.push(value);return out; };
  const headers = parseLine(lines[headerIndex]).map(value => value.trim());
  return lines.slice(headerIndex + 1).map(parseLine).filter(values => values.some(Boolean)).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}
export function parseSettlementContent(content) {
  // Amazon does not provide a row id and can emit multiple byte-identical
  // transaction lines. A hash alone would collapse those legitimate rows and
  // make every aggregate smaller than Seller Central. Preserve their stable
  // report order with a per-identity occurrence suffix.
  const occurrences = new Map();
  return parseDelimited(content).map(row => {
    const mapped = mapSettlementRow(row);
    const occurrence = occurrences.get(mapped.dedupe_key) ?? 0;
    occurrences.set(mapped.dedupe_key, occurrence + 1);
    // Keep occurrence zero compatible with rows imported before duplicate-line
    // support, so the corrective rolling sync updates rather than doubles them.
    if (occurrence > 0) mapped.dedupe_key = `${mapped.dedupe_key}:${occurrence}`;
    return mapped;
  });
}
export { aliases as SETTLEMENT_HEADER_ALIASES, numericFields as SETTLEMENT_NUMERIC_FIELDS };
