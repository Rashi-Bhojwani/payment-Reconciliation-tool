// Amazon's Custom Unified Transaction report - the row-level data behind the
// Custom Unified Summary PDF that sellers reconcile against.
//
// This is the only artefact examined so far that reproduces that PDF EXACTLY.
// Verified against a real matched pair (MINDCIRCUS, 1-25 Jul 2026), every
// section and every named sub-line to the paisa, zero difference:
//
//   Income      1,32,046.97      Expenses     -42,314.88
//   GST            23,691.75     Transfers  -1,07,559.21
//
//   Seller fulfilled product sales   1,44,957.78    FBA product sales    40,596.67
//   Seller fulfilled sale refunds      -44,233.93    FBA sale refunds     -7,983.89
//   Shipping credits                       861.04    Shipping refunds       -169.50
//   Promotional rebates                 -2,840.11    Promo rebate refunds    433.66
//   GST collected                       33,043.39    GST refunds          -9,351.64
//
// Cross-validated on a second, structurally different account (100% merchant
// fulfilled, 37 deferred rows) where no PDF was available, using Amazon's own
// grand total as the control: sections summed to -2,30,388.44 against a stated
// -2,30,388.44.
//
// Why it succeeds where the older "Transactions for time period" export fails:
// this report is indexed by POSTED DATE and carries BOTH released and deferred
// transactions (Amazon states this in the file's own preamble), it names the
// fulfilment channel per row, and its money columns are already Amazon's own
// statement sections rather than four aggregates that have to be re-derived.
//
// The fulfilment column is the ONLY source found for the PDF's FBA vs
// seller-fulfilled split. The older export has no fulfilment column at all -
// its "account type" is COD vs Electronic, a payment rail, not a channel.
//
// Deferred is a live population. Measured here it contributed Income +7,152.59,
// Expenses -2,030.55 and GST +1,287.46 - so a settlement-only figure is short
// by that much, and a report pulled at a different moment legitimately differs.
import { toPaise, paiseToRupees, parseCsv } from './date-range-report.js';

// Amazon prefixes the file with a title, a definitions block and a format note
// before the real header. The header is found by its first column rather than
// by a fixed offset, because that preamble grows when Amazon adds a definition.
const HEADER_FIRST_COLUMN = /^date\s*\/?\s*time$/i;

const ALIASES = Object.freeze({
  postedAt: ['date time'],
  settlementId: ['settlement id'],
  type: ['type'],
  orderId: ['order id'],
  sku: ['sku'],
  description: ['description'],
  quantity: ['quantity'],
  marketplace: ['marketplace'],
  accountType: ['account type'],
  fulfillment: ['fulfillment', 'fulfilment'],
  productSales: ['product sales'],
  shippingCredits: ['shipping credits'],
  giftWrapCredits: ['gift wrap credits'],
  promotionalRebates: ['promotional rebates'],
  salesTaxLiable: ['total sales tax liable gst before adjusting tcs', 'total sales tax liable'],
  tcsCgst: ['tcs cgst'],
  tcsSgst: ['tcs sgst'],
  tcsIgst: ['tcs igst'],
  tds: ['tds section 194 o'],
  sellingFees: ['selling fees'],
  fbaFees: ['fba fees'],
  otherTransactionFees: ['other transaction fees'],
  other: ['other'],
  total: ['total'],
  status: ['transaction status'],
  releaseDate: ['transaction release date']
});

// Money columns that always belong to one section, whatever the row is.
const INCOME_COLUMNS = Object.freeze(['productSales', 'shippingCredits', 'giftWrapCredits', 'promotionalRebates']);
const EXPENSE_COLUMNS = Object.freeze(['sellingFees', 'fbaFees', 'otherTransactionFees', 'tcsCgst', 'tcsSgst', 'tcsIgst', 'tds']);
const GST_COLUMNS = Object.freeze(['salesTaxLiable']);
const MONEY_COLUMNS = Object.freeze([...INCOME_COLUMNS, ...EXPENSE_COLUMNS, ...GST_COLUMNS, 'other', 'total']);

