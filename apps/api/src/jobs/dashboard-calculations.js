const num = value => value == null || value === '' ? null : Number(value);
const amount = row => Number(row?.amount ?? row?.total_amount ?? 0) || 0;
const norm = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const rawField = (raw, names) => { const entries=Object.entries(raw??{}); for(const name of names){const wanted=norm(name).replaceAll(' ','');const hit=entries.find(([key])=>norm(key).replaceAll(' ','')===wanted);if(hit&&hit[1]!==''&&hit[1]!=null)return hit[1];} };
const text = row => norm(`${row.parent_transaction_type??''} ${row.transaction_type??''} ${row.account_type??''} ${row.amount_type??''} ${row.amount_description??''} ${row.category??''}`);
const keyOf = row => row.source_row_id ?? row.id ?? `${row.transaction_id??row.settlement_id??''}|${row.order_id??''}|${row.order_item_id??row.sku??''}|${row.category??row.amount_type??''}|${row.amount_description??''}|${row.posted_date??''}|${amount(row)}`;
function dedupe(rows,key=keyOf){const seen=new Set(),included=[],duplicates=[];for(const row of rows){const keyValue=key(row);(seen.has(keyValue)?duplicates:included).push(row);seen.add(keyValue);}return{included,duplicates};}
const isSummary=row=>String(row.category??'').startsWith('summary_');
const isRefund=row=>/refund/.test(text(row));
const isPrincipal=row=>/principal|item price/.test(norm(`${row.amount_type??''} ${row.amount_description??''} ${row.category??''}`));
const isPromotion=row=>/promotion|promo rebate/.test(text(row));
const isWithholding=row=>/\b(tcs|tds)\b/.test(text(row));
const isReimbursement=row=>/reimburse|safe t|lost|damaged|clawback/.test(text(row));
const isFee=row=>/fee|commission|closing|storage|shipping label|service|advertis|chargeback|adjustment/.test(text(row))&&!isReimbursement(row)&&!isPrincipal(row)&&!isPromotion(row);
const isProductGst=row=>/product tax|shipping tax|gift wrap tax|\bgst collected|\bgst refund/.test(text(row))&&!/fee|commission|service/.test(text(row));
const isGenericTax=row=>/\btax\b/.test(text(row))&&!isProductGst(row)&&!isWithholding(row)&&!isFee(row);
const isTransfer=row=>/transfer|deposit|bank account|withdrawal/.test(text(row));
const toMinor=value=>{const s=String(value??'0').replace(/[,₹$\s]/g,'');const m=s.match(/^(-?)(\d+)(?:\.(\d{0,2}))?/);return m?(m[1]==='-'?-1:1)*(Number(m[2])*100+Number((m[3]??'').padEnd(2,'0'))):0;};
const minor=row=>row?.amount_minor!=null?Number(row.amount_minor):toMinor(row?.amount??row?.total_amount??0);
const round2=value=>Math.round(Number(value)*100)/100;
const signedSum=rows=>rows.reduce((sum,row)=>sum+minor(row),0)/100;
const component=(category,label,value,rows,operation='+')=>({category,label,amount:value,count:rows.length,operation});
const utcDate=value=>{const s=String(value??'');const m=s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/);return m?new Date(Date.UTC(+m[3],+m[2]-1,+m[1],+(m[4]??0),+(m[5]??0),+(m[6]??0))):new Date(s);};
const inRange=(value,range)=>{const d=utcDate(value);return !Number.isNaN(d.getTime())&&d>=new Date(range.start)&&d<new Date(range.end);};
const statusEligible=status=>!new Set(['cancelled','canceled','pending','unshipped','replacement']).has(norm(status).replaceAll(' ',''));
const orderItemKey=row=>rawField(row.raw,['order-item-id','orderItemId','order-item-code','amazon-order-item-id'])??row.order_item_id??row.source_row_id??row.id;
const returnKey=row=>rawField(row.raw,['return-event-id','event-id','rma-id'])??`${row.order_id??''}|${rawField(row.raw,['order-item-id','orderItemId'])??row.order_item_id??''}|${row.sku??''}|${row.return_date??''}|${row.quantity??''}`;
const financialKey=row=>`${row.transaction_id??row.settlement_id??''}|${row.order_id??''}|${rawField(row.raw,['order-item-id','orderItemId','order-item-code'])??row.order_item_id??row.sku??''}|${row.category??row.amount_type??''}|${row.amount_description??''}|${row.posted_date??''}|${amount(row)}`;
const gstKey=row=>`${rawField(row.raw,['invoice-number','invoice number','document-number','credit-note-number'])??row.document_number??row.source_row_id??row.id}|${rawField(row.raw,['line-item-id','invoice-line-id','order-item-id'])??row.line_id??row.sku??''}`;

