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


test('uses Amazon settlement header period and date formats for transfers',()=>{
  const base={orders:[],orderItems:[],returns:[],financeItems:[],reimbursements:[],gstInvoices:[],settlementRows:[line('sale','Principal',10,'Order',{amount_type:'ItemPrice'})]};
  const withIndianDeposit=calculateDashboardMetrics({...base,settlementHeaders:[{settlement_id:'dd-mm',deposit_date:'29.07.2026 23:59 GMT+5:30',total_amount:246.63}]},{start:'2026-07-21T00:00:00Z',end:'2026-07-30T00:00:00Z'});
  assert.equal(withIndianDeposit.statement.transfers.value,-246.63);
  const withStatementPeriod=calculateDashboardMetrics({...base,settlementHeaders:[{settlement_id:'period',settlement_start_date:'27.06.2026 00:00:00 UTC',settlement_end_date:'26.07.2026 23:59:59 UTC',total_amount:131801.69}]},{start:'2026-06-27T00:00:00Z',end:'2026-07-27T00:00:00Z'});
  assert.equal(withStatementPeriod.statement.transfers.value,-131801.69);
});

test('matches a real Amazon statement by dating settlement lines to the order',()=>{
  // Live seller a3f58d33, 21-29 Jul 2026. Amazon: Income 425.70, Expenses
  // -200.37, Tax 0, GST 21.30. Five orders were placed in the window; four
  // older ones merely settled during it, and Amazon reported those weeks
  // earlier. Dating settlement lines by posted_date counted the four old
  // orders (567.60) instead of the five new ones - a different SET of orders,
  // not a different amount. loadDashboardCalculations now dates settlement
  // lines by the order, so those four fall outside the window and the
  // unsettled five come from the Finances API.
  const range={start:'2026-07-20T18:30:00Z',end:'2026-07-29T18:30:00Z'};
  const posted='2026-07-24T00:00:00Z';
  const fin=(id,order,desc,amount,category)=>({source_row_id:id,transaction_id:`tx-${id}`,order_id:order,transaction_status:'DEFERRED',category,amount_description:desc,amount,posted_date:posted,raw:{}});
  const sale=(n,order)=>[
    fin(`${n}a`,order,'OurPricePrincipal',141.9,'item_price'),
    fin(`${n}b`,order,'OurPriceTax',7.1,'tax'),
    fin(`${n}c`,order,'TCS-IGST',-0.71,'tax'),
    fin(`${n}d`,order,'FixedClosingFee Base',-1,'closing_fee'),
    fin(`${n}e`,order,'FixedClosingFee Tax',-0.18,'closing_fee'),
    fin(`${n}f`,order,'MFNPostageFee Base',-55,'other'),
    fin(`${n}g`,order,'MFNPostageFee Tax',-9.9,'tax')
  ];
  const refund=[
    fin('r1','408-6233315','OurPricePrincipal',-141.9,'item_price'),
    fin('r2','408-6233315','OurPriceTax',-7.1,'tax'),
    fin('r3','408-6233315','TCS-IGST',0.71,'tax'),
    fin('r4','408-6233315','FixedClosingFee Base',1,'closing_fee'),
    fin('r5','408-6233315','FixedClosingFee Tax',0.18,'closing_fee'),
    fin('r6','408-6233315','AmazonFees',64.9,'other')
  ];
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settledOrderIdsAllTime:['old-1'],
    // The four older orders are excluded by the SQL date filter, so they do not
    // reach the calculation at all - exactly as Amazon reports them elsewhere.
    settlementRows:[line('keep','Principal',0,'Order',{order_id:'old-1',amount_type:'ItemPrice'})],
    settlementHeaders:[{settlement_id:'s',deposit_date:'2026-07-28T00:00:00Z',total_amount:246.63}],
    financeItems:[...sale(1,'406-9335734'),...sale(2,'405-5487794'),...sale(3,'405-7211617'),...sale(4,'406-8074232'),...refund]
  },range);
  assert.equal(r.statement.income.value,425.70);
  assert.equal(r.statement.expenses.value,-200.37);
  assert.equal(r.statement.gst.value,21.30);
  assert.equal(r.statement.tax.value,0);
  assert.equal(r.statement.transfers.value,-246.63);
});

test('an order already settled is never counted twice when the Finances API also carries it',()=>{
  const range={start:'2026-07-01T00:00:00Z',end:'2026-07-30T00:00:00Z'};
  const r=calculateDashboardMetrics({
    orders:[],orderItems:[],returns:[],reimbursements:[],gstInvoices:[],settlementHeaders:[],settledOrderIdsAllTime:[],
    settlementRows:[line('s','Principal',1000,'Order',{order_id:'o1',amount_type:'ItemPrice'}),
                    line('f','Commission',-100,'Order',{order_id:'o1',amount_type:'ItemFees'})],
    financeItems:[{source_row_id:'x',transaction_id:'tx',order_id:'o1',transaction_status:'DEFERRED',category:'item_price',amount_description:'OurPricePrincipal',amount:1000,posted_date:'2026-07-10T00:00:00Z',raw:{}}]
  },range);
  assert.equal(r.statement.income.value,1000);
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
