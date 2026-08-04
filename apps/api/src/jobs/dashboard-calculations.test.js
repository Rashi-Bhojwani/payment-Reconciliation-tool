import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDashboardMetrics, dedupeRepostedTransactions, inclusiveDays } from './dashboard-calculations.js';
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
  // Deliberately empty: this fixture exercises the SETTLEMENT source. An
  // account with one Finance row and thirteen settlement rows does not exist -
  // both come from the same sync - and the Finances API is the statement source
  // whenever it has data, so leaving a stub here would just test the fallback
  // by accident.
  financeItems:[],
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

test('a released re-issue of deferred money is not counted twice',()=>{
  // When deferred money matures Amazon does not update the transaction, it
  // issues a second one with a new id and the release date as its posted date.
  // Both come back from listTransactions. Proved on a real account, one order,
  // one fee line:
  //   RELEASED          0zLrB-4XOAs21B  posted 2026-07-25  Commission Base -186.83
  //   DEFERRED_RELEASED O_vpD65He6FncA  posted 2026-07-15  Commission Base -186.83
  // 104 of 251 orders carried both, and the two populations together totalled
  // 228,172.22 against a statement of 113,423.84 - almost exactly twice. That
  // double count, not the merge itself, is why two earlier attempts to include
  // Deferred activity overshot and were reverted.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const fin=(id,status,description,amount,category)=>({source_row_id:id,transaction_id:id,order_id:'order-1',
    category,amount_description:description,amount,posted_date:'2026-07-10T00:00:00Z',transaction_status:status,raw:{}});
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[],
    financeItems:[
      fin('rel','RELEASED','OurPricePrincipal',1000,'item_price'),
      fin('rel-fee','RELEASED','Commission Base',-100,'referral_commission'),
      // the same money, re-posted at its release date - must not be added again
      fin('dr','DEFERRED_RELEASED','OurPricePrincipal',1000,'item_price'),
      fin('dr-fee','DEFERRED_RELEASED','Commission Base',-100,'referral_commission'),
      // genuinely still deferred - Amazon's statement DOES carry this
      fin('def','DEFERRED','OurPricePrincipal',250,'item_price')
    ]
  },range);
  assert.equal(r.statement.income.value,1250,'released 1000 + still-deferred 250, the re-issue counted once');
  assert.equal(r.statement.expenses.value,-100,'the fee counted once, not twice');
  assert.equal(r.diagnostics.sourcePolicy.financial.startsWith('Amazon Finances API'),true);
});

