const num = value => value == null || value === '' ? null : Number(value);
const amount = row => Number(row?.amount ?? row?.total_amount ?? 0) || 0;
// Settlement labels are already space-separated English ("Product Tax",
// "Fixed closing fee"), but Finance API breakdown labels are PascalCase with
// no separators at all ("OurPriceTax", "ItemTDS"). Splitting camelCase/
// PascalCase boundaries before the generic non-alphanumeric collapse turns
// "OurPriceTax" into "our price tax" so a word-boundary pattern like \btax\b
// can actually match "tax" as its own word - previously it normalized to
// one glued token "ourpricetax", which \btax\b (and \b(tcs|tds)\b) can never
// match in the middle of. Confirmed live: this was silently sending
// "OurPriceTax" rows on Finance-API-sourced (Deferred/pending) transactions
// past every specific classifier undetected. Already-space-separated
// settlement text is unaffected - there is no lowercase-to-uppercase
// transition inside "Product Tax" to split.
const norm = value => String(value ?? '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();
const rawField = (raw, names) => { const entries=Object.entries(raw??{}); for(const name of names){const wanted=norm(name).replaceAll(' ','');const hit=entries.find(([key])=>norm(key).replaceAll(' ','')===wanted);if(hit&&hit[1]!==''&&hit[1]!=null)return hit[1];} };
// account_type ("Cash On Delivery Transactions and Non-Transactional Fees",
// "Electronic Transactions (Credit Card/Net Banking/GC)") is a per-
// TRANSACTION payment-rail descriptor, not a per-line-item category signal -
// yet it was folded into every classifier's search text. That first COD
// label literally contains the substring "Fees", so isFee's bare "fee"
// keyword matched on it regardless of what the actual line item was.
// Confirmed live: the identical line type (e.g. "OurPriceTax") landed in
// Expenses for a COD-paid order and Income for a card-paid order - the only
// difference between the two rows was which payment rail collected the
// money, which has nothing to do with what category that specific line
// belongs in. Settlement rows never populate account_type at all, so this
// was a real, pre-existing latent bug that only started affecting real
// numbers once Finance API rows (which do populate it) started being used.
const text = row => norm(`${row.parent_transaction_type??''} ${row.transaction_type??''} ${row.amount_type??''} ${row.amount_description??''} ${row.category??''}`);
const keyOf = row => row.source_row_id ?? row.id ?? `${row.transaction_id??row.settlement_id??''}|${row.order_id??''}|${row.order_item_id??row.sku??''}|${row.category??row.amount_type??''}|${row.amount_description??''}|${row.posted_date??''}|${amount(row)}`;
function dedupe(rows,key=keyOf){const seen=new Set(),included=[],duplicates=[];for(const row of rows){const keyValue=key(row);(seen.has(keyValue)?duplicates:included).push(row);seen.add(keyValue);}return{included,duplicates};}
const isSummary=row=>String(row.category??'').startsWith('summary_');
const isRefund=row=>/refund/.test(text(row));
const isPrincipal=row=>/principal|item price/.test(norm(`${row.amount_type??''} ${row.amount_description??''} ${row.category??''}`));
const isPromotion=row=>/promotion|promo rebate/.test(text(row))&&!/product tax discount|shipping tax discount|gift wrap tax discount/.test(text(row));
// Amazon's own Transaction/Account Activity statement puts TDS Reimbursement
// and Chargebacks under Income - grouped with A-to-z Guarantee claims,
// SAFE-T Reimbursements and Clawbacks as claims-related credits/debits,
// distinct from the TCS/TDS actually withheld from a sale. Excluding
// "reimburse" matches from isWithholding, and dropping "chargeback" from
// isFee (it does not belong in either isFee's Expenses grouping or
// isReimbursement's own Reimbursements KPI - it is simply an Income line
// with no more specific category), keeps both aligned with the real
// statement sections without changing what counts as a "reimbursement".
const isWithholding=row=>/\b(tcs|tds)\b/.test(text(row))&&!/reimburse/.test(text(row));
const isReimbursement=row=>/reimburse|safe t|lost|damaged|clawback/.test(text(row));
const isFee=row=>/itemfees|itemtcs|itemtds|other transaction|fee|commission|closing|storage|shipping label|service|advertis|adjustment|easy ship charges|postagepurchase|tcs|tds/.test(text(row))&&!isReimbursement(row)&&!isPrincipal(row)&&!isPromotion(row);
// "our price tax" is the Finance API's own name (after camelCase splitting)
// for what settlement calls "Product Tax" - the tax on the item's own sale
// price, as distinct from "shipping tax"/"gift wrap tax". Without this
// alias it does not contain the literal phrase "product tax" and falls
// through to isGenericTax instead of GST, producing a phantom non-zero Tax
// figure on Deferred orders even after the camelCase-splitting fix.
const isProductGst=row=>/product tax|our price tax|shipping tax|gift wrap tax|tax discount|\bgst collected|\bgst refund/.test(text(row))&&!/fee|commission|service|itemtcs|itemtds|tcs|tds/.test(text(row));
// finance_transaction_items.category is not a raw Amazon label like
// settlement's amount_type/amount_description - it is a normalized bucket
// name from categorizeFinanceLabel() (finance-components.js), which
// deliberately collapses product tax, GST, TCS and TDS into one generic
// 'tax' string since the Finances API doesn't expose a finer split at that
// level. text() folds category in alongside the real fields for every other
// classifier, which is fine everywhere else, but here it means the bare
// bucket name alone - with no "product tax"/"tcs"/"tds" wording actually
// present - was enough to satisfy \btax\b and misclassify a merged pending
// row as generic Tax (confirmed live: this account's real Tax is always 0,
// yet merging in Finance API rows made it show non-zero). Only the row's
// own amount_type/amount_description - the actual label text, not the
// bucket it got sorted into - may trigger this specific classifier.
const isGenericTax=row=>/\btax\b/.test(norm(`${row.amount_type??''} ${row.amount_description??''}`))&&!isProductGst(row)&&!isWithholding(row)&&!isFee(row);
const isTransfer=row=>/transfer|deposit|bank account|withdrawal/.test(text(row));
const round2=value=>Math.round((Number(value)+Number.EPSILON)*100)/100;
const signedSum=rows=>round2(rows.reduce((sum,row)=>sum+amount(row),0));
const component=(category,label,value,rows,operation='+')=>({category,label,amount:value,count:rows.length,operation});
const utcDate=value=>{
  const s=String(value??'').trim();
  const m=s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(m)return new Date(Date.UTC(+m[3],+m[2]-1,+m[1],+(m[4]??0),+(m[5]??0),+(m[6]??0)));
  return new Date(s);
};
const rangeDates=range=>({start:new Date(range.start),end:new Date(range.end)});
const inRange=(value,range)=>{const d=utcDate(value);const r=rangeDates(range);return !Number.isNaN(d.getTime())&&d>=r.start&&d<r.end;};
const overlapsRange=(start,end,range)=>{const r=rangeDates(range);const a=utcDate(start),b=utcDate(end??start);return !Number.isNaN(a.getTime())&& !Number.isNaN(b.getTime()) && a<r.end && b>=r.start;};
const statusEligible=status=>!new Set(['cancelled','canceled','pending','unshipped','replacement']).has(norm(status).replaceAll(' ',''));
const orderItemKey=row=>rawField(row.raw,['order-item-id','orderItemId','order-item-code','amazon-order-item-id'])??row.order_item_id??row.source_row_id??row.id;
const returnKey=row=>rawField(row.raw,['return-event-id','event-id','rma-id'])??`${row.order_id??''}|${rawField(row.raw,['order-item-id','orderItemId'])??row.order_item_id??''}|${row.sku??''}|${row.return_date??''}|${row.quantity??''}`;
const financialKey=row=>`${row.transaction_id??row.settlement_id??''}|${row.order_id??''}|${rawField(row.raw,['order-item-id','orderItemId','order-item-code'])??row.order_item_id??row.sku??''}|${row.category??row.amount_type??''}|${row.amount_description??''}|${row.posted_date??''}|${amount(row)}`;
const gstKey=row=>`${rawField(row.raw,['invoice-number','invoice number','document-number','credit-note-number'])??row.document_number??row.source_row_id??row.id}|${rawField(row.raw,['line-item-id','invoice-line-id','order-item-id'])??row.line_id??row.sku??''}`;

export function inclusiveDays(start,end){const a=new Date(start),b=new Date(end);return Math.max(1,Math.round((Date.UTC(b.getUTCFullYear(),b.getUTCMonth(),b.getUTCDate())-Date.UTC(a.getUTCFullYear(),a.getUTCMonth(),a.getUTCDate()))/864e5));}

export function calculateDashboardMetrics(input,range){
  const orderAudit=dedupe(input.orders??[],row=>row.amazon_order_id);const eligibleOrders=orderAudit.included.filter(row=>statusEligible(row.status));const eligibleIds=new Set(eligibleOrders.map(row=>row.amazon_order_id));
  const itemAudit=dedupe((input.orderItems??[]).filter(row=>eligibleIds.has(row.amazon_order_id)),row=>orderItemKey(row)??keyOf(row));
  const returnAudit=dedupe(input.returns??[],returnKey);
  const shippedAvailable=itemAudit.included.length>0&&itemAudit.included.every(row=>num(row.quantity_ordered)!=null);
  const returnsAvailable=returnAudit.included.length>0?returnAudit.included.every(row=>num(row.quantity)!=null):true;
  const shippedUnits=shippedAvailable?itemAudit.included.reduce((s,r)=>s+num(r.quantity_ordered),0):null;
  const returnedUnits=returnsAvailable?returnAudit.included.reduce((s,r)=>s+num(r.quantity),0):null;
  const netQty=shippedUnits==null||returnedUnits==null?null:shippedUnits-returnedUnits;

  const financeAudit=dedupe((input.financeItems??[]).filter(row=>!isSummary(row)),financialKey);const settlementAudit=dedupe(input.settlementRows??[],financialKey);
  const settlementComplete=settlementAudit.included.some(row=>isPrincipal(row)||isProductGst(row)||isFee(row)||isTransfer(row))&&settlementAudit.included.some(row=>row.settlement_id||row.raw?.['settlement-id']||row.raw?.['settlement id']);
  // Amazon's own Account Activity Statement is accrual-based: it includes
  // "Deferred" transactions (recognized by Amazon, but not yet paid out) as
  // well as "Released" ones. Settlement reports are strictly cash-basis - a
  // Deferred transaction cannot appear in any settlement document, by
  // definition, since a settlement only exists once Amazon has actually
  // released the money.
  //
  // A first attempt at this (merging in any finance row whose order_id was
  // absent from settlement) caused real double-counting in production: it
  // keyed off finance_transaction_items.order_id, which is populated
  // per-line-item by a loose key-name scan and is null/inconsistent for many
  // components - so plenty of already-settled orders failed to match and got
  // counted twice. This version requires row.order_id to be the transaction-
  // level related_order_id (the same reliable identifier the working Order
  // Payments transaction ledger already uses - see loadDashboardCalculations
  // in server.js), *and* requires row.transaction_status to explicitly say
  // the transaction has not been released yet. Both signals have to agree an
  // order is genuinely still pending before it is added; either one being
  // wrong just means a real Deferred item is conservatively left out, not
  // that a settled one gets double-counted.
  //
  // "Settled" is a property of the ORDER, not of the selected window. An
  // order's settlement lines routinely post outside the range being viewed
  // (a late-June order settled in early July; a refund settled a cycle after
  // the sale) while its Finance API rows post inside it. Building the settled
  // set only from in-range settlement rows therefore says "never settled"
  // about orders that demonstrably were, and the merge then stacks their
  // Deferred money on top of settlement money already counted. settledOrder-
  // IdsAllTime is the tenant's full set of settled order IDs, unfiltered by
  // date, so an order is only ever treated as pending when Amazon has no
  // settlement line for it anywhere.
  const settledOrderIds=new Set([...(input.settledOrderIdsAllTime??[]),...settlementAudit.included.map(row=>row.order_id)].filter(Boolean));
  const pendingFinanceRows=financeAudit.included.filter(row=>row.order_id&&!settledOrderIds.has(row.order_id)&&row.transaction_status&&!/released/i.test(row.transaction_status));
  const financialRows=settlementComplete?[...settlementAudit.included,...pendingFinanceRows]:financeAudit.included;
  const financialDuplicates=settlementComplete?settlementAudit.duplicates:financeAudit.duplicates;
  const financialSource=settlementComplete?(pendingFinanceRows.length?'Amazon Settlement report + pending (Deferred) Finance API activity':'Amazon Settlement report'):'Amazon Finances API';
  const principalRows=financialRows.filter(isPrincipal);const grossRows=principalRows.filter(row=>amount(row)>0&&!isRefund(row));const refundPrincipalRows=principalRows.filter(row=>amount(row)<0&&isRefund(row));
  const promoRows=financialRows.filter(isPromotion);const promoDebits=promoRows.filter(row=>amount(row)<0);const promoRefunds=promoRows.filter(row=>amount(row)>0);
  const grossSales=signedSum(grossRows);const productRefunds=Math.abs(signedSum(refundPrincipalRows));const netPromotions=round2(Math.abs(signedSum(promoDebits))-signedSum(promoRefunds));const netSales=round2(grossSales-productRefunds-netPromotions);

  const withholdingRows=financialRows.filter(isWithholding);const expenseRows=financialRows.filter(row=>(isFee(row)||isWithholding(row))&&!isProductGst(row)&&!isPrincipal(row));
  const expenseDebits=Math.abs(signedSum(expenseRows.filter(row=>amount(row)<0)));const expenseCredits=signedSum(expenseRows.filter(row=>amount(row)>0));const deductions=round2(expenseDebits-expenseCredits);
  const tcsTds=Math.abs(signedSum(withholdingRows));const operationalFees=round2(deductions-tcsTds);
  const financeReimbursements=financialRows.filter(isReimbursement);const reportReimbursementAudit=dedupe(input.reimbursements??[]);
  const reimbursementRows=financeReimbursements.length?financeReimbursements:reportReimbursementAudit.included;const reimbursements=signedSum(reimbursementRows);

  const headerAudit=dedupe((input.settlementHeaders??[]).filter(row=>!/failed/.test(text(row))&&((row.deposit_date&&inRange(row.deposit_date,range))||overlapsRange(row.settlement_start_date,row.settlement_end_date,range))),row=>row.settlement_id??keyOf(row));
  const transferRows=headerAudit.included.map(row=>({...row,amount:-Math.abs(Number(row.total_amount??row.amount??0))}));const settled=Math.abs(signedSum(transferRows));

  const gstImported=(input.gstInvoices??[]).filter(row=>Object.keys(row.raw??{}).length>0&&!/synthetic|order item estimate/.test(norm(`${row.source??''} ${JSON.stringify(row.raw??{})}`)));const gstAudit=dedupe(gstImported,gstKey);
  const gstAvailable=gstAudit.included.length>0;const gstInvoiceValue=gstAvailable?gstAudit.included.reduce((sum,row)=>{const kind=norm(`${rawField(row.raw,['document-type','invoice-type','transaction-type'])??row.document_type??''}`);return sum+(/credit|refund/.test(kind)?-Math.abs(Number(row.taxable_value??0)):Number(row.taxable_value??0));},0):null;
  const productGstRows=financialRows.filter(isProductGst);const genericTaxRows=financialRows.filter(isGenericTax);
  const incomeRows=financialRows.filter(row=>!isFee(row)&&!isWithholding(row)&&!isProductGst(row)&&!isGenericTax(row)&&!isTransfer(row));
  const gst=signedSum(productGstRows),tax=signedSum(genericTaxRows),income=signedSum(incomeRows),expenses=signedSum(expenseRows),transfers=signedSum(transferRows);
  const days=inclusiveDays(range.start,range.end);const unitRate=returnedUnits==null?null:shippedUnits==null||shippedUnits===0?(returnedUnits>0?null:0):returnedUnits/shippedUnits*100;const refundValueRate=grossSales?productRefunds/grossSales*100:null;
  const excludedFinanceRows=settlementComplete?financeAudit.included.length-pendingFinanceRows.length:0;
  // Which bucket each merged pending row actually landed in - the merge
  // itself was proven correct (order_id + status double-check), but the
  // *classification* of a Finance API row can still differ from a
  // settlement row's, since Finance API descriptions/categories don't
  // necessarily use the same vocabulary the isFee/isProductGst/isGenericTax
  // regexes were tuned against settlement rows for (e.g. a generic "tax"
  // category that doesn't say "product tax" or "TCS/TDS" specifically).
  // Logged (not just counted) so a live mismatch is diagnosable from the
  // actual field values instead of guessed at again.
  const bucketOf=row=>isFee(row)||isWithholding(row)?'expenses':isProductGst(row)?'gst':isGenericTax(row)?'tax':isTransfer(row)?'transfer':'income';
  const pendingFinanceRowsDetail=pendingFinanceRows.map(row=>({order_id:row.order_id,transaction_status:row.transaction_status,category:row.category,amount_type:row.amount_type,amount_description:row.amount_description,amount:amount(row),bucket:bucketOf(row)}));
  // Row-by-row output proves each row is classified correctly but says nothing
  // about whether the right SET of rows was merged - and an over-merge looks
  // identical to a correct merge line by line. These aggregates separate the
  // two: bucketTotals shows exactly how much the merge adds on top of the
  // settlement baseline (directly comparable against the gap versus Amazon's
  // statement), and ordersWithMultipleTransactions flags orders whose pending
  // money arrives via more than one Finance transaction - the signature of
  // Amazon representing one order's money twice across its deferral
  // lifecycle, which no per-row check can detect.
  const bucketTotals=rows=>rows.reduce((totals,row)=>{const bucket=bucketOf(row);totals[bucket]=round2((totals[bucket]??0)+amount(row));return totals;},{});
  const pendingByOrder=new Map();
  for(const row of pendingFinanceRows){
    const entry=pendingByOrder.get(row.order_id)??{transactions:new Map(),total:0};
    entry.transactions.set(row.transaction_id,round2((entry.transactions.get(row.transaction_id)??0)+amount(row)));
    entry.total=round2(entry.total+amount(row));
    pendingByOrder.set(row.order_id,entry);
  }
  const pendingMergeSummary={
    settlementBaselineTotals:bucketTotals(settlementAudit.included),
    pendingAddedTotals:bucketTotals(pendingFinanceRows),
    pendingOrders:pendingByOrder.size,
    pendingRows:pendingFinanceRows.length,
    financeRowsInRange:financeAudit.included.length,
    settledOrderIdsKnown:settledOrderIds.size,
    ordersWithMultipleTransactions:[...pendingByOrder].filter(([,entry])=>entry.transactions.size>1).map(([orderId,entry])=>({order_id:orderId,total:entry.total,transactions:[...entry.transactions].map(([transactionId,total])=>({transaction_id:transactionId,total}))}))
  };
  const diagnostics={sourcePolicy:{financial:`${financialSource} (${settlementComplete?`settlement takes precedence, plus ${pendingFinanceRows.length} Deferred Finance API row(s) for orders with no settlement rows yet`:'settlement incomplete; Finances fallback'})`,reimbursements:financeReimbursements.length?financialSource:'Reimbursements report fallback',gst:'Imported GST B2B/B2C rows only',settled:'Settlement headers filtered by deposit_date'},includedRows:financialRows.length,excludedRows:(settlementComplete?excludedFinanceRows:settlementAudit.included.length),duplicateRows:financialDuplicates.length+itemAudit.duplicates.length+returnAudit.duplicates.length+gstAudit.duplicates.length,categoryTotals:{grossSales,productRefunds,netPromotions,expenseDebits,expenseCredits,tcsTds,operationalFees,gst,tax,transfers},pendingFinanceRowsDetail,pendingMergeSummary};
  const metric=(value,unit,formula,components,rows,source=financialSource,status=value==null?'Unavailable':null)=>({value,unit,formula,components,rows,source,status,range,diagnostics});
  const metrics={
    netSales:metric(netSales,'amount','Gross product Principal sales − Refund Principal lines − net seller-funded promotions',[component('gross_sales','Gross product sales',grossSales,grossRows),component('product_refunds','Product refunds',-productRefunds,refundPrincipalRows,'−'),component('promotions','Net seller-funded promotions',-netPromotions,promoRows,'−')],[...grossRows,...refundPrincipalRows,...promoRows]),
    netQty:metric(netQty,'quantity','Shipped units − physically returned units; exact cancelled, pending/unshipped, and replacement statuses excluded',[component('shipped_units','Shipped units',shippedUnits,itemAudit.included),component('returned_units','Returned units',returnedUnits==null?null:-returnedUnits,returnAudit.included,'−')],[...itemAudit.included,...returnAudit.included],'Orders + Returns',netQty==null?'Unavailable / source mismatch':null),
    orders:metric(eligibleOrders.length,'quantity','Distinct eligible Amazon order IDs by order_date; cancelled, pending/unshipped, and replacement statuses excluded',[component('eligible_orders','Eligible distinct orders',eligibleOrders.length,eligibleOrders)],eligibleOrders,'Orders API'),
    returns:metric(returnedUnits,'quantity','Sum of Amazon return quantity; no missing quantity is guessed as one',[component('returned_units','Returned quantity',returnedUnits,returnAudit.included)],returnAudit.included,'Returns report',returnedUnits==null?'Unavailable':null),
    settled:metric(settled,'amount','Absolute value of successful bank deposits with deposit_date in the selected range',[component('successful_transfers','Successful bank transfers',settled,headerAudit.included)],headerAudit.included,'Settlement headers'),
    deductions:metric(deductions,'amount','Gross expense debits − expense refunds/credits (includes TCS/TDS)',[component('expense_debits','Gross expense debits',expenseDebits,expenseRows.filter(r=>amount(r)<0)),component('expense_credits','Expense refunds/credits',-expenseCredits,expenseRows.filter(r=>amount(r)>0),'−'),component('tcs_tds','TCS/TDS included',tcsTds,withholdingRows),component('operational_fees','Operational fees excluding TCS/TDS',operationalFees,expenseRows.filter(r=>!isWithholding(r)))],expenseRows),
    reimbursements:metric(reimbursements,'amount','Reimbursement credits − reimbursement reversals',[component('net_reimbursements','Net reimbursements',reimbursements,reimbursementRows)],reimbursementRows,financeReimbursements.length?financialSource:'Reimbursements report'),
    drr:metric(round2(netSales/days),'amount',`Net Sales ÷ ${days} calendar days derived from the half-open range`,[component('net_sales','Net Sales',netSales,[]),component('days','Calendar days',days,[])],[]),
    feeImpact:metric(grossSales?operationalFees/grossSales*100:null,'percentage','Operational Amazon fees excluding TCS/TDS ÷ gross product sales × 100',[component('operational_fees','Operational fees',operationalFees,expenseRows.filter(r=>!isWithholding(r))),component('gross_sales','Gross product sales',grossSales,grossRows)],expenseRows),
    returnRate:metric(unitRate,'percentage','Physically returned units ÷ shipped units × 100',[component('returned_units','Returned units',returnedUnits,returnAudit.included),component('shipped_units','Shipped units',shippedUnits,itemAudit.included)],[...returnAudit.included,...itemAudit.included],'Orders + Returns',unitRate==null?'Unavailable / source mismatch':null),
    refundValueRate:metric(refundValueRate,'percentage','Product refund Principal value ÷ gross product Principal sales × 100',[component('product_refunds','Product refunds',productRefunds,refundPrincipalRows),component('gross_sales','Gross product sales',grossSales,grossRows)],[...refundPrincipalRows,...grossRows]),
    gstValue:metric(gstInvoiceValue,'amount','Genuine GST sales-invoice taxable value − genuine credit-note/refund taxable value',[component('net_taxable_value','Net taxable invoice value',gstInvoiceValue,gstAudit.included)],gstAudit.included,'Imported GST B2B/B2C reports',gstAvailable?null:'Unavailable')
  };
  const group=rows=>{const map=new Map();for(const row of rows){const name=row.amount_description??row.category??row.transaction_type??'Other';const old=map.get(name)??{category:norm(name).replaceAll(' ','_'),label:name,amount:0,count:0};old.amount+=amount(row);old.count++;map.set(name,old);}return[...map.values()];};
  const statement={income:metric(income,'amount','Net Amazon Income statement lines',group(incomeRows),incomeRows),expenses:metric(expenses,'amount','Expense debits plus expense refunds/credits; includes TCS/TDS',group(expenseRows),expenseRows),tax:metric(tax,'amount','Amazon generic Tax section only',group(genericTaxRows),genericTaxRows),transfers:metric(transfers,'amount','Signed successful bank transfers by deposit_date',group(transferRows),transferRows,'Settlement headers'),gst:metric(gst,'amount','Product/shipping/gift-wrap GST collected plus GST refunds',group(productGstRows),productGstRows)};
  return{metrics,statement,diagnostics};
}
