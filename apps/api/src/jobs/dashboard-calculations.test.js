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
test('missing return quantity makes quantity KPIs unavailable instead of guessing one',()=>{const input=mindcircusFixture();input.returns[0].quantity=null;const r=calculateDashboardMetrics(input,range);assert.equal(r.metrics.returns.value,null);assert.equal(r.metrics.netQty.value,null);assert.equal(r.metrics.returnRate.value,null);assert.equal(r.metrics.returnRate.status,'Unavailable / source mismatch');});
test('positive returns with unavailable shipped source never report zero percent',()=>{const input=mindcircusFixture();input.orderItems=[];const r=calculateDashboardMetrics(input,range);assert.equal(r.metrics.returnRate.value,null);assert.match(r.metrics.returnRate.status,/source mismatch/);});
test('removes duplicate reports and finance summary rows, and uses one reimbursement source',()=>{const input=mindcircusFixture();input.settlementRows.push({...input.settlementRows[0],source_row_id:'duplicate-db-id'});input.financeItems.push({transaction_id:'x',category:'summary_amazon_fees',amount:-999,posted_date:'2026-07-10'});const r=calculateDashboardMetrics(input,range);assert.equal(r.metrics.netSales.value,154522.8);assert.equal(r.metrics.reimbursements.value,196.72);assert.ok(r.diagnostics.duplicateRows>0);});
test('GST invoice value uses genuine documents, credit notes, mixed rates and stable document keys',()=>{const input=mindcircusFixture();input.gstInvoices=[{source_row_id:'1',taxable_value:100,raw:{'document-number':'INV1','line-item-id':'1','document-type':'Invoice','gst-rate':18}},{source_row_id:'dup',taxable_value:100,raw:{'document-number':'INV1','line-item-id':'1','document-type':'Invoice','gst-rate':18}},{source_row_id:'2',taxable_value:40,raw:{'document-number':'CN1','line-item-id':'1','document-type':'Credit Note','gst-rate':5}},{source_row_id:'synthetic',taxable_value:999,raw:{}}];assert.equal(calculateDashboardMetrics(input,range).metrics.gstValue.value,60);});
test('GST invoice value is unavailable without genuine imported invoices',()=>{const r=calculateDashboardMetrics({...mindcircusFixture(),gstInvoices:[{taxable_value:381909.1,raw:{}}]},range);assert.equal(r.metrics.gstValue.value,null);assert.equal(r.metrics.gstValue.status,'Unavailable');});
test('derives half-open range days and excludes failed/out-of-range deposits',()=>{const input=mindcircusFixture();input.settlementHeaders.push({settlement_id:'outside',deposit_date:'2026-07-27T00:00:00Z',total_amount:1000});const r=calculateDashboardMetrics(input,range);assert.equal(inclusiveDays(range.start,range.end),30);assert.equal(r.metrics.settled.value,131801.69);});

test('matches Amazon Custom Unified Account Activity buckets from settlement API rows',()=>{
  const input={
    orders:[],orderItems:[],returns:[],financeItems:[],reimbursements:[],gstInvoices:[],
    settlementRows:[
      line('sale','Principal',567.60,'Order',{amount_type:'ItemPrice'}),
      line('refund','Principal',-141.90,'Refund',{amount_type:'ItemPrice'}),
      line('easy','Amazon Easy Ship Charges',-4.72,'other-transaction',{amount_type:'other-transaction'}),
      line('service','Service fees',-259.60,'other-transaction',{amount_type:'other-transaction'}),
      line('other-refund','Other transaction fee refunds',66.08,'other-transaction',{amount_type:'other-transaction'}),
      line('tcs','TCS-IGST',-2.13,'Order',{amount_type:'ItemTCS'}),
      line('gst','Product Tax',28.40,'Order',{amount_type:'ItemPrice'}),
      line('gst-refund','Product tax discount',-7.10,'Order',{amount_type:'Promotion'})
    ],
    settlementHeaders:[{settlement_id:'transfer',deposit_date:'2026-07-22T00:00:00Z',total_amount:246.63}]
  };
  const r=calculateDashboardMetrics(input,{start:'2026-07-21T00:00:00Z',end:'2026-07-30T00:00:00Z'});
  assert.equal(r.statement.income.value,425.70);
  assert.equal(r.statement.expenses.value,-200.37);
  assert.equal(r.statement.tax.value,0);
  assert.equal(r.statement.gst.value,21.30);
  assert.equal(r.statement.transfers.value,-246.63);
});