const MANDATORY = Object.freeze(['postedAt', 'type', 'productSales', 'other', 'total']);
const normalise = value => String(value ?? '').replace(/[()]/g, ' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The "other" column is the only one whose section depends on the row rather
 * than the column, because Amazon uses it for everything that is not an order
 * line. Its section is decided by the row's own `type`, which is Amazon's
 * word, not ours. Measured on the reconciled pair, every one of these landed
 * on a named PDF line exactly:
 *
 *   Transfer               -1,07,559.21  -> Transfers / Transfers to bank account
 *   Adjustment | Other           -923.64  -> Expenses  / Adjustments
 *   FBA Inventory Fee            -847.34  -> Expenses  / FBA inventory and inbound services fees
 *   SAFE-T Reimbursement          196.72  -> Income    / SAFE-T Reimbursements
 *   Adjustment | FBA Inv Reimb    228.53  -> Income    / FBA inventory credit
 *
 * An unrecognised type is still counted - dropping money silently is the
 * failure this tool exists to prevent - but it is also reported in
 * `unclassified` so it can never quietly distort a section.
 */
export function sectionForOtherAmount(row) {
  const type = String(row?.type ?? '').trim();
  const label = `${type} ${row?.description ?? ''}`;
  if (/^transfers?$/i.test(type)) return { section: 'transfers', known: true };
  if (/\bfee\b|\bfees\b/i.test(type)) return { section: 'expenses', known: true };
  if (/safe-?t|reimbursement|clawback|a-to-z|chargeback/i.test(label)) return { section: 'income', known: true };
  if (/^adjustment$/i.test(type)) return { section: 'expenses', known: true };
  if (/^(service fee|shipping services|tax withheld|order|refund)$/i.test(type)) return { section: 'expenses', known: true };
  return { section: 'expenses', known: false };
}

/** @param {string[]} header */
export function mapUnifiedColumns(header) {
  const normalised = header.map(normalise);
  const index = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const position = normalised.findIndex(name => aliases.includes(name));
    if (position !== -1) index[field] = position;
  }
  return { index, missing: MANDATORY.filter(field => index[field] === undefined) };
}

/**
 * Parses the report into physical rows. Nothing is filtered, merged or
 * de-duplicated - two identical-looking rows are two real transactions and
 * both survive, keyed by physical row number rather than a content hash.
 * @param {string} text
 */
export function parseUnifiedTransactionReport(text) {
  const grid = parseCsv(text);
  const headerRow = grid.findIndex(row => row.some(cell => HEADER_FIRST_COLUMN.test(String(cell ?? '').trim())));
  if (headerRow === -1) {
    return { ok: false, error: 'No "date/time" header row found - this is not a Custom Unified Transaction report', rows: [], errors: [], header: [] };
  }
  const header = grid[headerRow].map(cell => String(cell ?? '').trim());
  const { index, missing } = mapUnifiedColumns(header);
  if (missing.length) {
    return { ok: false, error: `Missing required column(s): ${missing.join(', ')}`, rows: [], errors: [], header };
  }
  const rows = [];
  const errors = [];
  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const raw = grid[i];
    if (raw.length <= 1 && !String(raw[0] ?? '').trim()) continue;
    const physicalRow = i + 1;
    const at = field => (index[field] === undefined ? '' : raw[index[field]] ?? '');
    const money = {};
    let broken = false;
    for (const column of MONEY_COLUMNS) {
      if (index[column] === undefined) { money[column] = 0; continue; }
      const paise = toPaise(at(column));
      if (paise === null) { errors.push({ physicalRow, column, value: at(column) }); broken = true; break; }
      money[column] = paise;
    }
    if (broken) continue;
    rows.push({
      physicalRow,
      postedAt: String(at('postedAt')).trim(),
      settlementId: String(at('settlementId')).trim() || null,
      type: String(at('type')).trim(),
      orderId: String(at('orderId')).trim() || null,
      sku: String(at('sku')).trim() || null,
      description: String(at('description')).trim(),
      marketplace: String(at('marketplace')).trim(),
      accountType: String(at('accountType')).trim(),
      fulfillment: String(at('fulfillment')).trim(),
      status: String(at('status')).trim(),
      releaseDate: String(at('releaseDate')).trim() || null,
      ...money
    });
  }
  return { ok: errors.length === 0, errors, header, rows, rawRowCount: grid.length - headerRow - 1 };
}

