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

test('a deposit stamped in local time is placed at the instant it happened',()=>{
  // 30 Jul 23:59 GMT+5:30 is 30 Jul 18:29 UTC - inside a window ending at
  // 30 Jul 18:30 UTC by one minute. Read as if it were UTC it lands five and
  // a half hours later, outside the window, and a whole payout disappears.
  const base={orders:[],orderItems:[],returns:[],financeItems:[],reimbursements:[],gstInvoices:[],settledOrderIdsAllTime:[],
    settlementRows:[line('sale','Principal',10,'Order',{amount_type:'ItemPrice'})]};
  const window={start:'2026-06-30T18:30:00Z',end:'2026-07-30T18:30:00Z'};

  const localStamp=calculateDashboardMetrics({...base,settlementHeaders:[{settlement_id:'ist',deposit_date:'30.07.2026 23:59:00 GMT+5:30',total_amount:66743.04}]},window);
  assert.equal(localStamp.statement.transfers.value,-66743.04,'23:59 IST on 30 Jul is inside a window ending at IST midnight');

  const utcStamp=calculateDashboardMetrics({...base,settlementHeaders:[{settlement_id:'utc',deposit_date:'30.07.2026 19:30:30 UTC',total_amount:66743.04}]},window);
  assert.equal(utcStamp.statement.transfers.value,0,'19:30 UTC is genuinely past the window end');
});

test('settlement date zone suffixes are read, not discarded',()=>{
  const base={orders:[],orderItems:[],returns:[],financeItems:[],reimbursements:[],gstInvoices:[],settledOrderIdsAllTime:[],
    settlementRows:[line('sale','Principal',10,'Order',{amount_type:'ItemPrice'})]};
  // A one-second window around the true instant of 30.07.2026 12:00:00 GMT-8,
  // which is 30 Jul 20:00:00 UTC.
  const r=calculateDashboardMetrics({...base,settlementHeaders:[{settlement_id:'west',deposit_date:'30.07.2026 12:00:00 GMT-8',total_amount:500}]},
    {start:'2026-07-30T20:00:00Z',end:'2026-07-30T20:00:01Z'});
  assert.equal(r.statement.transfers.value,-500);
});

test('the day count follows the seller calendar, not the boundary convention',()=>{
  // Same 30 selected days, expressed both ways: the old IST-midnight end and
  // the new 23:59-GMT end. DRR divides by this, so it must not move.
  assert.equal(inclusiveDays('2026-06-30T18:30:00Z','2026-07-30T18:30:00Z'),30,'old convention');
  assert.equal(inclusiveDays('2026-06-30T18:30:00Z','2026-07-31T00:00:00Z'),30,'new convention, same 30 days');
  assert.equal(inclusiveDays('2026-06-30T18:30:00Z','2026-07-26T00:00:00Z'),25,'1-25 Jul');
});

test('the Amazon window end includes a late deposit the IST-midnight end missed',()=>{
  // The live case: 66,743.04 landing after 18:30 UTC on the last day.
  const base={orders:[],orderItems:[],returns:[],financeItems:[],reimbursements:[],gstInvoices:[],settledOrderIdsAllTime:[],
    settlementRows:[line('sale','Principal',10,'Order',{amount_type:'ItemPrice'})],
    settlementHeaders:[{settlement_id:'late',deposit_date:'30.07.2026 19:30:30 UTC',total_amount:66743.04}]};
  const istMidnightEnd=calculateDashboardMetrics(base,{start:'2026-06-30T18:30:00Z',end:'2026-07-30T18:30:00Z'});
  assert.equal(istMidnightEnd.statement.transfers.value,0,'what the seller saw before');
  const amazonEnd=calculateDashboardMetrics(base,{start:'2026-06-30T18:30:00Z',end:'2026-07-31T00:00:00Z'});
  assert.equal(amazonEnd.statement.transfers.value,-66743.04,'what Amazon counted');
});

test('the Amazon window end still stops short of the next day',()=>{
  // Widening to 31 Jul overshoots by 18.5 hours and would count this one.
  const base={orders:[],orderItems:[],returns:[],financeItems:[],reimbursements:[],gstInvoices:[],settledOrderIdsAllTime:[],
    settlementRows:[line('sale','Principal',10,'Order',{amount_type:'ItemPrice'})],
    settlementHeaders:[{settlement_id:'next-day',deposit_date:'31.07.2026 09:00:00 UTC',total_amount:50000}]};
  const r=calculateDashboardMetrics(base,{start:'2026-06-30T18:30:00Z',end:'2026-07-31T00:00:00Z'});
  assert.equal(r.statement.transfers.value,0,'a 31 Jul deposit is not in a 1-30 Jul statement');
});

