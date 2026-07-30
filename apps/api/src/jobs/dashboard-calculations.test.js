import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDashboardMetrics, inclusiveDays } from './dashboard-calculations.js';
const range={start:'2026-06-27T00:00:00Z',end:'2026-07-27T00:00:00Z'};
const line=(id,description,amount,parent='Order',extra={})=>({settlement_id:'statement',source_row_id:id,amount_description:description,amount,parent_transaction_type:parent,posted_date:'2026-07-10T00:00:00Z',...extra});
function mindcircusFixture(){return{
  orders:[{amazon_order_id:'shipped',status:'Shipped',raw:{history:'was Unshipped and Pending'}},{amazon_order_id:'cancelled',status:'Cancelled'},{amazon_order_id:'replacement',status:'Replacement'}],
  orderItems:[{source_row_id:'db1',amazon_order_id:'shipped',sku:'same',asin:'a',quantity_ordered:2,raw:{orderItemId:'item-1'}},{source_row_id:'db2',amazon_order_id:'shipped',sku:'same',asin:'a',quantity_ordered:3,raw:{orderItemId:'item-2'}}],
  returns:[{source_row_id:'ret1',order_id:'shipped',sku:'same',return_date:'2026-07-12',quantity:2,raw:{eventId:'event-1'}}],
  settlementRows:[
    line('sf-sale','Principal',164084.08,'Order'),line('sf-refund','Principal',-45927.15,'Refund'),line('fba-sale','Principal',49861.08,'Order'),line('fba-refund','Principal',-10996.61,'Refund'),
    line('promo','Promotional rebate',-2955.62),line('promo-refund','Promotional rebate refund',457.02,'Refund'),line('safe','SAFE-T Reimbursement',196.72,'SAFE-T Reimbursement'),line('shipping','Shipping credits',1686.50),
    line('fees','Selling fees',-56358.40,'ServiceFee'),line('fee-refund','Selling fee refunds',7397.65,'ServiceFeeRefund'),line('tds','TCS/TDS withholding',-1469.30,'Withholding'),
    line('gst-collected','Product Tax GST collected',38146.06),line('gst-refund','Product Tax GST refund',-10194.50,'Refund')
  ],
  financeItems:[line('partial','Principal',999,'Order')],
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
test('GST invoice value uses genuine documents, credit notes, mixed rates and stable document keys',()=>{const input=mindcircusFixture();input.gstInvoices=[{source_row_id:'1',taxable_value:100,raw:{'document-number':'INV1','line-item-id':'1','document-type':'Invoice','gst-rate':18}},{source_row_id:'dup',taxable_value:100,raw:{'document-number':'INV1','line-item-id':'1','document-type':'Invoice','gst-rate':18}},{source_row_id:'2',taxable_value:40,raw:{'document-number':'CN1','line-item-id':'1','document-type':'Credit Note','gst-rate':5}},{source_row_id:'synthetic',taxable_value:999,raw:{}}];assert.equal(calculateDashboardMetrics(input,range).metrics.gstValue.value,60);});
test('GST invoice value is unavailable without genuine imported invoices',()=>{const r=calculateDashboardMetrics({...mindcircusFixture(),gstInvoices:[{taxable_value:381909.1,raw:{}}]},range);assert.equal(r.metrics.gstValue.value,null);assert.equal(r.metrics.gstValue.status,'Unavailable');});
test('derives half-open range days and excludes failed/out-of-range deposits',()=>{const input=mindcircusFixture();input.settlementHeaders.push({settlement_id:'outside',deposit_date:'2026-07-27T00:00:00Z',total_amount:1000});const r=calculateDashboardMetrics(input,range);assert.equal(inclusiveDays(range.start,range.end),30);assert.equal(r.metrics.settled.value,131801.69);});

test('reconciles the supplied 21–29 July Amazon statement from component rows',()=>{
  const fixtureRange={start:'2026-07-20T18:30:00.000Z',end:'2026-07-29T18:30:00.000Z'};
  const input={
    orders:[{amazon_order_id:'fixture-order',status:'Shipped',order_date:'2026-07-21T04:30:00.000Z'}],
    orderItems:[],returns:[],coverage:{returnsComplete:false},reimbursements:[],gstInvoices:[],financeItems:[],
    settlementRows:[
      line('small-sale','Principal',567.60,'Order'),
      line('small-refund','Principal',-141.90,'Refund'),
      line('small-other-fee','Other transaction fee',-4.72,'ServiceFee'),
      line('small-service-fee','Service fee',-259.60,'ServiceFee'),
      line('small-tcs','TCS-IGST',-2.13,'Withholding'),
      line('small-fee-refund','Other transaction fee refund',66.08,'ServiceFeeRefund'),
      line('small-gst','Product Tax GST collected',21.30,'Order')
    ],
    settlementHeaders:[{settlement_id:'small-transfer',deposit_date:'2026-07-29T12:00:00.000Z',total_amount:246.63}]
  };
  const result=calculateDashboardMetrics(input,fixtureRange);
  assert.equal(result.diagnostics.categoryTotals.grossSales,567.60);
  assert.equal(result.diagnostics.categoryTotals.productRefunds,141.90);
  assert.equal(result.metrics.netSales.value,425.70);
  assert.equal(result.statement.income.value,425.70);
  assert.equal(result.diagnostics.categoryTotals.expenseDebits,266.45);
  assert.equal(result.diagnostics.categoryTotals.expenseCredits,66.08);
  assert.equal(result.statement.expenses.value,-200.37);
  assert.equal(result.metrics.deductions.value,200.37);
  assert.equal(result.diagnostics.categoryTotals.tcsTds,2.13);
  assert.equal(result.diagnostics.categoryTotals.operationalFees,198.24);
  assert.equal(result.metrics.settled.value,246.63);
  assert.equal(result.metrics.reimbursements.value,0);
  assert.equal(inclusiveDays(fixtureRange.start,fixtureRange.end),9);
  assert.equal(result.metrics.drr.value,47.30);
  assert.equal(Number(result.metrics.feeImpact.value.toFixed(2)),34.93);
  assert.equal(Number(result.metrics.refundValueRate.value.toFixed(2)),25);
  assert.equal(result.statement.tax.value,0);
  assert.equal(result.statement.transfers.value,-246.63);
  assert.equal(result.statement.gst.value,21.30);
  assert.equal(result.metrics.orders.value,1);
  assert.equal(result.metrics.returnRate.value,null);
  assert.match(result.metrics.returnRate.status,/missing Orders API item quantities or GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA coverage/);
  assert.equal(result.metrics.netQty.value,null);
  assert.equal(result.metrics.gstValue.value,null);
  assert.match(result.metrics.gstValue.status,/Unavailable/);
  assert.deepEqual(result.statement.income.rows.map(row=>row.source_row_id),['small-sale','small-refund']);
  assert.deepEqual(result.statement.expenses.rows.map(row=>row.source_row_id),['small-other-fee','small-service-fee','small-tcs','small-fee-refund']);
  assert.deepEqual(result.metrics.netSales.rows.map(row=>row.source_row_id),['small-sale','small-refund']);
  assert.deepEqual(result.metrics.deductions.rows.map(row=>row.source_row_id),['small-other-fee','small-service-fee','small-tcs','small-fee-refund']);
  assert.deepEqual(result.metrics.refundValueRate.rows.map(row=>row.source_row_id),['small-refund','small-sale']);
  assert.deepEqual(result.metrics.settled.rows.map(row=>row.settlement_id),['small-transfer']);
  assert.deepEqual(result.reconciliation,{value:0,balanced:true,formula:'Income + Expenses + Tax + GST + Transfers',components:{income:425.70,expenses:-200.37,tax:0,gst:21.30,transfers:-246.63}});
});

test('reports zero returns only after genuine Returns report coverage is complete',()=>{
  const input=mindcircusFixture();input.returns=[];input.coverage={returnsComplete:false};
  let result=calculateDashboardMetrics(input,range);
  assert.equal(result.metrics.returns.value,null);
  assert.match(result.metrics.returns.status,/GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA/);
  input.coverage.returnsComplete=true;
  result=calculateDashboardMetrics(input,range);
  assert.equal(result.metrics.returns.value,0);
  assert.equal(result.metrics.returnRate.value,0);
});