test('uses Amazon settlement header period and date formats for transfers',()=>{
  const base={orders:[],orderItems:[],returns:[],financeItems:[],reimbursements:[],gstInvoices:[],settlementRows:[line('sale','Principal',10,'Order',{amount_type:'ItemPrice'})]};
  const withIndianDeposit=calculateDashboardMetrics({...base,settlementHeaders:[{settlement_id:'dd-mm',deposit_date:'29.07.2026 23:59 GMT+5:30',total_amount:246.63}]},{start:'2026-07-21T00:00:00Z',end:'2026-07-30T00:00:00Z'});
  assert.equal(withIndianDeposit.statement.transfers.value,-246.63);
  const withStatementPeriod=calculateDashboardMetrics({...base,settlementHeaders:[{settlement_id:'period',settlement_start_date:'27.06.2026 00:00:00 UTC',settlement_end_date:'26.07.2026 23:59:59 UTC',total_amount:131801.69}]},{start:'2026-06-27T00:00:00Z',end:'2026-07-27T00:00:00Z'});
  assert.equal(withStatementPeriod.statement.transfers.value,-131801.69);
});

test('treats an order as settled from its settlement lines anywhere, not just in the viewed range',()=>{
  // A settlement line's posted_date is the transaction date, so an order sold
  // near a range boundary very often has its settlement lines land outside
  // the window the user is looking at while its Finance API rows land inside
  // it. Judging "settled" from in-range settlement rows alone then declares
  // such an order pending and merges its Deferred money on top of settlement
  // money that is already counted - real double-counting, invisible per row.
  const base={
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],
    settlementRows:[
      line('in-range-sale','Principal',1000,'Order',{order_id:'order-in-range',amount_type:'ItemPrice'}),
      line('in-range-fee','Commission',-100,'Order',{order_id:'order-in-range',amount_type:'ItemFees'})
    ],
    financeItems:[
      {source_row_id:'f-settled',transaction_id:'tx-settled',order_id:'order-outside-range',transaction_status:'Deferred',category:'item_price',amount_description:'OurPricePrincipal',amount:500,posted_date:'2026-07-10T00:00:00Z',raw:{}},
      {source_row_id:'f-pending',transaction_id:'tx-pending',order_id:'order-never-settled',transaction_status:'Deferred',category:'item_price',amount_description:'OurPricePrincipal',amount:250,posted_date:'2026-07-10T00:00:00Z',raw:{}}
    ]
  };
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  // Without the all-time settled set, the already-settled order is wrongly merged.
  assert.equal(calculateDashboardMetrics(base,range).statement.income.value,1750);
  // With it, only the genuinely never-settled order is added.
  const corrected=calculateDashboardMetrics({...base,settledOrderIdsAllTime:['order-in-range','order-outside-range']},range);
  assert.equal(corrected.statement.income.value,1250);
  assert.equal(corrected.diagnostics.pendingMergeSummary.pendingOrders,1);
  assert.equal(corrected.diagnostics.pendingMergeSummary.pendingAddedTotals.income,250);
  assert.equal(corrected.diagnostics.pendingMergeSummary.settlementBaselineTotals.income,1000);
});

test('flags a pending order whose money arrives via more than one Finance transaction',()=>{
  // Per-row checks cannot see this: both copies classify identically and both
  // pass the Deferred status test, so only a per-order view exposes it.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const financeRow=(id,transactionId,amountValue)=>({source_row_id:id,transaction_id:transactionId,order_id:'order-dup',transaction_status:'Deferred',category:'item_price',amount_description:'OurPricePrincipal',amount:amountValue,posted_date:'2026-07-10T00:00:00Z',raw:{}});
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],
    settlementRows:[line('sale','Principal',100,'Order',{order_id:'order-settled',amount_type:'ItemPrice'})],
    financeItems:[financeRow('a','tx-1',300),financeRow('b','tx-2',300)]
  },range);
  const flagged=r.diagnostics.pendingMergeSummary.ordersWithMultipleTransactions;
  assert.equal(flagged.length,1);
  assert.equal(flagged[0].order_id,'order-dup');
  assert.equal(flagged[0].transactions.length,2);
});