test('deposits just outside the window are named, with how far outside they fell',()=>{
  // The live shape: a settlement closing 29 Jul that pays out on 31 Jul,
  // against a window ending 31 Jul 00:00 UTC. Reasoning about which deposits
  // "should" be in range was wrong twice; this makes it a lookup.
  const range={start:'2026-06-30T18:30:00Z',end:'2026-07-31T00:00:00Z'};
  const input={orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],financeItems:[],settledOrderIdsAllTime:[],
    settlementRows:[line('sale','Principal',10,'Order',{amount_type:'ItemPrice'})],
    settlementHeaders:[
      {settlement_id:'in',deposit_date:'27.07.2026 10:44:14 UTC',settlement_end_date:'25.07.2026 10:44:14 UTC',total_amount:59707.76},
      {settlement_id:'after',deposit_date:'31.07.2026 10:44:14 UTC',settlement_end_date:'29.07.2026 10:44:14 UTC',total_amount:66743.04},
      {settlement_id:'before',deposit_date:'29.06.2026 09:00:00 UTC',settlement_end_date:'27.06.2026 09:00:00 UTC',total_amount:12345.67},
      {settlement_id:'far',deposit_date:'30.09.2026 09:00:00 UTC',settlement_end_date:'28.09.2026 09:00:00 UTC',total_amount:999}
    ]};
  const r=calculateDashboardMetrics(input,range);
  assert.equal(r.statement.transfers.value,-59707.76,'only the in-window deposit counts');

  const outside=r.diagnostics.depositsOutsideRange;
  assert.deepEqual(outside.map(row=>row.settlement_id),['after','before'],'the distant one is not noise worth showing');
  assert.equal(outside[0].amount,66743.04);
  assert.equal(outside[0].days_outside,1,'one day after the range ends');
  assert.ok(outside[1].days_outside<0,'the earlier one reads as before the start');

  const reasons=r.diagnostics.completeness.reasons.join(' ');
  assert.match(reasons,/2 deposit\(s\) sit just outside this window/);
  assert.match(reasons,/66743\.04 \(1 day\(s\) after this range ends, for the settlement ending 29\.07\.2026/);
});

// Transfers comes from the Finances API's own Transfer transactions, verified
// live against both accounts that have an Amazon Custom Unified Summary to
// check against. Settlement deposit-dates disagree with it at every window
// edge, which is why no rule built on them ever matched either account.
const transfer = (postedDate, total, id) => ({ transaction_id: id ?? `t-${postedDate}-${total}`, transaction_type: 'Transfer', posted_date: postedDate, total_amount: total });
const statementBase = { orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],financeItems:[],settledOrderIdsAllTime:[],
  settlementRows:[line('sale','Principal',10,'Order',{amount_type:'ItemPrice'})] };

test("Seller C's real transfers reproduce Amazon's statement exactly",()=>{
  // 1-30 Jul 2026. Amazon: -7,59,003.33. The last transfer posts 30 Jul 06:55
  // while its settlement stamps deposit-date 31 Jul 12:36 - counting the
  // deposit instead lost 66,743.04, which was the entire gap.
  const financeTransactions=[
    transfer('2026-07-01T13:47:13Z',40634.25), transfer('2026-07-04T11:47:21Z',138337.07),
    transfer('2026-07-06T10:04:33Z',72447.75), transfer('2026-07-13T09:03:52Z',146676.49),
    transfer('2026-07-16T04:48:02Z',57884.01), transfer('2026-07-18T09:05:27Z',62700.68),
    transfer('2026-07-22T12:01:22Z',113872.28), transfer('2026-07-26T06:43:56Z',59707.76),
    transfer('2026-07-30T06:55:54Z',66743.04)
  ];
  // The window the UI actually sends for 1-30 Jul: IST midnight to IST
  // midnight, exactly as Amazon's own PDF header states both ends.
  const r=calculateDashboardMetrics({...statementBase,financeTransactions,
    settlementHeaders:[{settlement_id:'late',deposit_date:'31.07.2026 12:36:29 UTC',total_amount:66743.04}]},
    {start:'2026-06-30T18:30:00Z',end:'2026-07-30T18:30:00Z'});
  assert.equal(r.statement.transfers.value,-759003.33);
  assert.equal(r.metrics.settled.value,759003.33);
  assert.equal(r.statement.transfers.source,'Amazon Finances API transfers');
});

