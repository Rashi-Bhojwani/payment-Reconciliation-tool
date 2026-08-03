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
test('missing return quantity makes quantity KPIs unavailable instead of guessing one',()=>{const input=mindcircusFixture();input.returns[0].quantity=null;const r=calculateDashboardMetrics(input,range);assert.equal(r.metrics.returns.value,null);assert.equal(r.metrics.netQty.value,null);assert.equal(r.metrics.returnRate.value,null);assert.match(r.metrics.returnRate.status,/^Unavailable\b/);});
test('positive returns with unavailable shipped source never report zero percent',()=>{const input=mindcircusFixture();input.orderItems=[];const r=calculateDashboardMetrics(input,range);assert.equal(r.metrics.returnRate.value,null);assert.match(r.metrics.returnRate.status,/^Unavailable\b/);});
test('removes duplicate reports and finance summary rows, and uses one reimbursement source',()=>{const input=mindcircusFixture();input.settlementRows.push({...input.settlementRows[0],source_row_id:'duplicate-db-id'});input.financeItems.push({transaction_id:'x',category:'summary_amazon_fees',amount:-999,posted_date:'2026-07-10'});const r=calculateDashboardMetrics(input,range);assert.equal(r.metrics.netSales.value,154522.8);assert.equal(r.metrics.reimbursements.value,196.72);assert.ok(r.diagnostics.duplicateRows>0);});
test('GST invoice value uses genuine documents, credit notes, mixed rates and stable document keys',()=>{const input=mindcircusFixture();input.gstInvoices=[{source_row_id:'1',taxable_value:100,raw:{'document-number':'INV1','line-item-id':'1','document-type':'Invoice','gst-rate':18}},{source_row_id:'dup',taxable_value:100,raw:{'document-number':'INV1','line-item-id':'1','document-type':'Invoice','gst-rate':18}},{source_row_id:'2',taxable_value:40,raw:{'document-number':'CN1','line-item-id':'1','document-type':'Credit Note','gst-rate':5}},{source_row_id:'synthetic',taxable_value:999,raw:{}}];assert.equal(calculateDashboardMetrics(input,range).metrics.gstValue.value,60);});
test('GST invoice value is unavailable without genuine imported invoices',()=>{const r=calculateDashboardMetrics({...mindcircusFixture(),gstInvoices:[{taxable_value:381909.1,raw:{}}]},range);assert.equal(r.metrics.gstValue.value,null);assert.match(r.metrics.gstValue.status,/^Unavailable\b/);});
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


test('transfers count the deposit, in Amazon\'s own date format',()=>{
  const base={orders:[],orderItems:[],returns:[],financeItems:[],reimbursements:[],gstInvoices:[],settlementRows:[line('sale','Principal',10,'Order',{amount_type:'ItemPrice'})]};
  const withIndianDeposit=calculateDashboardMetrics({...base,settlementHeaders:[{settlement_id:'dd-mm',deposit_date:'29.07.2026 23:59 GMT+5:30',total_amount:246.63}]},{start:'2026-07-21T00:00:00Z',end:'2026-07-30T00:00:00Z'});
  assert.equal(withIndianDeposit.statement.transfers.value,-246.63);
});

test('a settlement whose period overlaps the window is not a transfer in it',()=>{
  // Amazon's Transfers section is the money that reached the bank during the
  // window, so the settlement period the payout covers is irrelevant to it -
  // a 27 Jun-26 Jul settlement deposited on 28 Jul belongs to a statement
  // that contains 28 Jul, and to no other. Counting it by period overlap
  // instead is what put Seller A at -1,17,288.92 against Amazon's
  // -1,07,559.21 and Seller B at -328.84 against -246.63, both over-counting.
  const base={orders:[],orderItems:[],returns:[],financeItems:[],reimbursements:[],gstInvoices:[],settlementRows:[line('sale','Principal',10,'Order',{amount_type:'ItemPrice'})]};
  const period={settlement_id:'period',settlement_start_date:'27.06.2026 00:00:00 UTC',settlement_end_date:'26.07.2026 23:59:59 UTC',total_amount:131801.69};
  const window={start:'2026-06-27T00:00:00Z',end:'2026-07-27T00:00:00Z'};

  const depositedLater=calculateDashboardMetrics({...base,settlementHeaders:[{...period,deposit_date:'28.07.2026 00:00:00 UTC'}]},window);
  assert.equal(depositedLater.statement.transfers.value,0,'deposited after the window closed');
  assert.equal(depositedLater.metrics.settled.value,0);

  const notYetDeposited=calculateDashboardMetrics({...base,settlementHeaders:[period]},window);
  assert.equal(notYetDeposited.statement.transfers.value,0,'an open settlement has paid out nothing yet');

  const depositedInside=calculateDashboardMetrics({...base,settlementHeaders:[{...period,deposit_date:'26.07.2026 12:00:00 UTC'}]},window);
  assert.equal(depositedInside.statement.transfers.value,-131801.69);
});