test('still-deferred activity is counted, because Amazon\'s statement carries it',()=>{
  // Reconciled against a real Custom Unified Transaction report, the Deferred
  // population contributed Income +7,152.59, Expenses -2,030.55 and GST
  // +1,287.46 - exactly what a settlement-only figure was short by.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const fin=(id,status,description,amount,category)=>({source_row_id:id,transaction_id:id,order_id:`o-${id}`,
    category,amount_description:description,amount,posted_date:'2026-07-10T00:00:00Z',transaction_status:status,raw:{}});
  const base=[fin('r1','RELEASED','OurPricePrincipal',1000,'item_price'),fin('r2','RELEASED','Commission Base',-100,'referral_commission')];
  const withDeferred=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[],
    financeItems:[...base,fin('d1','DEFERRED','OurPricePrincipal',250,'item_price'),fin('d2','DEFERRED','OurPriceTax',45,'tax')]
  },range);
  assert.equal(withDeferred.statement.income.value,1250);
  assert.equal(withDeferred.statement.gst.value,45);
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
  // "measured but excluded" while the code below merged those very rows into
  // the totals. Every diagnostic anyone would use to debug the figures said the
  // opposite of what the code did. The invariant is what matters, not which way
  // round it happens to be - so it is asserted in both directions.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const base={orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],
    settlementRows:[line('s1','Principal',1000,'Order',{order_id:'settled',amount_type:'ItemPrice'}),
                    line('s2','Commission',-100,'Order',{order_id:'settled',amount_type:'ItemFees'})]};
  const deferredRow={source_row_id:'f1',transaction_id:'tx1',order_id:'pending',transaction_status:'DEFERRED',
    category:'item_price',amount_description:'OurPricePrincipal',amount:250,posted_date:'2026-07-10T00:00:00Z',raw:{}};

  // Finance data present: it is the statement source, and the Deferred row is
  // counted - so nothing may say "excluded".
  const counted=calculateDashboardMetrics({...base,financeItems:[deferredRow]},range);
  assert.equal(counted.statement.income.value,250,'the Finances ledger is the source');
  assert.equal(/excluded/i.test(counted.diagnostics.sourcePolicy.financial),false,
    'nothing may claim exclusion while the rows are in the totals');
  assert.match(counted.diagnostics.completeness.reasons.join(' '),/ARE counted/);

  // No finance data: settlement is the fallback, and there is nothing pending
  // to describe either way.
  const settlementOnly=calculateDashboardMetrics({...base,financeItems:[]},range);
  assert.equal(settlementOnly.statement.income.value,1000);
  assert.equal(settlementOnly.diagnostics.sourcePolicy.financial.startsWith('Amazon Settlement report'),true);
  assert.ok(settlementOnly.metrics.netSales.rows.every(row=>row.settlement_id!=null));
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

  // No settlement report is NOT a caveat any more. The Finances API is the
  // ledger Amazon builds the statement from - posted-date indexed and carrying
  // deferred activity, neither of which a settlement document does - so having
  // only that is the normal, better case, not a degraded one.
  // Enough history behind it that re-posted payments can be matched to their
  // originals - see the lookback assertion below.
  const withHistory=[{source_row_id:'old',transaction_id:'old',order_id:'o-old',category:'item_price',
    amount_description:'OurPricePrincipal',amount:1,posted_date:'2026-05-01T00:00:00Z',transaction_status:'RELEASED',raw:{}},
    line('f','Principal',1000,'Order')];
  const noSettlement=calculateDashboardMetrics({...clean,settlementRows:[],financeItems:withHistory},range).diagnostics.completeness;
  assert.equal(noSettlement.provisional,false,'Finances-sourced sections are not provisional for lacking settlement');
  assert.deepEqual(noSettlement.reasons,[]);

  // Too little history to match a re-post against its original: the sections can
  // read HIGH, and must say so rather than quietly over-count.
  const shortHistory=calculateDashboardMetrics({...clean,settlementRows:[],financeItems:[line('f','Principal',1000,'Order')]},range).diagnostics.completeness;
  assert.equal(shortHistory.provisional,true);
  assert.match(shortHistory.reasons.join(' '),/may read HIGH/);
  assert.match(shortHistory.reasons.join(' '),/Sync a wider range/);

  // Neither source carrying the range still is a caveat.
  const nothing=calculateDashboardMetrics({...clean,settlementRows:[],financeItems:[]},range).diagnostics.completeness;
  assert.equal(nothing.provisional,true);
  assert.match(nothing.reasons.join(' '),/Neither a settlement document nor the Finances API covers this range/);
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

test('Amazon has no generic Tax section, so nothing may invent one',()=>{
  // Both reconciled accounts report every line of Amazon's Tax section as 0,
  // while TDS appears under Expenses as "TDS - Section 194-O Net". Two real
  // Finances API labels were landing in a generic Tax bucket instead:
  // "TaxWithholding" (-499.24) carries neither "tcs" nor "tds" as a word, and
  // "OrderCancellationCharge Tax" (-201.89) carries no fee word at all. Their
  // parent charge, "OrderCancellationCharge Base", matched nothing and was
  // left unclassified entirely.
  const fin=(description,amount,category)=>({source_row_id:description,transaction_id:'t1',order_id:'o1',category,
    amount_description:description,amount,posted_date:'2026-07-10T00:00:00Z',transaction_status:'RELEASED',raw:{}});
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[],
    financeItems:[fin('OurPricePrincipal',1000,'item_price'),fin('TaxWithholding',-499.24,'tax'),
                  fin('OrderCancellationCharge Base',-1121.58,'other'),fin('OrderCancellationCharge Tax',-201.89,'tax')]
  },range);
  assert.equal(r.statement.tax.value,0,'Amazon states this section is 0');
  assert.equal(r.statement.expenses.value,-1822.71,'withholding and the cancellation charge are Expenses');
  assert.equal(r.statement.income.value,1000,'and none of it is Income');
  assert.deepEqual(r.diagnostics.completeness.reasons.filter(x=>/match no statement section/.test(x)),[],
    'the cancellation charge must no longer be sectionless');
});

