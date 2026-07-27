import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatement, statementSection } from './statement-summary.js';

test('matches Amazon India statement section semantics', () => {
  assert.equal(statementSection({ description: 'GST Refunds' }), 'Goods and Services Tax');
  assert.equal(statementSection({ amount_field: 'TCS-SGST' }), 'Expenses');
  assert.equal(statementSection({ description: 'Transfers to bank account' }), 'Transfers');
  assert.equal(statementSection({ amount_field: 'Product, shipping and gift wrap taxes' }), 'Tax');
});

test('retains debit and credit columns and includes zero-valued Amazon lines', () => {
  const result = buildStatement([
    { transaction_type: 'Order', description: 'FBA product sales', amount: 100, source_lines: 2 },
    { transaction_type: 'Refund', description: 'FBA product sales', amount: -20, source_lines: 1 },
    { description: 'GST Collected', amount: 18, source_lines: 1 },
    { description: 'Transfers to bank account', amount: -98, source_lines: 1 }
  ]);
  const sales = result.details.find(row => row.label === 'FBA product sales');
  assert.deepEqual({ debits: sales.debits, credits: sales.credits, net: sales.net }, { debits: -20, credits: 100, net: 80 });
  assert.ok(result.details.some(row => row.label === 'SAFE-T Reimbursements' && row.net === 0));
  assert.equal(result.summaries.reduce((sum, row) => sum + row.total, 0), 0);
});
