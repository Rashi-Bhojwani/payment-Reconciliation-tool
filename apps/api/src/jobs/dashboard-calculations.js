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
// amount_type is the settlement report's GROUP for a line, not the line
// itself: Amazon stamps "ItemPrice" on Principal, Product Tax, Shipping and
// Shipping tax alike. Including it here made every one of those count as a
// product sale, because norm("ItemPrice Product Tax") contains "item price".
// Confirmed against a real seller's statement: the dashboard reported Net
// Sales of 596.00 where Amazon's product sales were 567.60 and GST was 28.40
// - the tax was being added to the sale. Net Sales, Fee Impact, Refund Value
// Rate and DRR all read off this. Only the line's own description (or the
// normalized Finance API category) may decide that a row is a product sale.
const isPrincipal=row=>/principal|item price/.test(norm(`${row.amount_description??''} ${row.category??''}`));
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

  const financeAudit=dedupe((input.financeItems??[]).filter(row=>!isSummary(row)),financialKey);const settlementAudit=dedupe(input.settlementRows??[],financialKey);

  // Shipped units. order_items (Orders API) is the primary source, but Amazon
  // meters listOrderItems at one order per 2200ms, so on a large or freshly
  // connected account it lags the orders themselves by minutes. The previous
  // rule - EVERY item row must carry a quantity or the entire KPI reports
  // "Unavailable" - meant one order whose items had not arrived yet blanked
  // Net Qty, Return Rate and everything derived from them, on an account where
  // Amazon had already stated the quantity in the settlement report.
  //
  // Settlement lines carry Amazon's own quantity-purchased per order item, so
  // an eligible order that order_items has not reached yet is counted from
  // that instead of being discarded. Nothing is estimated or inferred: an
  // order contributes units only where Amazon itself stated a quantity, each
  // order is counted from exactly one source, and orders Amazon has given no
  // quantity for anywhere are reported as a coverage shortfall rather than
  // silently treated as zero.
  const settlementQuantity=row=>num(rawField(row.raw,['quantity-purchased','quantity purchased','quantityPurchased']));
  const unitsByOrder=new Map();
  for(const row of itemAudit.included){
    const quantity=num(row.quantity_ordered);
    if(quantity==null)continue;
    unitsByOrder.set(row.amazon_order_id,(unitsByOrder.get(row.amazon_order_id)??0)+quantity);
  }
  const settlementUnitsByOrder=new Map();
  for(const row of settlementAudit.included){
    const quantity=settlementQuantity(row);
    if(quantity==null||quantity<=0||!row.order_id||!isPrincipal(row)||isRefund(row))continue;
    settlementUnitsByOrder.set(row.order_id,(settlementUnitsByOrder.get(row.order_id)??0)+quantity);
  }
  let ordersCountedFromSettlement=0;
  for(const order of eligibleOrders){
    if(unitsByOrder.has(order.amazon_order_id))continue;
    const quantity=settlementUnitsByOrder.get(order.amazon_order_id);
    if(quantity==null)continue;
    unitsByOrder.set(order.amazon_order_id,quantity);
    ordersCountedFromSettlement+=1;
  }
  const ordersWithoutQuantity=eligibleOrders.filter(order=>!unitsByOrder.has(order.amazon_order_id)).length;
  // Returns get the same treatment as shipped units. Requiring EVERY return
  // row to carry a quantity meant a single row Amazon had not put a quantity
  // on blanked Net Qty and Return Rate outright - seen live with 9 return
  // rows where 8 had quantities, and confirmed by the KPI working on a
  // 30-day range and going Unavailable on a narrower one that happened to
  // include the incomplete row. Sum the quantities Amazon did state, and
  // report the rows it did not. Still no guessing: a row without a quantity
  // contributes nothing rather than being assumed to be one unit, and if
  // Amazon stated no quantity anywhere the figure stays honestly unavailable.
  const returnRowsWithQuantity=returnAudit.included.filter(row=>num(row.quantity)!=null);
  const returnRowsMissingQuantity=returnAudit.included.length-returnRowsWithQuantity.length;
  const shippedUnits=unitsByOrder.size?[...unitsByOrder.values()].reduce((sum,units)=>sum+units,0):null;
  const returnedUnits=!returnAudit.included.length?0
    :returnRowsWithQuantity.length?returnRowsWithQuantity.reduce((s,r)=>s+num(r.quantity),0)
    :null;
  const netQty=shippedUnits==null||returnedUnits==null?null:shippedUnits-returnedUnits;
  const unitsSource=!unitsByOrder.size?'Orders + Returns'
    :ordersCountedFromSettlement?`Orders + Returns (${ordersCountedFromSettlement} order${ordersCountedFromSettlement===1?'':'s'} counted from Amazon settlement quantity-purchased)`
    :'Orders + Returns';
  // A shortfall is stated, never hidden - but it no longer destroys the KPI.
  const unitsCoverageNote=shippedUnits==null?'Unavailable - Amazon has not returned order items or settlement quantities for this range yet'
    :ordersWithoutQuantity?`${ordersWithoutQuantity} of ${eligibleOrders.length} orders still awaiting quantity from Amazon`
    :null;
  const returnsNote=returnedUnits==null?'Unavailable - Amazon has not stated a quantity on any return in this range'
    :returnRowsMissingQuantity?`${returnRowsMissingQuantity} of ${returnAudit.included.length} returns have no quantity from Amazon yet`
    :null;
  const settlementComplete=settlementAudit.included.some(row=>isPrincipal(row)||isProductGst(row)||isFee(row)||isTransfer(row))&&settlementAudit.included.some(row=>row.settlement_id||row.raw?.['settlement-id']||row.raw?.['settlement id']);
  // Deferred (not-yet-released) Finance API activity is deliberately NOT
  // added to the statement. It was added on the theory that Amazon's Account
  // Activity Statement is accrual-based; that theory was tested against a
  // real seller's own statement PDF for 1-25 Jul 2026 and is wrong. Measured
  // against Amazon's published section totals for that period:
  //
  //                  settlement-only      merged        Amazon
  //   Income            1,22,980.13   1,53,912.04   1,32,046.97
  //   Expenses           -43,881.11    -52,429.16    -42,314.88
  //   GST                 22,059.79     27,627.53     23,691.75
  //
  // Merging Deferred activity moves EVERY bucket further from Amazon and
  // multiplies the total absolute error by 2.93x. Amazon's own Expenses
  // (-42,314.88) is *less* negative than settlement-only (-43,881.11) while
  // Deferred fees alone are -8,471.75, so the statement demonstrably does not
  // carry the bulk of Deferred activity.
  //
  // The settlement path is independently confirmed exact: hand-mapping
  // Amazon's own Income sub-lines (product sales, sale refunds, shipping
  // credits, promotional rebates, FBA inventory credit, SAFE-T) onto
  // settlement labels reproduces 1,22,980.13 to the paisa, and Amazon's
  // Transaction View "Released" product total for orders we hold settlement
  // lines for is 1,23,072.64 - exactly our settlement Principal net.
  //
  // What remains is a clean, well-characterised residual: Income is short
  // 9,066.84 and GST short 1,631.96 - a ratio of 17.999%, i.e. India's GST
  // rate, so the gap is whole order lines (principal plus its own tax) that
  // are absent from our settlement data, not a misclassification of rows we
  // already have. pendingMergeSummary below measures that gap on every render
  // without letting it corrupt the statement.
  const settledOrderIds=new Set([...(input.settledOrderIdsAllTime??[]),...settlementAudit.included.map(row=>row.order_id)].filter(Boolean));
  const pendingFinanceRows=financeAudit.included.filter(row=>row.order_id&&!settledOrderIds.has(row.order_id)&&row.transaction_status&&!/released/i.test(row.transaction_status));
  const financialRows=settlementComplete?settlementAudit.included:financeAudit.included;
  const financialDuplicates=settlementComplete?settlementAudit.duplicates:financeAudit.duplicates;
  const financialSource=settlementComplete?'Amazon Settlement report':'Amazon Finances API';
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
  // Deferred activity is measured but never added (see above). Reporting it
  // separately is what proved the merge wrong in the first place, and it is
  // the only way to tell "Amazon counts money we do not have" apart from
  // "we classify money we do have incorrectly" - the two failures look
  // identical in the totals alone. Row-by-row output shows how each pending
  // row *would* classify; the aggregates show what it *would* contribute.
  const bucketOf=row=>isFee(row)||isWithholding(row)?'expenses':isProductGst(row)?'gst':isGenericTax(row)?'tax':isTransfer(row)?'transfer':'income';
  const pendingFinanceRowsDetail=pendingFinanceRows.map(row=>({order_id:row.order_id,transaction_status:row.transaction_status,category:row.category,amount_type:row.amount_type,amount_description:row.amount_description,amount:amount(row),bucket:bucketOf(row)}));
  const bucketTotals=rows=>rows.reduce((totals,row)=>{const bucket=bucketOf(row);totals[bucket]=round2((totals[bucket]??0)+amount(row));return totals;},{});
  const pendingByOrder=new Map();
  for(const row of pendingFinanceRows){
    const entry=pendingByOrder.get(row.order_id)??{transactions:new Map(),total:0};
    entry.transactions.set(row.transaction_id,round2((entry.transactions.get(row.transaction_id)??0)+amount(row)));
    entry.total=round2(entry.total+amount(row));
    pendingByOrder.set(row.order_id,entry);
  }
  const pendingMergeSummary={
    merged:false,
    settlementBaselineTotals:bucketTotals(settlementAudit.included),
    pendingExcludedTotals:bucketTotals(pendingFinanceRows),
    pendingOrders:pendingByOrder.size,
    pendingRows:pendingFinanceRows.length,
    financeRowsInRange:financeAudit.included.length,
    settledOrderIdsKnown:settledOrderIds.size,
    ordersWithMultipleTransactions:[...pendingByOrder].filter(([,entry])=>entry.transactions.size>1).map(([orderId,entry])=>({order_id:orderId,total:entry.total,transactions:[...entry.transactions].map(([transactionId,total])=>({transaction_id:transactionId,total}))}))
  };
  const diagnostics={sourcePolicy:{financial:`${financialSource} (${settlementComplete?`settlement only; ${pendingFinanceRows.length} Deferred Finance API row(s) measured but excluded - Amazon's statement does not carry them`:'settlement incomplete; Finances fallback'})`,reimbursements:financeReimbursements.length?financialSource:'Reimbursements report fallback',gst:'Imported GST B2B/B2C rows only',settled:'Settlement headers filtered by deposit_date'},includedRows:financialRows.length,excludedRows:(settlementComplete?excludedFinanceRows:settlementAudit.included.length),duplicateRows:financialDuplicates.length+itemAudit.duplicates.length+returnAudit.duplicates.length+gstAudit.duplicates.length,categoryTotals:{grossSales,productRefunds,netPromotions,expenseDebits,expenseCredits,tcsTds,operationalFees,gst,tax,transfers},pendingFinanceRowsDetail,pendingMergeSummary,outstandingSettlementSyncs:Number(input.outstandingSettlementSyncs??0),
    // Settlements whose own lines do not add up to the total Amazon stamped on
    // the document. Empty means every settlement held is provably complete.
    settlementIntegrity:(input.settlementIntegrity??[]).map(row=>({settlement_id:row.settlement_id,row_count:Number(row.row_count),rows_total:Number(row.rows_total),header_total:Number(row.header_total),difference:round2(Number(row.rows_total)-Number(row.header_total))}))};
  const metric=(value,unit,formula,components,rows,source=financialSource,status=value==null?'Unavailable':null)=>({value,unit,formula,components,rows,source,status,range,diagnostics});
  const metrics={
    netSales:metric(netSales,'amount','Gross product Principal sales − Refund Principal lines − net seller-funded promotions',[component('gross_sales','Gross product sales',grossSales,grossRows),component('product_refunds','Product refunds',-productRefunds,refundPrincipalRows,'−'),component('promotions','Net seller-funded promotions',-netPromotions,promoRows,'−')],[...grossRows,...refundPrincipalRows,...promoRows]),
    netQty:metric(netQty,'quantity','Shipped units − physically returned units; exact cancelled, pending/unshipped, and replacement statuses excluded',[component('shipped_units','Shipped units',shippedUnits,itemAudit.included),component('returned_units','Returned units',returnedUnits==null?null:-returnedUnits,returnAudit.included,'−')],[...itemAudit.included,...returnAudit.included],unitsSource,unitsCoverageNote??returnsNote),
    orders:metric(eligibleOrders.length,'quantity','Distinct eligible Amazon order IDs by order_date; cancelled, pending/unshipped, and replacement statuses excluded',[component('eligible_orders','Eligible distinct orders',eligibleOrders.length,eligibleOrders)],eligibleOrders,'Orders API'),
    returns:metric(returnedUnits,'quantity','Sum of Amazon return quantity; no missing quantity is guessed as one',[component('returned_units','Returned quantity',returnedUnits,returnAudit.included)],returnAudit.included,'Returns report',returnsNote),
    settled:metric(settled,'amount','Absolute value of successful bank deposits with deposit_date in the selected range',[component('successful_transfers','Successful bank transfers',settled,headerAudit.included)],headerAudit.included,'Settlement headers'),
    deductions:metric(deductions,'amount','Gross expense debits − expense refunds/credits (includes TCS/TDS)',[component('expense_debits','Gross expense debits',expenseDebits,expenseRows.filter(r=>amount(r)<0)),component('expense_credits','Expense refunds/credits',-expenseCredits,expenseRows.filter(r=>amount(r)>0),'−'),component('tcs_tds','TCS/TDS included',tcsTds,withholdingRows),component('operational_fees','Operational fees excluding TCS/TDS',operationalFees,expenseRows.filter(r=>!isWithholding(r)))],expenseRows),
    reimbursements:metric(reimbursements,'amount','Reimbursement credits − reimbursement reversals',[component('net_reimbursements','Net reimbursements',reimbursements,reimbursementRows)],reimbursementRows,financeReimbursements.length?financialSource:'Reimbursements report'),
    drr:metric(round2(netSales/days),'amount',`Net Sales ÷ ${days} calendar days derived from the half-open range`,[component('net_sales','Net Sales',netSales,[]),component('days','Calendar days',days,[])],[]),
    feeImpact:metric(grossSales?operationalFees/grossSales*100:null,'percentage','Operational Amazon fees excluding TCS/TDS ÷ gross product sales × 100',[component('operational_fees','Operational fees',operationalFees,expenseRows.filter(r=>!isWithholding(r))),component('gross_sales','Gross product sales',grossSales,grossRows)],expenseRows),
    returnRate:metric(unitRate,'percentage','Physically returned units ÷ shipped units × 100',[component('returned_units','Returned units',returnedUnits,returnAudit.included),component('shipped_units','Shipped units',shippedUnits,itemAudit.included)],[...returnAudit.included,...itemAudit.included],unitsSource,unitRate==null?(unitsCoverageNote??returnsNote??'Unavailable - no shipped units to divide by'):null),
    refundValueRate:metric(refundValueRate,'percentage','Product refund Principal value ÷ gross product Principal sales × 100',[component('product_refunds','Product refunds',productRefunds,refundPrincipalRows),component('gross_sales','Gross product sales',grossSales,grossRows)],[...refundPrincipalRows,...grossRows]),
    gstValue:metric(gstInvoiceValue,'amount','Genuine GST sales-invoice taxable value − genuine credit-note/refund taxable value',[component('net_taxable_value','Net taxable invoice value',gstInvoiceValue,gstAudit.included)],gstAudit.included,'Imported GST B2B/B2C reports',gstAvailable?null:'Unavailable - GST B2B/B2C invoice reports have not been imported for this range')
  };
  const group=rows=>{const map=new Map();for(const row of rows){const name=row.amount_description??row.category??row.transaction_type??'Other';const old=map.get(name)??{category:norm(name).replaceAll(' ','_'),label:name,amount:0,count:0};old.amount+=amount(row);old.count++;map.set(name,old);}return[...map.values()];};
  const statement={income:metric(income,'amount','Net Amazon Income statement lines',group(incomeRows),incomeRows),expenses:metric(expenses,'amount','Expense debits plus expense refunds/credits; includes TCS/TDS',group(expenseRows),expenseRows),tax:metric(tax,'amount','Amazon generic Tax section only',group(genericTaxRows),genericTaxRows),transfers:metric(transfers,'amount','Signed successful bank transfers by deposit_date',group(transferRows),transferRows,'Settlement headers'),gst:metric(gst,'amount','Product/shipping/gift-wrap GST collected plus GST refunds',group(productGstRows),productGstRows)};
  return{metrics,statement,diagnostics};
}