test('a genuine product tax is still GST, not withholding',()=>{
  // Guards the widened withholding rule from swallowing ordinary GST.
  const fin=(description,amount,category)=>({source_row_id:description,transaction_id:'t1',order_id:'o1',category,
    amount_description:description,amount,posted_date:'2026-07-10T00:00:00Z',transaction_status:'RELEASED',raw:{}});
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[],
    financeItems:[fin('OurPriceTax',180,'tax'),fin('ShippingTax',18,'tax')]
  },range);
  assert.equal(r.statement.gst.value,198);
  assert.equal(r.statement.expenses.value,0);
  assert.equal(r.statement.tax.value,0);
});

test('a re-post is collapsed across stages, but genuine repeats within a stage survive',()=>{
  // A real order settles this: a 12,000 sale with TWO identical 6,000 refunds,
  // each of the three events posted once as DEFERRED_RELEASED and again as
  // RELEASED - six transactions for three events. Keeping one per signature
  // would have deleted a genuine refund, so the number of real events is the
  // largest count any single status reaches: 2 DEFERRED_RELEASED + 2 RELEASED
  // means two refunds, and 1 + 1 means one sale.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const tx=(id,status,day,lines)=>lines.map(([description,amountValue,category],i)=>({
    source_row_id:`${id}-${i}`,transaction_id:id,order_id:'order-1',category,amount_description:description,
    amount:amountValue,posted_date:`2026-07-${day}T00:00:00Z`,transaction_status:status,raw:{}}));
  const refund=[['OurPricePrincipal',-6000,'item_price'],['Commission Base',378,'referral_commission']];
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[],
    financeItems:[
      // two real refunds, each re-posted on release: 2 + 2 -> two survive
      ...tx('d1','DEFERRED_RELEASED','07',refund),...tx('d2','DEFERRED_RELEASED','08',refund),
      ...tx('r1','RELEASED','25',refund),...tx('r2','RELEASED','25',refund)
    ]
  },range);
  assert.equal(r.statement.income.value,-12000,'both refunds count, neither twice');
  assert.equal(r.statement.expenses.value,756);
});

test('a transaction with no order id is never collapsed',()=>{
  // Transfers, service fees and withholding legitimately repeat with identical
  // lines - one real account carries 51 identical order-less rows that must all
  // count. Collapsing those would delete real money.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const fee=id=>({source_row_id:id,transaction_id:id,order_id:null,category:'other',
    amount_description:'Service Fee',amount:-59,posted_date:'2026-07-10T00:00:00Z',transaction_status:'RELEASED',raw:{}});
  const sale={source_row_id:'s',transaction_id:'s',order_id:'o1',category:'item_price',
    amount_description:'OurPricePrincipal',amount:1000,posted_date:'2026-07-10T00:00:00Z',transaction_status:'RELEASED',raw:{}};
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[],
    financeItems:[sale,fee('f1'),fee('f2'),fee('f3')]
  },range);
  assert.equal(r.statement.expenses.value,-177,'all three identical service fees count');
});

test('a transaction differing by one line is a different event and survives',()=>{
  // A partial refund or a fee reversal changes the line set. Collapsing on a
  // looser key than the whole set would delete it.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const row=(id,description,amountValue,category,status='RELEASED')=>({source_row_id:`${id}-${description}`,transaction_id:id,
    order_id:'order-1',category,amount_description:description,amount:amountValue,
    posted_date:'2026-07-10T00:00:00Z',transaction_status:status,raw:{}});
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[],
    financeItems:[row('a','OurPricePrincipal',1000,'item_price'),row('a','Commission Base',-100,'referral_commission'),
                  row('b','OurPricePrincipal',1000,'item_price')]
  },range);
  assert.equal(r.statement.income.value,2000,'the second transaction is not an exact copy, so it counts');
  assert.equal(r.statement.expenses.value,-100);
});