test("Seller A's real transfers reproduce Amazon's statement exactly",()=>{
  // 1-25 Jul 2026. Amazon: -1,07,559.21. Two settlements the deposit rule
  // wanted had transfers posting before the window began.
  const financeTransactions=[
    transfer('2026-07-01T09:19:33Z',1377.59), transfer('2026-07-01T09:25:03Z',6651.15),
    transfer('2026-07-03T20:15:09Z',1890.26), transfer('2026-07-03T20:15:28Z',6547.31),
    transfer('2026-07-05T12:16:00Z',7105.33), transfer('2026-07-07T09:45:41Z',4074.10),
    transfer('2026-07-07T09:46:13Z',5345.91), transfer('2026-07-12T21:52:18Z',5205.50),
    transfer('2026-07-12T21:55:23Z',16581.64), transfer('2026-07-15T21:02:45Z',15948.67),
    transfer('2026-07-15T21:11:00Z',712.17), transfer('2026-07-19T07:33:56Z',14344.72),
    transfer('2026-07-19T14:00:54Z',5842.27), transfer('2026-07-22T12:47:55Z',15932.59),
    transfer('2026-06-29T02:45:30Z',4546.81), transfer('2026-07-27T13:16:11Z',4.17)
  ];
  const r=calculateDashboardMetrics({...statementBase,financeTransactions,settlementHeaders:[]},
    {start:'2026-06-30T18:30:00Z',end:'2026-07-26T00:00:00Z'});
  assert.equal(r.statement.transfers.value,-107559.21,'the 29 Jun and 27 Jul transfers are outside the window');
});

test('settlement headers still answer when no transfer transactions are synced',()=>{
  const r=calculateDashboardMetrics({...statementBase,financeTransactions:[],
    settlementHeaders:[{settlement_id:'s1',deposit_date:'22.07.2026 12:01:22 UTC',total_amount:113872.28}]},
    {start:'2026-06-30T18:30:00Z',end:'2026-07-31T00:00:00Z'});
  assert.equal(r.statement.transfers.value,-113872.28);
  assert.equal(r.statement.transfers.source,'Settlement headers','and it says which source it used');
});

test('a repeated transfer transaction is counted once',()=>{
  const t=transfer('2026-07-10T00:00:00Z',5000,'same-id');
  const r=calculateDashboardMetrics({...statementBase,financeTransactions:[t,{...t}],settlementHeaders:[]},
    {start:'2026-06-30T18:30:00Z',end:'2026-07-31T00:00:00Z'});
  assert.equal(r.statement.transfers.value,-5000);
});

test('Income is an allow-list, so an unknown line cannot inflate it',()=>{
  // The residual classifier ("everything that is not a fee, tax, GST or
  // transfer") swept every unrecognised row into Income. That is invisible on
  // settlement rows, whose labels the classifiers were written against, and
  // wrong on Finances API rows, whose labels differ - which is why both
  // earlier attempts to merge Deferred activity overshot. Reconciled against a
  // real Custom Unified Transaction report, Deferred is +7,152.59 of Income
  // for that window; the residual classifier made it +30,931.91.
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],financeItems:[],
    settlementRows:[line('sale','Principal',1000,'Order',{order_id:'o1',amount_type:'ItemPrice'}),
                    line('mystery','Some Future Amazon Line',500,'Order',{order_id:'o1',amount_type:'SomethingNew'})]
  },range);
  assert.equal(r.statement.income.value,1000,'the unknown 500 must NOT land in Income');
  const reasons=r.diagnostics.completeness.reasons.join(' ');
  assert.match(reasons,/match no statement section/,'but it must be reported, never dropped quietly');
  assert.match(reasons,/Some Future Amazon Line 500/);
  assert.equal(r.diagnostics.completeness.provisional,true);
});

test('shipping and gift wrap credits are Income; their charges stay Expenses',()=>{
  // Amazon's statement keeps these as separate named lines: "Shipping
  // credits"/"Gift wrap credits" under Income against the shipping and gift
  // wrap fees under Expenses. Tax on either belongs to GST, never to Income.
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],financeItems:[],
    settlementRows:[line('ship','Shipping',100,'Order',{order_id:'o1',amount_type:'ItemPrice'}),
                    line('wrap','Gift wrap',20,'Order',{order_id:'o1',amount_type:'ItemPrice'}),
                    line('shipfee','Shipping chargeback',-30,'Order',{order_id:'o1',amount_type:'ItemFees'}),
                    line('shiptax','Shipping tax',18,'Order',{order_id:'o1',amount_type:'ItemPrice'})]
  },range);
  assert.equal(r.statement.income.value,120,'credits only');
  assert.equal(r.statement.expenses.value,-30,'the chargeback is an expense, not negative income');
  assert.equal(r.statement.gst.value,18,'shipping tax is GST');
  assert.deepEqual(r.diagnostics.completeness.reasons.filter(x=>/match no statement section/.test(x)),[]);
});

