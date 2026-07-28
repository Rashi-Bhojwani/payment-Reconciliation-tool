import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatement, classifyTransaction, flattenBreakdowns, STATEMENT_CONFIG } from './statement-summary.js';

function transaction(transactionType, description, amount, breakdownType = 'PRINCIPAL') {
  return { transactionType, description, breakdown: [{ breakdownType, breakdownAmount: { currencyCode: 'INR', currencyAmount: amount } }] };
}

test('recursively parses nested GST/TCS/TDS breakdown leaves without double counting parents', () => {
  const parts = flattenBreakdowns({ breakdown: [{ breakdownType: 'FEE', breakdownAmount: { currencyAmount: -30 }, breakdown: [
    { breakdownType: 'TCS-SGST', breakdownAmount: { currencyAmount: -10 } },
    { breakdownType: 'TDS_194-O', breakdown: [{ breakdownType: 'TAX', breakdownAmount: { currencyAmount: -20 } }] }
  ] }] });
  assert.deepEqual(parts, [{ breakdownType: 'FEE > TCS-SGST', amount: -10 }, { breakdownType: 'FEE > TDS_194-O > TAX', amount: -20 }]);
});

test('classifies listTransactions components using centralized config', () => {
  assert.deepEqual(classifyTransaction(transaction('Refund', 'FBA customer refund', -250))[0], { section: 'Income', label: 'FBA product sale refunds', amount: -250, breakdownType: 'PRINCIPAL' });
  assert.equal(classifyTransaction(transaction('ServiceFee', 'monthly service fee', -499, 'FEE'))[0].label, 'Service fees');
  assert.equal(classifyTransaction(transaction('TaxWithholding', '', -62.9, 'TCS-SGST'))[0].label, 'TCS-SGST Net');
});

test('keeps every configured row visible and derives debit, credit and section totals', () => {
  const result = buildStatement([transaction('Shipment', 'FBA order', 1000), transaction('Refund', 'FBA customer refund', -200)]);
  assert.equal(result.details.length, STATEMENT_CONFIG.reduce((sum, section) => sum + section.lines.length, 0));
  const sales = result.details.find(row => row.label === 'FBA product sales');
  const refunds = result.details.find(row => row.label === 'FBA product sale refunds');
  assert.equal(sales.credits, 1000); assert.equal(refunds.debits, -200);
  assert.ok(result.details.some(row => row.label === 'NetCo Transaction' && row.net === 0 && row.todo));
  assert.equal(result.summaries.find(row => row.section === 'Income').total, 800);
  assert.equal(result.reconciliation.componentTotal, 800);
});