test('never merges Deferred Finance activity into the statement, but does measure it',()=>{
  // Verified against a real seller's own Account Activity Statement PDF for
  // 1-25 Jul 2026. Merging Deferred activity moved every bucket further from
  // Amazon (Income 1,53,912.04 vs Amazon 1,32,046.97 where settlement-only
  // gives 1,22,980.13) and tripled the total absolute error, so the statement
  // stays settlement-only - while the pending pipeline is still reported, to
  // keep "Amazon counts money we do not hold" distinguishable from "we
  // misclassify money we do hold".
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],
    settlementRows:[line('sale','Principal',1000,'Order',{order_id:'order-settled',amount_type:'ItemPrice'})],
    financeItems:[
      {source_row_id:'f1',transaction_id:'tx-1',order_id:'order-pending',transaction_status:'Deferred',category:'item_price',amount_description:'OurPricePrincipal',amount:250,posted_date:'2026-07-10T00:00:00Z',raw:{}},
      {source_row_id:'f2',transaction_id:'tx-1',order_id:'order-pending',transaction_status:'Deferred',category:'tax',amount_description:'OurPriceTax',amount:45,posted_date:'2026-07-10T00:00:00Z',raw:{}}
    ]
  },range);
  assert.equal(r.statement.income.value,1000);
  assert.equal(r.statement.gst.value,0);
  assert.equal(r.metrics.netSales.source,'Amazon Settlement report');
  const summary=r.diagnostics.pendingMergeSummary;
  assert.equal(summary.merged,false);
  assert.equal(summary.pendingOrders,1);
  assert.equal(summary.pendingExcludedTotals.income,250);
  assert.equal(summary.pendingExcludedTotals.gst,45);
  assert.equal(summary.settlementBaselineTotals.income,1000);
});

test('an order with settlement lines anywhere is never reported as pending',()=>{
  // A settlement line's posted_date is the transaction date, so an order sold
  // near a range boundary often has its settlement lines outside the window
  // being viewed while its Finance rows fall inside it. Judging "settled"
  // from in-range settlement rows alone would report such an order as pending
  // and overstate the measured gap against Amazon.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const financeRow=(id,orderId)=>({source_row_id:id,transaction_id:`tx-${id}`,order_id:orderId,transaction_status:'Deferred',category:'item_price',amount_description:'OurPricePrincipal',amount:500,posted_date:'2026-07-10T00:00:00Z',raw:{}});
  const base={
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],
    settlementRows:[line('in-range','Principal',1000,'Order',{order_id:'order-in-range',amount_type:'ItemPrice'})],
    financeItems:[financeRow('a','order-outside-range'),financeRow('b','order-never-settled')]
  };
  assert.equal(calculateDashboardMetrics(base,range).diagnostics.pendingMergeSummary.pendingOrders,2);
  const corrected=calculateDashboardMetrics({...base,settledOrderIdsAllTime:['order-in-range','order-outside-range']},range);
  assert.equal(corrected.diagnostics.pendingMergeSummary.pendingOrders,1);
  assert.equal(corrected.diagnostics.pendingMergeSummary.pendingExcludedTotals.income,500);
});

