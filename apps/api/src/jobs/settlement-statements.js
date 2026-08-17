// Amazon's own "All Statements" view, rebuilt from stored settlement rows.
//
// This lives in its own module rather than inside the route that serves it
// because it is money classification, and money classification is the part of
// this codebase that has been wrong before and has to be testable in
// isolation - importing server.js to check a bucket would drag in Fastify, a
// database pool and the whole SP-API client.
import { isFee, isPrincipal, isProductGst, isPromotion, isRefund, isReimbursement, isShippingOrGiftWrapCredit, isTransfer, isWithholding } from './dashboard-calculations.js';

export const round2 = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// amount_type is read BEFORE the text classifiers, because on a settlement row
// it is the unambiguous signal and the description text is not. Amazon's flat
// file says ItemPrice for everything the buyer paid (principal, the GST on it,
// shipping, gift wrap) and ItemFees for everything Amazon charged, so the
// bucket is decided without interpreting a label at all.
//
// Measured why this matters: a real row of ItemPrice / "Tax" is GST the buyer
// paid and belongs in Sales, but its bare "Tax" description matches the
// generic-fee-component rule inside isFee, so a text-first pass put it in
// Expenses - wrong on both sides at once, since the same money then goes
// missing from Sales. The text classifiers still handle every row carrying no
// recognised amount_type (service fees, reimbursements, TDS, adjustments),
// which is what they were written against.
const SETTLEMENT_AMOUNT_TYPE_BUCKETS = Object.freeze({
  itemprice: 'sales', promotion: 'sales', itemfees: 'expenses', itemwithheldtax: 'expenses'
});
export function statementBucket(row) {
  if (isTransfer(row)) return 'transfer';
  if (isRefund(row)) return 'refunds';
  const amountType = String(row.amount_type ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  const byAmountType = SETTLEMENT_AMOUNT_TYPE_BUCKETS[amountType];
  if (byAmountType) return byAmountType;
  if (isFee(row) || isWithholding(row)) return 'expenses';
  if (isPrincipal(row) || isPromotion(row) || isShippingOrGiftWrapCredit(row) || isProductGst(row) || isReimbursement(row)) return 'sales';
  return 'others';
}

// Others is a RESIDUAL, not a category: whatever no rule claimed lands there.
// That is what makes the arithmetic provable rather than approximate - sales +
// refunds + expenses + others is every non-transfer row exactly once, so it
// always equals the payout, and a classifier gap surfaces as a visible Others
// figure instead of silently vanishing from the total.
//
// Verified against Amazon's own All Statements page for a real seller:
// 48,529.22 - 25,467.72 - 18,235.56 + 0 = 4,825.94, its stated payout for
// that period, to the paisa.
export function summariseStatementRows(rows) {
  const totals = { sales: 0, refunds: 0, expenses: 0, others: 0, transfer: 0 };
  for (const row of rows ?? []) totals[statementBucket(row)] += Number(row.amount ?? 0);
  for (const key of Object.keys(totals)) totals[key] = round2(totals[key]);
  // The transfer line is the payout leaving Amazon, not another component of
  // it - counting it here would subtract the payout from itself.
  return { ...totals, payout: round2(totals.sales + totals.refunds + totals.expenses + totals.others) };
}

// Amazon spells the same settlement field several ways across report versions
// ('deposit-date', 'deposit date', 'depositDate'), so every read tries each
// spelling rather than assuming one.
const statementField = (raw, names) => {
  for (const name of names) { const value = raw?.[name]; if (value !== undefined && value !== null && value !== '') return value; }
  return null;
};
export function statementPeriod(rows) {
  const field = names => { for (const row of rows ?? []) { const value = statementField(row.raw, names); if (value) return value; } return null; };
  return {
    period_start: field(['settlement-start-date', 'settlement start date', 'settlementStartDate']),
    period_end: field(['settlement-end-date', 'settlement end date', 'settlementEndDate']),
    deposit_date: field(['deposit-date', 'deposit date', 'depositDate']),
    amazon_total: Number(field(['total-amount', 'total amount', 'totalAmount']) ?? 0)
  };
}

// Amazon stamps its own total on the document. Reporting ours beside it, and
// whether they agree, is the difference between "here is a number" and "here is
// a number Amazon confirms" - and it is how a half-downloaded settlement
// announces itself instead of quietly producing a wrong payout. Null, not
// false, when Amazon stated no total: "cannot be checked" is not "does not
// match".
export function matchesAmazonTotal(payout, amazonTotal) {
  if (!amazonTotal) return null;
  return Math.abs(round2(payout - amazonTotal)) <= 0.01;
}