test('dedupeRepostedTransactions keeps the ORIGINAL posting, not the released copy',()=>{
  // Amazon dates money by where it first appeared in the ledger; the re-post at
  // release time is the copy. Verified on a real account with a full month of
  // history: keeping the original reproduces its statement exactly, while
  // keeping the released copy gives 950,003.27 against 528,614.89.
  const rows=[
    {source_row_id:'r',transaction_id:'r',order_id:'o',category:'item_price',amount_description:'P',amount:10,transaction_status:'RELEASED',posted_date:'2026-07-25T00:00:00Z'},
    {source_row_id:'d',transaction_id:'d',order_id:'o',category:'item_price',amount_description:'P',amount:10,transaction_status:'DEFERRED_RELEASED',posted_date:'2026-07-07T00:00:00Z'}
  ];
  const {kept,dropped}=dedupeRepostedTransactions(rows);
  assert.equal(kept.length,1);
  assert.equal(kept[0].posted_date,'2026-07-07T00:00:00Z','the earliest posting is the one Amazon dates by');
  assert.equal(dropped,1);
});

test('dates are ordered as instants, not as strings',()=>{
  // Postgres returns timestamptz as a Date object, and String(date) is
  // "Wed Jul 01 2026 ...", so a lexicographic sort orders by WEEKDAY NAME:
  // Fri, Sat, Sun, Thu, Wed. "Keep the earliest posting" therefore kept an
  // effectively random copy in production while behaving perfectly in tests,
  // which pass ISO strings. On a real account it moved Income from 5,64,126.22
  // to 8,19,913.31 and made Tax non-zero. Every fixture here uses Date objects
  // deliberately - that is the shape the server passes.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  // 1 Jul is a Wednesday and 3 Jul a Friday, so "Fri" sorts before "Wed" and the
  // wrong copy wins unless the comparison uses the instant.
  const tx=(id,status,iso,amountValue)=>({source_row_id:id,transaction_id:id,order_id:'order-1',
    category:'item_price',amount_description:'OurPricePrincipal',amount:amountValue,
    posted_date:new Date(iso),transaction_status:status,raw:{}});
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[],
    financeItems:[tx('original','DEFERRED_RELEASED','2026-07-01T00:00:00Z',1000),
                  tx('repost','RELEASED','2026-07-03T00:00:00Z',1000)]
  },range);
  assert.equal(r.statement.income.value,1000,'one payment, counted once');
  const {kept}=dedupeRepostedTransactions([tx('repost','RELEASED','2026-07-03T00:00:00Z',1000),
                                           tx('original','DEFERRED_RELEASED','2026-07-01T00:00:00Z',1000)]);
  assert.equal(kept.length,1);
  assert.equal(kept[0].transaction_id,'original','1 Jul (Wed) is earlier than 3 Jul (Fri), whatever the strings say');
});

test('Date objects and ISO strings produce identical figures',()=>{
  // The same rows in the two shapes the code actually receives - Date objects
  // from Postgres, ISO strings from an import - must not disagree.
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const build=asDate=>[['a','DEFERRED_RELEASED','2026-07-02T00:00:00Z',500],['a2','RELEASED','2026-07-06T00:00:00Z',500],
    ['b','RELEASED','2026-07-04T00:00:00Z',250],['c','DEFERRED','2026-07-08T00:00:00Z',125]]
    .map(([id,status,iso,amountValue])=>({source_row_id:id,transaction_id:id,order_id:'o1',category:'item_price',
      amount_description:'OurPricePrincipal',amount:amountValue,posted_date:asDate?new Date(iso):iso,
      transaction_status:status,raw:{}}));
  const base={orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],settlementRows:[]};
  const asDates=calculateDashboardMetrics({...base,financeItems:build(true)},range).statement;
  const asStrings=calculateDashboardMetrics({...base,financeItems:build(false)},range).statement;
  assert.equal(asDates.income.value,asStrings.income.value);
  assert.equal(asDates.gst.value,asStrings.gst.value);
  assert.equal(asDates.expenses.value,asStrings.expenses.value);
});
