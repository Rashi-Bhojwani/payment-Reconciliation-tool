import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDashboardMetrics, inclusiveDays } from './dashboard-calculations.js';
const range={start:'2026-06-27T00:00:00Z',end:'2026-07-27T00:00:00Z'};
const line=(id,description,amount,parent='Order',extra={})=>({settlement_id:'statement',source_row_id:id,amount_description:description,amount,parent_transaction_type:parent,posted_date:'2026-07-10T00:00:00Z',...extra});
function mindcircusFixture(){return{
  orders:[{amazon_order_id:'shipped',status:'Shipped',fulfillment_channel:'AFN',raw:{history:'was Unshipped and Pending'}},{amazon_order_id:'cancelled',status:'Cancelled',fulfillment_channel:'AFN'},{amazon_order_id:'replacement',status:'Replacement',fulfillment_channel:'AFN'}],
  orderItems:[{source_row_id:'db1',amazon_order_id:'shipped',sku:'same',asin:'a',quantity_ordered:2,raw:{orderItemId:'item-1'}},{source_row_id:'db2',amazon_order_id:'shipped',sku:'same',asin:'a',quantity_ordered:3,raw:{orderItemId:'item-2'}}],
  returns:[{source_row_id:'ret1',order_id:'shipped',sku:'same',return_date:'2026-07-12',quantity:2,raw:{eventId:'event-1'}}],
  settlementRows:[
    line('sf-sale','Principal',164084.08,'Order'),line('sf-refund','Principal',-45927.15,'Refund'),line('fba-sale','Principal',49861.08,'Order'),line('fba-refund','Principal',-10996.61,'Refund'),
    line('promo','Promotional rebate',-2955.62),line('promo-refund','Promotional rebate refund',457.02,'Refund'),line('safe','SAFE-T Reimbursement',196.72,'SAFE-T Reimbursement'),line('shipping','Shipping credits',1686.50),
    line('fees','Selling fees',-56358.40,'ServiceFee'),line('fee-refund','Selling fee refunds',7397.65,'ServiceFeeRefund'),line('tds','TCS/TDS withholding',-1469.30,'Withholding'),
    line('gst-collected','Product Tax GST collected',38146.06),line('gst-refund','Product Tax GST refund',-10194.50,'Refund')
  ],
  financeItems:[line('partial','Principal',999,'Order')],
  coverage:{settlementsComplete:true,returnsComplete:true,ordersComplete:true,financeComplete:true,gstB2bComplete:false,gstB2cComplete:false},
  settlementHeaders:[{settlement_id:'transfer',deposit_date:'2026-07-20T00:00:00Z',total_amount:131801.69},{settlement_id:'failed',deposit_date:'2026-07-21T00:00:00Z',total_amount:500,transaction_type:'Failed transfer'}],
  reimbursements:[{sku:'duplicate-fallback',amount:999,reimbursement_date:'2026-07-10'}]
};}
test('matches the MINDCIRCUS Amazon Account Activity fixture without constants',()=>{
  const r=calculateDashboardMetrics(mindcircusFixture(),range);
  assert.equal(r.metrics.netSales.value,154522.8);assert.equal(r.statement.income.value,156406.02);
  assert.equal(r.metrics.deductions.value,50430.05);assert.equal(r.metrics.deductions.components.find(x=>x.category==='tcs_tds').amount,1469.3);assert.equal(r.metrics.deductions.components.find(x=>x.category==='operational_fees').amount,48960.75);
  assert.equal(r.metrics.reimbursements.value,196.72);assert.equal(r.statement.tax.value,0);assert.equal(r.statement.gst.value,27951.56);
  assert.equal(r.metrics.settled.value,131801.69);assert.equal(r.statement.transfers.value,-131801.69);assert.equal(r.statement.expenses.value,-50430.05);
  assert.equal(r.metrics.drr.value,5150.76);assert.equal(Number(r.metrics.feeImpact.value.toFixed(2)),22.88);assert.equal(Number(r.metrics.refundValueRate.value.toFixed(2)),26.61);
  assert.equal(r.diagnostics.sourcePolicy.financial.startsWith('Amazon Settlement report'),true);
});
test('uses current status only and preserves identical-SKU lines with stable item IDs',()=>{const r=calculateDashboardMetrics(mindcircusFixture(),range);assert.equal(r.metrics.netQty.value,3);assert.equal(r.metrics.orders.value,1);assert.equal(r.metrics.returnRate.value,40);});
test('negative Principal is a refund through parent transaction metadata',()=>{const input=mindcircusFixture();const refund=input.settlementRows.find(x=>x.source_row_id==='sf-refund');delete refund.transaction_type;assert.equal(calculateDashboardMetrics(input,range).metrics.netSales.value,154522.8);});
test('missing return quantity makes quantity KPIs unavailable instead of guessing one',()=>{const input=mindcircusFixture();input.returns[0].quantity=null;const r=calculateDashboardMetrics(input,range);assert.equal(r.metrics.returns.value,null);assert.equal(r.metrics.netQty.value,null);assert.equal(r.metrics.returnRate.value,null);assert.match(r.metrics.returnRate.status,/source mismatch/);});
test('positive returns with unavailable shipped source never report zero percent',()=>{const input=mindcircusFixture();input.orderItems=[];const r=calculateDashboardMetrics(input,range);assert.equal(r.metrics.returnRate.value,null);assert.match(r.metrics.returnRate.status,/source mismatch/);});
test('removes duplicate reports and finance summary rows, and uses one reimbursement source',()=>{const input=mindcircusFixture();input.settlementRows.push({...input.settlementRows[0],source_row_id:'duplicate-db-id'});input.financeItems.push({transaction_id:'x',category:'summary_amazon_fees',amount:-999,posted_date:'2026-07-10'});const r=calculateDashboardMetrics(input,range);assert.equal(r.metrics.netSales.value,154522.8);assert.equal(r.metrics.reimbursements.value,196.72);assert.ok(r.diagnostics.duplicateRows>0);});
test('GST invoice value uses genuine documents, credit notes, mixed rates and stable document keys',()=>{const input=mindcircusFixture();input.coverage.gstB2bComplete=true;input.coverage.gstB2cComplete=true;input.gstInvoices=[{source_row_id:'1',taxable_value:100,raw:{'document-number':'INV1','line-item-id':'1','document-type':'Invoice','gst-rate':18}},{source_row_id:'dup',taxable_value:100,raw:{'document-number':'INV1','line-item-id':'1','document-type':'Invoice','gst-rate':18}},{source_row_id:'2',taxable_value:40,raw:{'document-number':'CN1','line-item-id':'1','document-type':'Credit Note','gst-rate':5}},{source_row_id:'synthetic',taxable_value:999,raw:{}}];assert.equal(calculateDashboardMetrics(input,range).metrics.gstValue.value,60);});
test('GST invoice value is unavailable without genuine imported invoices',()=>{const r=calculateDashboardMetrics({...mindcircusFixture(),gstInvoices:[{taxable_value:381909.1,raw:{}}]},range);assert.equal(r.metrics.gstValue.value,null);assert.equal(r.metrics.gstValue.status,'Unavailable');});
test('derives half-open range days and excludes failed/out-of-range deposits',()=>{const input=mindcircusFixture();input.settlementHeaders.push({settlement_id:'outside',deposit_date:'2026-07-27T00:00:00Z',total_amount:1000});const r=calculateDashboardMetrics(input,range);assert.equal(inclusiveDays(range.start,range.end),30);assert.equal(r.metrics.settled.value,131801.69);});
test('preserves negative settlement totals as bank debits',()=>{const input=mindcircusFixture();input.settlementHeaders.push({settlement_id:'debit',deposit_date:'2026-07-22T00:00:00Z',total_amount:-100});const r=calculateDashboardMetrics(input,range);assert.equal(r.metrics.settled.value,131701.69);assert.equal(r.statement.transfers.value,-131701.69);});

