import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesAmazonTotal, statementBucket, statementPeriod, summariseStatementRows } from './settlement-statements.js';

const row = (amountType, description, amount, parent = 'Order', extra = {}) =>
  ({ amount_type: amountType, amount_description: description, amount, parent_transaction_type: parent, ...extra });

test('the four sections always add up to the payout, whatever the labels are', () => {
  // The guarantee the whole statement view rests on: every non-transfer row
  // lands in exactly one of sales/refunds/expenses/others, so their sum IS
  // the payout by construction rather than by coincidence.
  const rows = [
    row('ItemPrice', 'Principal', 349), row('ItemPrice', 'Tax', 17.45), row('ItemPrice', 'Shipping', 40),
    row('Promotion', 'Principal', -10), row('ItemFees', 'Commission', -35), row('ItemWithheldTax', 'TCS-CGST', -1.2),
    row('ItemPrice', 'Principal', -200, 'Refund'), row('ItemFees', 'RefundCommission', -5, 'Refund'),
    row('other-transaction', 'Storage Fee', -12, 'ServiceFee'), row('', 'SomeLabelNobodyHasSeen', 7, 'Other')
  ];
  const totals = summariseStatementRows(rows);
  const everyRow = rows.reduce((sum, r) => sum + r.amount, 0);
  assert.equal(totals.payout, Math.round((everyRow + Number.EPSILON) * 100) / 100);
  assert.equal(totals.sales + totals.refunds + totals.expenses + totals.others, totals.payout);
});

test('a row no rule recognises lands in Others rather than disappearing', () => {
  // A classifier gap has to be visible in a figure the seller can see, not
  // silently dropped from the payout - that is the failure mode Others exists
  // to make impossible.
  const totals = summariseStatementRows([row('', 'SomeLabelNobodyHasSeen', 42, 'Other')]);
  assert.equal(statementBucket(row('', 'SomeLabelNobodyHasSeen', 42, 'Other')), 'others');
  assert.equal(totals.others, 42);
  assert.equal(totals.payout, 42);
});

test('ItemPrice Tax is GST the buyer paid - Sales, not an Amazon fee', () => {
  // Its bare "Tax" description matches the generic-fee-component rule inside
  // isFee, so a text-first pass put it in Expenses - wrong twice over, since
  // the same money then went missing from Sales.
  assert.equal(statementBucket(row('ItemPrice', 'Tax', 17.45)), 'sales');
  assert.equal(statementBucket(row('ItemFees', 'Commission', -35)), 'expenses');
  assert.equal(statementBucket(row('ItemWithheldTax', 'TCS-CGST', -1.2)), 'expenses');
});

test('a refund is a refund whichever amount_type carries it', () => {
  // Refund is checked before amount_type deliberately: a refunded commission
  // is ItemFees, but it belongs with the refund it reverses, not with the
  // fees Amazon charged this period.
  assert.equal(statementBucket(row('ItemPrice', 'Principal', -200, 'Refund')), 'refunds');
  assert.equal(statementBucket(row('ItemFees', 'RefundCommission', -5, 'Refund')), 'refunds');
});

test('the transfer line is the payout leaving Amazon, not a component of it', () => {
  // Counting it would subtract the payout from itself.
  const totals = summariseStatementRows([row('ItemPrice', 'Principal', 500), row('', 'Transfer to bank account', -500, 'Transfer')]);
  assert.equal(totals.transfer, -500);
  assert.equal(totals.payout, 500);
});

test('period and Amazon total are read whichever spelling the report used', () => {
  const camel = statementPeriod([{ raw: { settlementStartDate: '2026-08-03', settlementEndDate: '2026-08-10', depositDate: '2026-08-12', totalAmount: '4825.94' } }]);
  const hyphen = statementPeriod([{ raw: { 'settlement-start-date': '2026-08-03', 'settlement-end-date': '2026-08-10', 'deposit-date': '2026-08-12', 'total-amount': '4825.94' } }]);
  assert.deepEqual(camel, hyphen);
  assert.equal(hyphen.amazon_total, 4825.94);
});

test('"Amazon stated no total" is reported as unknown, never as a mismatch', () => {
  assert.equal(matchesAmazonTotal(4825.94, 0), null);
  assert.equal(matchesAmazonTotal(4825.94, null), null);
  assert.equal(matchesAmazonTotal(4825.94, 4825.94), true);
  // A paisa of floating-point drift is not a real disagreement.
  assert.equal(matchesAmazonTotal(4825.94, 4825.945), true);
  assert.equal(matchesAmazonTotal(4825.94, 4000), false);
});

test("reproduces Amazon's own All Statements arithmetic for a real period", () => {
  // Seller's own page, 3/8/2026-10/8/2026: Sales 48,529.22, Refunds
  // -25,467.72, Expenses -18,235.56, Others 0, Payout 4,825.94.
  const rows = [
    row('ItemPrice', 'Principal', 48529.22),
    row('ItemPrice', 'Principal', -25467.72, 'Refund'),
    row('ItemFees', 'Commission', -18235.56)
  ];
  const totals = summariseStatementRows(rows);
  assert.equal(totals.sales, 48529.22);
  assert.equal(totals.refunds, -25467.72);
  assert.equal(totals.expenses, -18235.56);
  assert.equal(totals.others, 0);
  assert.equal(totals.payout, 4825.94);
  assert.equal(matchesAmazonTotal(totals.payout, 4825.94), true);
});