export const isDeferred = row => !/^released$/i.test(String(row?.status ?? '').trim());
// Amazon writes the channel as "Amazon" for FBA and "Merchant" for seller
// fulfilled, and leaves it blank on rows that belong to neither (transfers,
// service fees, withholding).
export const isFba = row => /^amazon$/i.test(String(row?.fulfillment ?? '').trim());
export const isSellerFulfilled = row => /^merchant$/i.test(String(row?.fulfillment ?? '').trim());

/**
 * Rolls parsed rows up into Amazon's own statement sections, in integer paise.
 *
 * `controlDrift` is the check that makes this trustworthy: Amazon states a
 * Total per row, and the four sections must reconstruct it. On both real
 * reports the drift is exactly 0, so any non-zero value here is a parsing or
 * mapping fault rather than an Amazon quirk - reported, never absorbed.
 * @param {ReturnType<typeof parseUnifiedTransactionReport>['rows']} rows
 */
export function summariseUnifiedStatement(rows) {
  const totals = { income: 0, expenses: 0, gst: 0, transfers: 0 };
  const lines = {
    sellerFulfilledProductSales: 0, fbaProductSales: 0,
    sellerFulfilledProductSaleRefunds: 0, fbaProductSaleRefunds: 0,
    shippingCredits: 0, shippingCreditRefunds: 0,
    promotionalRebates: 0, promotionalRebateRefunds: 0,
    gstCollected: 0, gstRefunds: 0
  };
  const unclassified = new Map();
  let statedTotal = 0;
  for (const row of rows) {
    for (const column of INCOME_COLUMNS) totals.income += row[column];
    for (const column of EXPENSE_COLUMNS) totals.expenses += row[column];
    for (const column of GST_COLUMNS) totals.gst += row[column];
    statedTotal += row.total;
    if (row.other) {
      const { section, known } = sectionForOtherAmount(row);
      totals[section] += row.other;
      if (!known) {
        const key = row.type || '(no type)';
        const seen = unclassified.get(key) ?? { type: key, rowCount: 0, paise: 0, section };
        seen.rowCount += 1; seen.paise += row.other;
        unclassified.set(key, seen);
      }
    }
    const sales = row.productSales;
    if (sales > 0) { if (isFba(row)) lines.fbaProductSales += sales; else lines.sellerFulfilledProductSales += sales; }
    else if (sales < 0) { if (isFba(row)) lines.fbaProductSaleRefunds += sales; else lines.sellerFulfilledProductSaleRefunds += sales; }
    if (row.shippingCredits > 0) lines.shippingCredits += row.shippingCredits; else lines.shippingCreditRefunds += row.shippingCredits;
    if (row.promotionalRebates < 0) lines.promotionalRebates += row.promotionalRebates; else lines.promotionalRebateRefunds += row.promotionalRebates;
    if (row.salesTaxLiable > 0) lines.gstCollected += row.salesTaxLiable; else lines.gstRefunds += row.salesTaxLiable;
  }
  const sectionSum = totals.income + totals.expenses + totals.gst + totals.transfers;
  const rupees = value => Object.fromEntries(Object.entries(value).map(([key, paise]) => [key, paiseToRupees(paise)]));
  return {
    rowCount: rows.length,
    deferredRowCount: rows.filter(isDeferred).length,
    ...rupees(totals),
    // Amazon's statement has a Tax section distinct from GST; on both reconciled
    // accounts every one of its lines was 0, and this report carries no column
    // for it. Stated explicitly rather than silently omitted.
    tax: 0,
    lines: rupees(lines),
    controlDrift: paiseToRupees(sectionSum - statedTotal),
    statedTotal: paiseToRupees(statedTotal),
    unclassified: [...unclassified.values()].map(entry => ({ ...entry, amount: paiseToRupees(entry.paise) }))
  };
}

/**
 * What the report says once the still-deferred rows are removed - the
 * population a settlement report can see. The difference between this and the
 * full statement is exactly what a settlement-only dashboard is short by.
 * @param {ReturnType<typeof parseUnifiedTransactionReport>['rows']} rows
 */
export function splitByRelease(rows) {
  const released = summariseUnifiedStatement(rows.filter(row => !isDeferred(row)));
  const deferred = summariseUnifiedStatement(rows.filter(isDeferred));
  return { released, deferred };
}