function wellsureFixture(returnsComplete = false) {
  const postedDate = '2026-07-21T12:00:00Z';
  const financeLine = (transactionId, description, value, category = 'other', parent = 'Order Payment') => ({
    transaction_id: transactionId,
    order_id: 'order-1',
    amount_description: description,
    amount: value,
    category,
    parent_transaction_type: parent,
    posted_date: postedDate
  });
  const currency = currencyAmount => ({ currencyAmount, currencyCode: 'INR' });
  const breakdown = (breakdownType, value, breakdowns = []) => ({
    breakdownType,
    breakdownAmount: currency(value),
    breakdowns
  });
  const sale = {
    transactionId: 'sale',
    transactionType: 'Shipment',
    description: 'Order Payment',
    postedDate,
    relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-1' }],
    sellingPartnerMetadata: { accountType: 'Standard Orders' },
    breakdowns: [
      breakdown('Sales', 567.60, [
        breakdown('Product Charges', 567.60, [breakdown('Principal', 567.60)])
      ]),
      breakdown('Expenses', -266.45, [
        breakdown('Marketplace operating cost', -263.50),
        breakdown('TCS/TDS withholding', -2.95)
      ]),
      breakdown('Goods and Services Tax', 28.40)
    ]
  };
  const refund = {
    transactionId: 'refund',
    transactionType: 'Refund',
    description: 'Refund Order',
    postedDate: '2026-07-22T12:00:00Z',
    relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-1' }],
    sellingPartnerMetadata: { accountType: 'Standard Orders' },
    breakdowns: [
      breakdown('Refunds', -82.92, [
        breakdown('Product Charges', -141.90, [breakdown('Principal', -141.90)]),
        breakdown('Expenses', 66.08, [
          breakdown('Marketplace operating cost refund', 65.26),
          breakdown('TCS/TDS withholding refund', 0.82)
        ]),
        breakdown('Goods and Services Tax', -7.10)
      ])
    ]
  };

  return {
    orders: [{ amazon_order_id: 'order-1', status: 'Shipped', fulfillment_channel: 'AFN', order_date: postedDate }],
    orderItems: [],
    returns: [],
    coverage: { returnsComplete, ordersComplete: true, financeComplete: true, gstB2bComplete: false, gstB2cComplete: false },
    financeItems: [
      financeLine('sale', 'Principal', 567.60, 'item_price'),
      financeLine('sale', 'Marketplace operating cost', -263.50),
      financeLine('sale', 'TCS/TDS withholding', -2.95),
      financeLine('sale', 'Product Tax', 28.40, 'tax'),
      financeLine('refund', 'Principal', -141.90, 'item_price', 'Refund Order'),
      financeLine('refund', 'Marketplace operating cost refund', 65.26, 'other', 'Refund Order'),
      financeLine('refund', 'TCS/TDS withholding refund', 0.82, 'other', 'Refund Order'),
      financeLine('refund', 'Product Tax GST refund', -7.10, 'tax', 'Refund Order')
    ],
    financeTransactions: [
      { transaction_id: 'sale', transaction_type: 'Shipment', posted_date: postedDate, raw: sale },
      { transaction_id: 'refund', transaction_type: 'Refund', posted_date: refund.postedDate, raw: refund }
    ],
    settlementRows: [],
    settlementHeaders: [{
      settlement_id: 'transfer',
      deposit_date: '2026-07-29T12:00:00Z',
      total_amount: 246.63
    }],
    reimbursements: [],
    gstInvoices: [],
    marketplaceTimeZone: 'Asia/Kolkata'
  };
}