test('counts shipped units from Amazon settlement quantity when order items lag behind',()=>{
  // Amazon meters listOrderItems at one order per 2200ms, so order_items
  // routinely lags the orders themselves. The old rule blanked Net Qty and
  // Return Rate entirely when any order's items had not arrived, even though
  // Amazon had already stated the quantity on the settlement line.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const orders=[{amazon_order_id:'order-a',status:'Shipped',order_date:'2026-07-05T00:00:00Z'},{amazon_order_id:'order-b',status:'Shipped',order_date:'2026-07-06T00:00:00Z'}];
  const settlementRows=[
    line('a','Principal',1000,'Order',{order_id:'order-a',amount_type:'ItemPrice',raw:{'quantity-purchased':'2'}}),
    line('b','Principal',500,'Order',{order_id:'order-b',amount_type:'ItemPrice',raw:{'quantity-purchased':'3'}})
  ];
  const base={orders,returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],financeItems:[],settledOrderIdsAllTime:[],settlementRows};
  // Only order-a has items synced so far; order-b is counted from settlement.
  const partial=calculateDashboardMetrics({...base,orderItems:[{source_row_id:'i1',amazon_order_id:'order-a',quantity_ordered:2,raw:{'order-item-id':'i1'}}]},range);
  assert.equal(partial.metrics.netQty.value,5);
  assert.match(partial.metrics.netQty.source,/settlement quantity-purchased/);
  assert.equal(partial.metrics.netQty.status,null);
  assert.equal(partial.metrics.returnRate.value,0);
  // With no order items at all, settlement alone still carries both orders.
  const settlementOnly=calculateDashboardMetrics({...base,orderItems:[]},range);
  assert.equal(settlementOnly.metrics.netQty.value,5);
  // An order Amazon has given no quantity for anywhere is reported, not hidden.
  const shortfall=calculateDashboardMetrics({...base,orders:[...orders,{amazon_order_id:'order-c',status:'Shipped',order_date:'2026-07-07T00:00:00Z'}],orderItems:[]},range);
  assert.equal(shortfall.metrics.netQty.value,5);
  assert.match(shortfall.metrics.netQty.status,/1 of 3 orders still awaiting quantity/);
});

test('an order is never counted twice when both order items and settlement carry a quantity',()=>{
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const r=calculateDashboardMetrics({
    orders:[{amazon_order_id:'order-a',status:'Shipped',order_date:'2026-07-05T00:00:00Z'}],
    orderItems:[{source_row_id:'i1',amazon_order_id:'order-a',quantity_ordered:2,raw:{'order-item-id':'i1'}}],
    returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],financeItems:[],settledOrderIdsAllTime:[],
    settlementRows:[line('a','Principal',1000,'Order',{order_id:'order-a',amount_type:'ItemPrice',raw:{'quantity-purchased':'2'}})]
  },range);
  assert.equal(r.metrics.netQty.value,2);
  assert.equal(r.metrics.netQty.source,'Orders + Returns');
});

test('one return without a quantity no longer blanks Net Qty and Return Rate',()=>{
  // Live case: 9 return rows, 8 with quantities. Requiring every row to carry
  // one made Net Qty and Return Rate report Unavailable even though Amazon had
  // stated 218 shipped units and 8 returned units. The KPI worked on a 30-day
  // range and broke on a narrower one that happened to include the row Amazon
  // had not put a quantity on.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const ret=(id,quantity)=>({source_row_id:id,order_id:`o-${id}`,return_date:'2026-07-12',quantity,raw:{eventId:id}});
  const base={
    orders:[{amazon_order_id:'order-a',status:'Shipped',order_date:'2026-07-05T00:00:00Z'}],
    orderItems:[{source_row_id:'i1',amazon_order_id:'order-a',quantity_ordered:100,raw:{'order-item-id':'i1'}}],
    reimbursements:[],gstInvoices:[],settlementHeaders:[],financeItems:[],settledOrderIdsAllTime:[],settlementRows:[]
  };
  const partial=calculateDashboardMetrics({...base,returns:[ret('r1',3),ret('r2',5),ret('r3',null)]},range);
  assert.equal(partial.metrics.returns.value,8);
  assert.equal(partial.metrics.netQty.value,92);
  assert.equal(partial.metrics.returnRate.value,8);
  assert.match(partial.metrics.returns.status,/1 of 3 returns have no quantity/);
  // No quantity anywhere is still honestly unavailable - never assumed to be one.
  const none=calculateDashboardMetrics({...base,returns:[ret('r1',null)]},range);
  assert.equal(none.metrics.returns.value,null);
  assert.equal(none.metrics.netQty.value,null);
  assert.match(none.metrics.netQty.status,/^Unavailable\b/);
  // No returns at all is zero, not unavailable.
  const clean=calculateDashboardMetrics({...base,returns:[]},range);
  assert.equal(clean.metrics.netQty.value,100);
  assert.equal(clean.metrics.returnRate.value,0);
});