// The settlement flat file has a small, structured vocabulary.  Rules use the
// normalized transaction type + amount type first; descriptions only refine a
// rule.  This deliberately avoids catch-all "fee", "tax" and "refund" tests.
export const ACCOUNT_ACTIVITY_RULES=Object.freeze([
  {id:'income_item_price',section:'income',transaction:/^(order|refund)$/,amountType:/^itemprice$/,description:/^(principal|shipping|gift wrap)$/},
  {id:'income_promotion',section:'income',transaction:/^(order|refund)$/,amountType:/^promotion$/,description:/^(promo rebates|shipping discount)$/},
  {id:'income_reimbursement',section:'income',transaction:/^(safetreimbursement|othertransaction)$/,amountType:/^(othertransactions|fbainventoryreimbursement)$/,description:/^(safe t reimbursement|reimbursement|reversal reimbursement|inventory reimbursement)$/},
  {id:'expense_item_fees',section:'expenses',transaction:/^(order|refund|fulfillmentfeerefund|cancellation)$/,amountType:/^(itemfees|itemfeeadjustment|amazonfees)$/},
  {id:'expense_withholding',section:'expenses',transaction:/^(order|refund|tax)$/,amountType:/^(itemtcs|itemtds|taxwithheld)$/},
  {id:'expense_fba_service',section:'expenses',transaction:/^(fbafees|othertransaction)$/,amountType:/^(fbainventorystoragefee|fbaremovalorderreturnfee|othertransaction)$/},
  {id:'expense_debt_adjustment',section:'expenses',transaction:/^debtadjustment$/,amountType:/^debtadjustment$/},
  {id:'gst_product',section:'gst',transaction:/^(order|refund)$/,amountType:/^(itemprice|promotion)$/,description:/^(product tax|shipping tax|gift wrap tax|product tax discount|shipping tax discount|gift wrap tax discount)$/},
  {id:'tax_separate',section:'tax',transaction:/^(taxcollected|taxrefund)$/,amountType:/^(tax|itemtax)$/},
]);
export function classifyAccountActivityRow(row){
  const transaction=norm(row.parent_transaction_type??row.transaction_type).replaceAll(' ','');
  const amountType=norm(row.amount_type).replaceAll(' ','');
  const description=norm(row.amount_description);
  if(!amountType){
    if(/^(principal|shipping credits|promotional rebate|promotional rebate refund|safe t reimbursement)$/.test(description)) return{section:'income',id:'legacy_explicit_income',reason:'legacy row: exact known statement label'};
    if(/^(selling fees|selling fee refunds|tcs tds withholding)$/.test(description)) return{section:'expenses',id:'legacy_explicit_expense',reason:'legacy row: exact known statement label'};
    if(/^(product tax gst collected|product tax gst refund)$/.test(description)) return{section:'gst',id:'legacy_explicit_gst',reason:'legacy row: exact known statement label'};
    if(transaction==='othertransaction'&&/^(amazon easy ship weight handling fee reversal|amazon easy ship weight handling fee reversal igst|cgst|sgst|fbainboundtransportationfee)$/.test(description)) return{section:'expenses',id:'expense_other_transaction_explicit',reason:'exact Amazon other-transaction expense label'};
  }
  for(const rule of ACCOUNT_ACTIVITY_RULES) if(rule.transaction.test(transaction)&&rule.amountType.test(amountType)&&(!rule.description||rule.description.test(description))) return{section:rule.section,id:rule.id,reason:`matched ${rule.id}: transaction=${transaction}, amountType=${amountType}, description=${description}`};
  return{section:'unmapped',id:'unmapped',reason:`no declarative rule: transaction=${transaction||'(blank)'}, amountType=${amountType||'(blank)'}, description=${description||'(blank)'}`};
}

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

  const financeAudit=dedupe((input.financeItems??[]).filter(row=>!isSummary(row)),financialKey);const settlementAudit=dedupe(input.settlementRows??[],row=>row.source_line_id??financialKey(row));
  const classifiedSettlement=settlementAudit.included.map(row=>({...row,classification:classifyAccountActivityRow(row)}));
  const unmappedRows=classifiedSettlement.filter(row=>row.classification.section==='unmapped'&&minor(row)!==0);
  const coverage=input.reportDocuments??[];
  const coverageComplete=coverage.length===0?!input.coverageRequired:(()=>{let cursor=new Date(range.start).getTime();for(const report of [...coverage].sort((a,b)=>new Date(a.data_start_time).getTime()-new Date(b.data_start_time).getTime())){const start=new Date(report.data_start_time).getTime(),end=new Date(report.data_end_time).getTime();if(start>cursor)return false;if(end>cursor)cursor=end;}return cursor>=new Date(range.end).getTime();})();
  const settlementComplete=classifiedSettlement.length>0&&unmappedRows.length===0&&coverageComplete&&(coverage.length===0||coverage.every(r=>r.data_start_time&&r.data_end_time));
  const financialRows=settlementComplete?classifiedSettlement:financeAudit.included;
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

  const headerAudit=dedupe((input.settlementHeaders??[]).filter(row=>row.deposit_date&&inRange(row.deposit_date,range)&&!/failed/.test(text(row))),row=>row.settlement_id??keyOf(row));
  const transferRows=headerAudit.included.map(row=>({...row,amount:-Math.abs(Number(row.total_amount??row.amount??0))}));const settled=Math.abs(signedSum(transferRows));

  const gstImported=(input.gstInvoices??[]).filter(row=>Object.keys(row.raw??{}).length>0&&!/synthetic|order item estimate/.test(norm(`${row.source??''} ${JSON.stringify(row.raw??{})}`)));const gstAudit=dedupe(gstImported,gstKey);
  const gstAvailable=gstAudit.included.length>0;const gstInvoiceValue=gstAvailable?gstAudit.included.reduce((sum,row)=>{const kind=norm(`${rawField(row.raw,['document-type','invoice-type','transaction-type'])??row.document_type??''}`);return sum+(/credit|refund/.test(kind)?-Math.abs(Number(row.taxable_value??0)):Number(row.taxable_value??0));},0):null;
  const statementRows=classifiedSettlement;
  const sectionRows=section=>statementRows.filter(row=>row.classification.section===section);
  const productGstRows=sectionRows('gst');const genericTaxRows=sectionRows('tax');
  const incomeRows=sectionRows('income');
  const statementExpenseRows=sectionRows('expenses');
  const gst=signedSum(productGstRows),tax=signedSum(genericTaxRows),income=signedSum(incomeRows),expenses=signedSum(statementExpenseRows),transfers=signedSum(transferRows);
  const days=inclusiveDays(range.start,range.end);const unitRate=returnedUnits==null?null:shippedUnits==null||shippedUnits===0?(returnedUnits>0?null:0):returnedUnits/shippedUnits*100;const refundValueRate=grossSales?productRefunds/grossSales*100:null;
  const diagnosticGroups=[...new Map(statementRows.map(row=>{const sign=minor(row)<0?'debit':minor(row)>0?'credit':'zero';const key=[norm(row.parent_transaction_type),norm(row.amount_type),norm(row.amount_description),sign,row.source_report_id??'legacy',row.settlement_id??'',row.classification.id].join('|');return[key,{transactionType:norm(row.parent_transaction_type),amountType:norm(row.amount_type),amountDescription:norm(row.amount_description),sign,sourceReportId:row.source_report_id??null,settlementId:row.settlement_id??null,inclusionReason:row.classification.reason,section:row.classification.section,count:statementRows.filter(r=>[norm(r.parent_transaction_type),norm(r.amount_type),norm(r.amount_description),minor(r)<0?'debit':minor(r)>0?'credit':'zero',r.source_report_id??'legacy',r.settlement_id??'',r.classification.id].join('|')===key).length,amount:signedSum(statementRows.filter(r=>[norm(r.parent_transaction_type),norm(r.amount_type),norm(r.amount_description),minor(r)<0?'debit':minor(r)>0?'credit':'zero',r.source_report_id??'legacy',r.settlement_id??'',r.classification.id].join('|')===key))}]})).values()];
  const diagnostics={sourcePolicy:{financial:`${financialSource} (${settlementComplete?'complete statement takes precedence':'settlement incomplete; Finances fallback for KPIs only'})`,accountActivity:'Settlement reports only; Finances is never added',reimbursements:financeReimbursements.length?financialSource:'Reimbursements report fallback',gst:'Imported GST B2B/B2C rows only',settled:'Settlement headers filtered by deposit_date'},requestedRange:range,reportCoverage:coverage,coverageComplete,schemaWarnings:input.schemaWarnings??[],diagnosticGroups,includedRows:financialRows.length,excludedRows:(settlementComplete?financeAudit.included.length:settlementAudit.included.length),duplicateRows:financialDuplicates.length+itemAudit.duplicates.length+returnAudit.duplicates.length+gstAudit.duplicates.length,unmappedRows:unmappedRows.map(row=>({source_row_id:row.source_row_id,source_report_id:row.source_report_id,settlement_id:row.settlement_id,amount_type:row.amount_type,amount_description:row.amount_description,amount:amount(row),reason:row.classification.reason})),unmappedAmount:signedSum(unmappedRows),categoryTotals:{grossSales,productRefunds,netPromotions,expenseDebits,expenseCredits,tcsTds,operationalFees,gst,tax,transfers}};
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
  const evidence=(value,section,rows,formula,source='Settlement report rows')=>{const status=!statementRows.length?'Unavailable':unmappedRows.length?'Does not reconcile':!coverageComplete?'Incomplete':null;return metric(value,'amount',formula,group(rows),rows,source,status==null?undefined:status);};
  const statement={income:evidence(income,'income',incomeRows,'Credits − debit magnitudes for mapped Income lines'),expenses:evidence(expenses,'expenses',statementExpenseRows,'Expense credits − expense debit magnitudes; includes TCS/TDS'),tax:evidence(tax,'tax',genericTaxRows,'Separate Amazon Tax credits − debits only'),transfers:evidence(transfers,'transfers',transferRows,'Successful transfer credits − withdrawals/deposit magnitudes by deposit date','Settlement headers'),gst:evidence(gst,'gst',productGstRows,'Product/shipping/gift-wrap GST credits − signed GST refunds')};
  for(const detail of Object.values(statement)){detail.debit=-signedSum(detail.rows.filter(r=>minor(r)<0));detail.credit=signedSum(detail.rows.filter(r=>minor(r)>0));detail.differenceMinor=unmappedRows.length?toMinor(diagnostics.unmappedAmount):0;}
  return{metrics,statement,diagnostics};
}
