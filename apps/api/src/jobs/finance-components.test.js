import test from 'node:test';
import assert from 'node:assert/strict';
import { categorizeFinanceLabel, extractFinanceSectionRows, flattenFinanceTransaction } from './finance-components.js';
import { computeSlabFees, computeWeightFee, FASHION_JEWELLERY_SLAB } from '../config/fee-slabs.js';

test('categorizes Amazon fee labels', () => {
  assert.equal(categorizeFinanceLabel('FBAPerUnitFulfillmentFee'), 'fulfillment_fee_per_unit');
  assert.equal(categorizeFinanceLabel('FBAWeightBasedFee'), 'fulfillment_fee_weight');
  assert.equal(categorizeFinanceLabel('Commission'), 'referral_commission');
  assert.equal(categorizeFinanceLabel('FixedClosingFee'), 'closing_fee');
});

test('flattens item breakdowns and resolves array identifiers', () => {
  const rows = flattenFinanceTransaction({ transactionId:'tx-1', postedDate:'2026-01-01T00:00:00Z', relatedIdentifiers:[{relatedIdentifierName:'ORDER_ID',relatedIdentifierValue:'order-1'}], items:[{productDetails:{sku:'sku-1',asin:'asin-1'},breakdown:[{description:'Principal',amount:{currencyAmount:500,currencyCode:'INR'}},{description:'Commission',amount:{currencyAmount:-50,currencyCode:'INR'}}]}] });
  assert.deepEqual(rows.map(row=>[row.orderId,row.sku,row.category,row.amount]),[['order-1','sku-1','item_price',500],['order-1','sku-1','referral_commission',-50]]);
});

test('supports 2024 transaction-level plural breakdowns and contexts', () => {
  const rows = flattenFinanceTransaction({ transactionId:'tx-2', relatedIdentifiers:[{relatedIdentifierName:'ORDER_ID',relatedIdentifierValue:'order-2'}], contexts:[{sku:'sku-2',asin:'asin-2'}], breakdowns:[{breakdownType:'FBAWeightBasedFee',breakdownAmount:{currencyAmount:-75,currencyCode:'INR'}}] });
  assert.deepEqual(rows.map(row=>[row.orderId,row.sku,row.category,row.amount]),[['order-2','sku-2','fulfillment_fee_weight',-75]]);
});

test('supports the official 2024 item contexts, Principle label, and account section hierarchy', () => {
  const transaction = {
    transactionId: 'tx-official',
    relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-official' }],
    transactionType: 'Shipment',
    description: 'Order Payment',
    postedDate: '2026-07-21T00:00:00Z',
    items: [{
      contexts: [{ contextType: 'ProductContext', sku: 'sku-official', asin: 'asin-official' }],
      breakdowns: [{
        breakdownType: 'Product Charges',
        breakdownAmount: { currencyAmount: 100 },
        breakdowns: [{ breakdownType: 'Principle', breakdownAmount: { currencyAmount: 100 } }]
      }]
    }],
    breakdowns: [
      {
        breakdownType: 'Sales',
        breakdownAmount: { currencyAmount: 100 },
        breakdowns: [{
          breakdownType: 'Product Charges',
          breakdownAmount: { currencyAmount: 100 },
          breakdowns: [{ breakdownType: 'Principle', breakdownAmount: { currencyAmount: 100 } }]
        }]
      },
      {
        breakdownType: 'Expenses',
        breakdownAmount: { currencyAmount: -20 },
        breakdowns: [{ breakdownType: 'Marketplace operating cost', breakdownAmount: { currencyAmount: -20 } }]
      }
    ]
  };

  const itemRows = flattenFinanceTransaction(transaction);
  const principal = itemRows.find(row => row.category === 'item_price');
  assert.deepEqual(
    [principal.orderId, principal.sku, principal.asin, principal.amount],
    ['order-official', 'sku-official', 'asin-official', 100]
  );
  assert.equal(itemRows.find(row => row.category === 'summary_income').amount, 100);
  assert.equal(itemRows.find(row => row.category === 'summary_expenses').amount, -20);

  const sectionRows = extractFinanceSectionRows([{ transaction_id: 'tx-official', raw: transaction }]);
  assert.equal(sectionRows.filter(row => row.account_section === 'income').reduce((sum, row) => sum + row.amount, 0), 100);
  assert.equal(sectionRows.filter(row => row.account_section === 'expenses').reduce((sum, row) => sum + row.amount, 0), -20);
});

test('does not double-count parent totals that contain child breakdowns', () => {
  const rows = flattenFinanceTransaction({ transactionId:'tx-3', relatedIdentifiers:{orderId:'order-3'}, breakdowns:[{breakdownType:'AmazonFees',breakdownAmount:{currencyAmount:-115.64},breakdowns:[{breakdownType:'FBAPerUnitFulfillmentFee',breakdownAmount:{currencyAmount:-84}},{breakdownType:'Commission',breakdownAmount:{currencyAmount:-31.64}}]}] });
  assert.equal(rows.find(row=>row.category==='summary_amazon_fees').amount,-115.64);
  assert.equal(rows.filter(row=>!row.category.startsWith('summary_')).reduce((sum,row)=>sum+row.amount,0),-115.64);
  assert.equal(rows.length,3);
});

test('preserves Seller Central Transaction View column summaries exactly', () => {
  const rows = flattenFinanceTransaction({ transactionId:'tx-4', relatedIdentifiers:{orderId:'order-4'}, breakdowns:[
    {breakdownType:'ProductCharges',breakdownAmount:{currencyAmount:583.90},breakdowns:[{breakdownType:'Principal',breakdownAmount:{currencyAmount:583.90}}]},
    {breakdownType:'PromotionalRebates',breakdownAmount:{currencyAmount:0},breakdowns:[{breakdownType:'Promotion',breakdownAmount:{currencyAmount:0}}]},
    {breakdownType:'AmazonFees',breakdownAmount:{currencyAmount:-115.64},breakdowns:[{breakdownType:'FulfillmentFee',breakdownAmount:{currencyAmount:-84}},{breakdownType:'ClosingFee',breakdownAmount:{currencyAmount:-31.64}}]},
    {breakdownType:'Other',breakdownAmount:{currencyAmount:101.59},breakdowns:[{breakdownType:'Tax',breakdownAmount:{currencyAmount:101.59}}]}
  ] });
  const summaries=Object.fromEntries(rows.filter(row=>row.category.startsWith('summary_')).map(row=>[row.category,row.amount]));
  assert.deepEqual(summaries,{summary_product_charges:583.9,summary_promotional_rebates:0,summary_amazon_fees:-115.64,summary_other:101.59});
  assert.equal(Object.values(summaries).reduce((sum,value)=>sum+value,0),569.85);
});

test('computes seller-provided jewellery slabs', () => {
  assert.deepEqual(computeSlabFees(FASHION_JEWELLERY_SLAB, 1200), { referralFee:270, closingFee:76 });
  assert.equal(computeWeightFee(0.5),55); assert.equal(computeWeightFee(3),146); assert.equal(computeWeightFee(6),232);
});