test('Net Sales counts product sales only, never the tax stamped with the same amount_type',()=>{
  // Real seller (Ved Shakti Ayervedic, Jul 21-29 2026). Amazon's statement:
  // seller fulfilled product sales 567.60, product sale refunds -141.90,
  // GST collected 28.40, GST refunds -7.10. Amazon stamps amount_type
  // "ItemPrice" on Principal AND Product Tax alike, so folding amount_type
  // into the product-sale test made the tax count as a sale and the dashboard
  // reported Net Sales of 596.00 (= 567.60 + 28.40) instead of 425.70.
  const range={start:'2026-07-21T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],financeItems:[],settledOrderIdsAllTime:[],
    settlementRows:[
      line('sale','Principal',567.60,'Order',{amount_type:'ItemPrice'}),
      line('refund','Principal',-141.90,'Refund',{amount_type:'ItemPrice'}),
      line('gst','Product Tax',28.40,'Order',{amount_type:'ItemPrice'}),
      line('gst-refund','Product Tax',-7.10,'Refund',{amount_type:'ItemPrice'})
    ],
    settlementHeaders:[{settlement_id:'s1',deposit_date:'2026-07-29T00:00:00Z',total_amount:246.63}]
  },range);
  assert.equal(r.metrics.netSales.value,425.70);
  assert.equal(r.statement.income.value,425.70);
  assert.equal(r.statement.gst.value,21.30);
  assert.equal(r.statement.tax.value,0);
  assert.equal(r.statement.transfers.value,-246.63);
});

test('flags a settlement whose lines do not add up to Amazon\'s own stated total',()=>{
  // Every settlement document states its own total, so its lines must foot to
  // it exactly. This is a complete self-check for ingestion loss - no
  // statement PDF and no matching date range required.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const base={orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],financeItems:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[line('a','Principal',100,'Order')]};
  const clean=calculateDashboardMetrics(base,range);
  assert.deepEqual(clean.diagnostics.settlementIntegrity,[]);
  const broken=calculateDashboardMetrics({...base,settlementIntegrity:[{settlement_id:'s1',row_count:9,rows_total:328.84,header_total:246.63}]},range);
  assert.equal(broken.diagnostics.settlementIntegrity.length,1);
  assert.equal(broken.diagnostics.settlementIntegrity[0].difference,82.21);
  assert.equal(broken.diagnostics.settlementIntegrity[0].settlement_id,'s1');
});

test('reports when settlement history is incomplete rather than showing confident wrong money',()=>{
  // "Amazon has not settled it yet" and "we have not downloaded it yet" look
  // identical in the totals. Only this tells them apart.
  const range={start:'2026-07-21T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const base={orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],financeItems:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[line('a','Principal',567.60,'Order',{amount_type:'ItemPrice'})]};
  assert.equal(calculateDashboardMetrics(base,range).diagnostics.outstandingSettlementSyncs,0);
  assert.equal(calculateDashboardMetrics({...base,outstandingSettlementSyncs:2},range).diagnostics.outstandingSettlementSyncs,2);
});

test('diagnostics cannot claim exclusion while the rows are actually included',()=>{
  // The regression this guards against shipped live: sourcePolicy read
  // "settlement only; N Deferred Finance API row(s) measured but excluded"
  // and pendingMergeSummary.merged was hardcoded false, while the code
  // immediately below merged those very rows into financialRows. Every
  // diagnostic anyone would use to debug the totals reported the opposite of
  // what the code did. This asserts the invariant directly.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],
    settlementRows:[line('s1','Principal',1000,'Order',{order_id:'settled',amount_type:'ItemPrice'}),
                    line('s2','Commission',-100,'Order',{order_id:'settled',amount_type:'ItemFees'})],
    financeItems:[{source_row_id:'f1',transaction_id:'tx1',order_id:'pending',transaction_status:'DEFERRED',category:'item_price',amount_description:'OurPricePrincipal',amount:250,posted_date:'2026-07-10T00:00:00Z',raw:{}}]
  },range);
  const claimsExclusion=/excluded/i.test(r.diagnostics.sourcePolicy.financial);
  const settlementOnly=r.metrics.netSales.rows.every(row=>row.settlement_id!=null);
  assert.ok(claimsExclusion,'settlement-complete tenants should report the pending rows as excluded');
  assert.equal(r.diagnostics.pendingMergeSummary.merged,false);
  assert.ok(settlementOnly,'financialRows must contain settlement rows only while diagnostics claim exclusion');
  // The pending rows are still measured, just never counted.
  assert.equal(r.diagnostics.pendingMergeSummary.pendingExcludedTotals.income,250);
  assert.equal(r.statement.income.value,1000);
});