test('matches the WELLSURE reconciliation values from Finances breakdown sections', () => {
  const selectedRange = {
    start: '2026-07-20T18:30:00.000Z',
    end: '2026-07-29T18:30:00.000Z'
  };
  const result = calculateDashboardMetrics(wellsureFixture(false), selectedRange);

  assert.equal(result.metrics.netSales.value, 425.70);
  assert.equal(result.metrics.netQty.value, null);
  assert.equal(result.metrics.orders.value, 1);
  assert.equal(result.metrics.returns.value, null);
  assert.equal(result.metrics.settled.value, 246.63);
  assert.equal(result.metrics.deductions.value, 200.37);
  assert.equal(result.metrics.reimbursements.value, 0);
  assert.equal(result.metrics.drr.value, 47.30);
  assert.equal(Number(result.metrics.feeImpact.value.toFixed(2)), 34.93);
  assert.equal(result.metrics.returnRate.value, null);
  assert.equal(Number(result.metrics.refundValueRate.value.toFixed(2)), 25);
  assert.equal(result.metrics.gstValue.value, null);
  assert.equal(result.statement.income.value, 425.70);
  assert.equal(result.statement.expenses.value, -200.37);
  assert.equal(result.statement.tax.value, 0);
  assert.equal(result.statement.transfers.value, -246.63);
  assert.equal(result.statement.gst.value, 21.30);
  assert.equal(result.reconciliation.value, 0);
  assert.equal(result.reconciliation.balanced, true);
  assert.equal(result.diagnostics.categoryTotals.tcsTds, 2.13);
  assert.equal(result.diagnostics.categoryTotals.operationalFees, 198.24);
});