test('real settlement labels leave nothing unclassified',()=>{
  // Guards the allow-list against being too narrow: every label below is one
  // Amazon actually emitted on a real account, and each must find a section.
  const labels=[['Principal','ItemPrice'],['Product Tax','ItemPrice'],['Shipping','ItemPrice'],['Shipping tax','ItemPrice'],
    ['Commission','ItemFees'],['Fixed closing fee','ItemFees'],['FBA Pick & Pack Fee','ItemFees'],['FBA Weight Handling Fee','ItemFees'],
    ['Promo rebates','Promotion'],['Shipping discount','Promotion'],['TCS-CGST','ItemTCS'],['TDS (Section 194-O)','ItemTDS'],
    ['SAFE-T Reimbursement','Other Transactions'],['REVERSAL_REIMBURSEMENT','FBA Inventory Reimbursement'],
    ['Amazon Easy Ship Charges','other-transaction'],['FBA Inventory Storage Fee','FBAFees']];
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],financeItems:[],
    settlementRows:labels.map(([description,amountType],i)=>line(`r${i}`,description,10,'Order',{order_id:'o1',amount_type:amountType}))
  },range);
  assert.deepEqual(r.diagnostics.completeness.reasons.filter(x=>/match no statement section/.test(x)),[],
    'a label Amazon really sends must never be left sectionless');
});

test('a tax discount is GST only, never GST and Income both',()=>{
  // Sections are independent filters, so a row matching two of them is counted
  // twice. isPromotion excluded settlement's spelling ("product tax discount")
  // but not the Finances API's ("OurPriceTaxDiscount"), so that row landed in
  // Income AND GST. Measured against Amazon's statement on the real Deferred
  // population: Income came out 7,146.50 against 7,152.59 - short by exactly
  // the -6.09 of OurPriceTaxDiscount double counted. With this fixed the whole
  // Deferred population classifies to 0.00 on all three sections.
  // Categories are what categorizeFinanceLabel() really assigns these labels.
  const financeRow=(description,amount,category)=>({source_row_id:description,transaction_id:'t1',order_id:'o1',
    category,amount_description:description,amount,
    posted_date:'2026-07-10T00:00:00Z',transaction_status:'DEFERRED',raw:{}});
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[],
    financeItems:[financeRow('OurPricePrincipal',1000,'item_price'),financeRow('OurPriceTax',180,'tax'),financeRow('OurPriceTaxDiscount',-6.09,'promotion')]
  },range);
  assert.equal(r.statement.gst.value,173.91,'the tax discount reduces GST');
  assert.equal(r.statement.income.value,1000,'and must not also reduce Income');
  // The settlement spelling of the same thing behaves identically.
  const s=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],financeItems:[],
    settlementRows:[line('p','Principal',1000,'Order',{order_id:'o1',amount_type:'ItemPrice'}),
                    line('t','Product Tax',180,'Order',{order_id:'o1',amount_type:'ItemPrice'}),
                    line('d','Product tax discount',-6.09,'Order',{order_id:'o1',amount_type:'Promotion'})]
  },range);
  assert.equal(s.statement.gst.value,173.91);
  assert.equal(s.statement.income.value,1000);
});

test('a real promotion is still a promotion, not swallowed by the GST rule',()=>{
  // Guards the fix from over-reaching: only tax discounts move to GST.
  // "OurPriceDiscount" and "ShippingDiscount" carry no tax wording.
  const promo=(description,amount)=>({source_row_id:description,transaction_id:'t1',order_id:'o1',category:'promotion',
    amount_description:description,amount,posted_date:'2026-07-10T00:00:00Z',transaction_status:'DEFERRED',raw:{}});
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[],
    financeItems:[promo('OurPriceDiscount',-33.86),promo('ShippingDiscount',-101.70)]
  },range);
  assert.equal(r.statement.income.value,-135.56,'promotional rebates stay in Income');
  assert.equal(r.statement.gst.value,0);
});