test('the statement only claims to match Amazon once it can prove it does',()=>{
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-26T00:00:00Z'};
  const clean={orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],financeItems:[],settledOrderIdsAllTime:[],
    settlementRows:[line('sale','Principal',1000,'Order',{order_id:'o1',amount_type:'ItemPrice'})]};
  assert.deepEqual(calculateDashboardMetrics(clean,range).diagnostics.completeness,{provisional:false,reasons:[]});

  const reasonsFor=input=>calculateDashboardMetrics({...clean,...input},range).diagnostics.completeness;

  const unfinished=reasonsFor({outstandingSettlementSyncs:2});
  assert.equal(unfinished.provisional,true);
  assert.match(unfinished.reasons.join(' '),/2 settlement sync\(s\) did not finish/);

  const torn=reasonsFor({settlementIntegrity:[{settlement_id:'s1',row_count:40,rows_total:900,header_total:1000}]});
  assert.equal(torn.provisional,true);
  assert.match(torn.reasons.join(' '),/stored rows sum to 100 less than Amazon says they should/);

  // Amazon's own 21-29 Jul statement for Seller B carries a -141.90 refund
  // that the Finances API marks Deferred and no settlement document holds, so
  // excluded-Deferred activity has to be surfaced as a caveat rather than
  // treated as certainly irrelevant.
  const deferred=reasonsFor({financeItems:[{source_row_id:'f1',transaction_id:'tx',order_id:'o2',transaction_status:'Deferred',category:'item_price',amount_description:'OurPricePrincipal',amount:-141.9,posted_date:'2026-07-10T00:00:00Z',raw:{}}]});
  assert.equal(deferred.provisional,true);
  assert.match(deferred.reasons.join(' '),/1 Deferred row\(s\) totalling -141\.9/);
  assert.match(deferred.reasons.join(' '),/by section: income -141\.9/,'the split is what makes it comparable to the Income gap');

  // No settlement report at all: the sections come from a different ledger
  // view than the one Amazon's statement is drawn from.
  const noSettlement=calculateDashboardMetrics({...clean,settlementRows:[],financeItems:[line('f','Principal',1000,'Order')]},range).diagnostics.completeness;
  assert.equal(noSettlement.provisional,true);
  assert.match(noSettlement.reasons.join(' '),/No settlement report covers this range/);
});

test('a settlement chain that stops before the window ends says so',()=>{
  // Real shape, from a live account: an unbroken settlement chain that simply
  // does not reach the end of the range being viewed. Nothing is missing from
  // the middle, so no integrity check fires - but five days of the window
  // have no settlement document behind them, and a settlement-only figure for
  // that window is a partial period.
  const range={start:'2026-06-30T18:30:00Z',end:'2026-07-30T18:30:00Z'};
  const input={orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],financeItems:[],settledOrderIdsAllTime:[],
    settlementRows:[line('sale','Principal',1000,'Order',{order_id:'o1',amount_type:'ItemPrice'})],
    settlementHeaders:[
      {settlement_id:'s7',deposit_date:'23.07.2026 17:45:05 UTC',settlement_start_date:'17.07.2026 14:46:26 UTC',settlement_end_date:'21.07.2026 17:45:05 UTC',total_amount:113872.28},
      {settlement_id:'s8',deposit_date:'27.07.2026 10:44:14 UTC',settlement_start_date:'21.07.2026 17:45:05 UTC',settlement_end_date:'25.07.2026 10:44:14 UTC',total_amount:59707.76}
    ]};
  const reasons=calculateDashboardMetrics(input,range).diagnostics.completeness.reasons.join(' ');
  assert.match(reasons,/Settlement documents reach only 2026-07-25/);
  assert.match(reasons,/this range runs to 2026-07-30/);
  assert.match(reasons,/last 5 day\(s\)/);
});

test('a settlement chain covering the whole window raises nothing',()=>{
  const range={start:'2026-06-30T18:30:00Z',end:'2026-07-30T18:30:00Z'};
  const input={orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],financeItems:[],settledOrderIdsAllTime:[],
    settlementRows:[line('sale','Principal',1000,'Order',{order_id:'o1',amount_type:'ItemPrice'})],
    settlementHeaders:[{settlement_id:'s9',deposit_date:'29.07.2026 10:00:00 UTC',settlement_start_date:'25.07.2026 10:44:14 UTC',settlement_end_date:'31.07.2026 00:00:00 UTC',total_amount:66743.04}]};
  const reasons=calculateDashboardMetrics(input,range).diagnostics.completeness.reasons.join(' ');
  assert.doesNotMatch(reasons,/Settlement documents reach only/);
});