test('reports zero returns only when the selected range has completed Returns-report coverage', () => {
  const selectedRange = {
    start: '2026-07-20T18:30:00.000Z',
    end: '2026-07-29T18:30:00.000Z'
  };
  const withoutCoverage = calculateDashboardMetrics(wellsureFixture(false), selectedRange);
  const withCoverage = calculateDashboardMetrics(wellsureFixture(true), selectedRange);
  assert.equal(withoutCoverage.metrics.returns.value, null);
  assert.equal(withCoverage.metrics.returns.value, 0);
  assert.equal(withCoverage.metrics.returnRate.value, null);
});

test('keeps fallback rows from legacy transactions alongside parsed breakdown sections', () => {
  const selectedRange = {
    start: '2026-07-20T18:30:00.000Z',
    end: '2026-07-29T18:30:00.000Z'
  };
  const input = wellsureFixture(false);
  input.financeItems.push({
    transaction_id: 'legacy-reimbursement',
    amount_description: 'SAFE-T Reimbursement',
    category: 'reimbursement',
    amount: 10,
    posted_date: '2026-07-23T12:00:00Z'
  });
  input.financeTransactions.push({
    transaction_id: 'legacy-reimbursement',
    transaction_type: 'Reimbursement',
    posted_date: '2026-07-23T12:00:00Z',
    raw: {
      transactionId: 'legacy-reimbursement',
      transactionType: 'Reimbursement',
      description: 'SAFE-T Reimbursement',
      postedDate: '2026-07-23T12:00:00Z',
      totalAmount: { currencyAmount: 10, currencyCode: 'INR' }
    }
  });

  const result = calculateDashboardMetrics(input, selectedRange);
  assert.equal(result.metrics.reimbursements.value, 10);
  assert.equal(result.statement.income.value, 435.70);
});

test('excludes deferred Finances transactions until Amazon releases them', () => {
  const input = wellsureFixture(false);
  input.financeItems.push({
    transaction_id: 'deferred',
    transaction_status: 'DEFERRED',
    order_id: 'order-1',
    amount_description: 'Principal',
    category: 'item_price',
    amount: 999,
    posted_date: '2026-07-23T12:00:00Z'
  });
  input.financeTransactions.push({
    transaction_id: 'deferred',
    transaction_status: 'DEFERRED',
    transaction_type: 'Shipment',
    posted_date: '2026-07-23T12:00:00Z',
    raw: {
      transactionId: 'deferred',
      transactionStatus: 'DEFERRED',
      transactionType: 'Shipment',
      description: 'Order Payment',
      postedDate: '2026-07-23T12:00:00Z',
      breakdowns: [{ breakdownType: 'Sales', breakdownAmount: { currencyAmount: 999, currencyCode: 'INR' } }]
    }
  });
  assert.equal(calculateDashboardMetrics(input, {
    start: '2026-07-20T18:30:00.000Z',
    end: '2026-07-29T18:30:00.000Z'
  }).metrics.netSales.value, 425.70);
});

test('uses completed Sales and Traffic quantities instead of mixing FBA returns with FBM orders', () => {
  const input = wellsureFixture(false);
  input.orders.push({
    amazon_order_id: 'fbm-order',
    status: 'Shipped',
    fulfillment_channel: 'MFN',
    order_date: '2026-07-21T12:00:00Z'
  });
  input.salesTrafficDaily = [{
    date: '2026-07-21',
    units_ordered: 10,
    units_refunded: 2
  }];
  input.coverage.salesTrafficComplete = true;
  const result = calculateDashboardMetrics(input, {
    start: '2026-07-20T18:30:00.000Z',
    end: '2026-07-29T18:30:00.000Z'
  });
  assert.equal(result.metrics.netQty.value, 8);
  assert.equal(result.metrics.returns.value, 2);
  assert.equal(result.metrics.returnRate.value, 20);
  assert.match(result.metrics.netQty.source, /SALES_AND_TRAFFIC/);
});

test('does not publish plausible totals from an incompletely paginated direct sync', () => {
  const input = wellsureFixture(true);
  input.coverage.ordersComplete = false;
  input.coverage.financeComplete = false;
  input.coverage.settlementsComplete = false;
  const result = calculateDashboardMetrics(input, {
    start: '2026-07-20T18:30:00.000Z',
    end: '2026-07-29T18:30:00.000Z'
  });
  assert.equal(result.metrics.orders.value, null);
  assert.equal(result.metrics.netSales.value, null);
  assert.equal(result.metrics.deductions.value, null);
  assert.equal(result.metrics.drr.value, null);
  assert.equal(result.statement.income.value, null);
  assert.match(result.metrics.netSales.status, /complete/);
});
