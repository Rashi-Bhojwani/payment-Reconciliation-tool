import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDashboardMetrics, inclusiveDays } from './dashboard-calculations.js';

const range={start:'2026-06-27T00:00:00Z',end:'2026-07-27T00:00:00Z'};
test('calculates refunds, promotions, quantities and partial-range DRR',()=>{
  const result=calculateDashboardMetrics({orders:[{amazon_order_id:'1',status:'Shipped'},{amazon_order_id:'2',status:'Cancelled'},{amazon_order_id:'3',status:'Replacement'}],orderItems:[{amazon_order_id:'1',sku:'a',quantity_ordered:5,item_price:1000,promotion_discount:0},{amazon_order_id:'2',sku:'b',quantity_ordered:9,item_price:900}],returns:[{order_id:'1',return_date:'2026-07-01',raw:{quantity:2}}],financeItems:[{transaction_id:'s',category:'item_price',amount_description:'Principal',amount:1000},{transaction_id:'r',category:'refund',amount_description:'Product refund',amount:-200},{transaction_id:'p',category:'promotion',amount_description:'Promotional rebate',amount:-50}]},range);
  assert.equal(result.metrics.netSales.value,750); assert.equal(result.metrics.netQty.value,3); assert.equal(result.metrics.orders.value,3); assert.equal(result.metrics.returns.value,2); assert.equal(result.metrics.drr.value,25);
});
test('nets fee reversals, excludes withholding and ignores summary duplicates',()=>{
  const result=calculateDashboardMetrics({financeItems:[{transaction_id:'1',category:'summary_amazon_fees',amount_description:'Amazon fees',amount:-150},{transaction_id:'1',category:'referral_commission',amount_description:'Selling fee',amount:-100},{transaction_id:'2',category:'other',amount_description:'Selling fee refund',amount:20},{transaction_id:'3',category:'tax',amount_description:'TDS Section 194-O',amount:-10}]},range);
  assert.equal(result.metrics.deductions.value,80); assert.equal(result.metrics.deductions.components.find(x=>x.category==='tcs_tds').amount,10);
});
test('deduplicates source rows, nets reimbursement reversals and mixed GST documents',()=>{
  const invoice={invoice_type:'b2b',order_id:'1',invoice_date:'2026-07-01',taxable_value:100,raw:{'document-type':'Invoice','gst-rate':18}};
  const result=calculateDashboardMetrics({reimbursements:[{sku:'a',reimbursement_date:'2026-07-01',reason:'Lost',amount:50},{sku:'b',reimbursement_date:'2026-07-02',reason:'Reversal',amount:-10}],gstInvoices:[invoice,{...invoice},{invoice_type:'b2c',order_id:'2',invoice_date:'2026-07-02',taxable_value:40,raw:{'document-type':'Credit Note','gst-rate':5}}]},range);
  assert.equal(result.metrics.reimbursements.value,40); assert.equal(result.metrics.gstValue.value,60);
});
test('uses successful deposit headers, not settlement activity rows',()=>{
  const result=calculateDashboardMetrics({settlementHeaders:[{settlement_id:'ok',deposit_date:'2026-07-01',total_amount:300},{settlement_id:'failed',deposit_date:'2026-07-02',total_amount:500,transaction_type:'Failed transfer'}],settlementRows:[{settlement_id:'ok',amount:999}]},range);
  assert.equal(result.metrics.settled.value,300); assert.equal(inclusiveDays('2026-07-01','2026-07-03'),2);
});
test('separates product GST from fee GST in Amazon statement sections',()=>{
  const result=calculateDashboardMetrics({financeItems:[{transaction_id:'1',category:'tax',amount_description:'Product Tax',amount:180},{transaction_id:'2',category:'other_fee',amount_description:'Fixed closing fee IGST',amount:-8.1}]},range);
  assert.equal(result.statement.gst.value,180); assert.equal(result.statement.expenses.value,-8.1); assert.equal(result.statement.tax.value,0);
});
