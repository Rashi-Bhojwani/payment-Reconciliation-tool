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
const round2=value=>Math.round((Number(value)+Number.EPSILON)*100)/100;
const signedSum=rows=>round2(rows.reduce((sum,row)=>sum+amount(row),0));
const component=(category,label,value,rows,operation='+')=>({category,label,amount:value,count:rows.length,operation});
const utcDate=value=>{const s=String(value??'');const m=s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/);return m?new Date(Date.UTC(+m[3],+m[2]-1,+m[1],+(m[4]??0),+(m[5]??0),+(m[6]??0))):new Date(s);};
const inRange=(value,range)=>{const d=utcDate(value);return !Number.isNaN(d.getTime())&&d>=new Date(range.start)&&d<new Date(range.end);};
const statusEligible=status=>!new Set(['cancelled','canceled','pending','unshipped','replacement']).has(norm(status).replaceAll(' ',''));
const orderItemKey=row=>rawField(row.raw,['order-item-id','orderItemId','order-item-code','amazon-order-item-id'])??row.order_item_id??row.source_row_id??row.id;
const returnKey=row=>rawField(row.raw,['return-event-id','event-id','rma-id'])??`${row.order_id??''}|${rawField(row.raw,['order-item-id','orderItemId'])??row.order_item_id??''}|${row.sku??''}|${row.return_date??''}|${row.quantity??''}`;
const financialKey=row=>`${row.transaction_id??row.settlement_id??''}|${row.order_id??''}|${rawField(row.raw,['order-item-id','orderItemId','order-item-code'])??row.order_item_id??row.sku??''}|${row.category??row.amount_type??''}|${row.amount_description??''}|${row.posted_date??''}|${amount(row)}`;
const gstKey=row=>`${rawField(row.raw,['invoice-number','invoice number','document-number','credit-note-number'])??row.document_number??row.source_row_id??row.id}|${rawField(row.raw,['line-item-id','invoice-line-id','order-item-id'])??row.line_id??row.sku??''}`;

export function inclusiveDays(start,end){const a=new Date(start),b=new Date(end);return Math.max(1,Math.round((Date.UTC(b.getUTCFullYear(),b.getUTCMonth(),b.getUTCDate())-Date.UTC(a.getUTCFullYear(),a.getUTCMonth(),a.getUTCDate()))/864e5));}

export function calculateDashboardMetrics(input,range){
  const marketplaceRange={timeZone:'Asia/Kolkata',start:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'long'}).format(new Date(range.start)),end:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'long'}).format(new Date(range.end))};
  const orderAudit=dedupe(input.orders??[],row=>row.amazon_order_id);const eligibleOrders=orderAudit.included.filter(row=>statusEligible(row.status));const eligibleIds=new Set(eligibleOrders.map(row=>row.amazon_order_id));
  const itemAudit=dedupe((input.orderItems??[]).filter(row=>eligibleIds.has(row.amazon_order_id)),row=>orderItemKey(row)??keyOf(row));
  const returnAudit=dedupe(input.returns??[],returnKey);
  const shippedAvailable=itemAudit.included.length>0&&itemAudit.included.every(row=>num(row.quantity_ordered)!=null);
  const returnsAvailable=returnAudit.included.length>0?returnAudit.included.every(row=>num(row.quantity)!=null):true;
  const shippedUnits=shippedAvailable?itemAudit.included.reduce((s,r)=>s+num(r.quantity_ordered),0):null;
  const returnedUnits=returnsAvailable?returnAudit.included.reduce((s,r)=>s+num(r.quantity),0):null;
  const netQty=shippedUnits==null||returnedUnits==null?null:shippedUnits-returnedUnits;

  const financeAudit=dedupe((input.financeItems??[]).filter(row=>!isSummary(row)),financialKey);
  const documentBySettlement=new Map();
  for(const document of input.settlementDocuments??[]) for(const settlementId of document.settlement_ids??[]) if(!documentBySettlement.has(settlementId)) documentBySettlement.set(settlementId,document);
  const settlementChecks=(input.scopedSettlementIds??[]).map(settlementId=>{
    const document=documentBySettlement.get(settlementId);const rows=dedupe((input.settlementRows??[]).filter(row=>row.settlement_id===settlementId&&row.report_document_id===document?.report_document_id),row=>`${row.report_document_id}|${row.source_row_key}`).included;const header=(input.settlementHeaders??[]).find(row=>row.settlement_id===settlementId&&row.report_document_id===document?.report_document_id);const detailTotal=signedSum(rows.filter(row=>row.order_id||row.amount_type||row.amount_description));const controlTotal=num(header?.total_amount);const difference=controlTotal==null?null:round2(detailTotal-controlTotal);return{settlementId,reportDocumentId:document?.report_document_id??null,rowCount:rows.length,expectedRowCount:document?.row_count??null,controlTotal,detailTotal,difference,complete:Boolean(document&&header&&rows.length&&Math.abs(difference)<=0.01)};
  });
  const missingSettlementIds=settlementChecks.filter(check=>!check.complete).map(check=>check.settlementId);const settlementComplete=settlementChecks.length>0&&missingSettlementIds.length===0&&!(input.settlementSyncJobs??[]).some(job=>job.status!=='completed');
  const canonicalRows=settlementChecks.flatMap(check=>(input.settlementRows??[]).filter(row=>row.settlement_id===check.settlementId&&row.report_document_id===check.reportDocumentId&&inRange(row.posted_date,range)));
  const settlementAudit=dedupe(canonicalRows,row=>`${row.report_document_id}|${row.source_row_key}`);
  const financialRows=settlementComplete?settlementAudit.included:[];
  const financialDuplicates=settlementAudit.duplicates;
  const financialSource=settlementComplete?'Complete Amazon V2 Settlement report':'Incomplete Amazon V2 Settlement report';
  const principalRows=financialRows.filter(isPrincipal);const grossRows=principalRows.filter(row=>amount(row)>0&&!isRefund(row));const refundPrincipalRows=principalRows.filter(row=>amount(row)<0&&isRefund(row));
  const promoRows=financialRows.filter(isPromotion);const promoDebits=promoRows.filter(row=>amount(row)<0);const promoRefunds=promoRows.filter(row=>amount(row)>0);
  const grossSales=signedSum(grossRows);const productRefunds=Math.abs(signedSum(refundPrincipalRows));const netPromotions=round2(Math.abs(signedSum(promoDebits))-signedSum(promoRefunds));const netSales=round2(grossSales-productRefunds-netPromotions);

  const withholdingRows=financialRows.filter(isWithholding);const expenseRows=financialRows.filter(row=>(isFee(row)||isWithholding(row))&&!isProductGst(row)&&!isPrincipal(row));
  const expenseDebits=Math.abs(signedSum(expenseRows.filter(row=>amount(row)<0)));const expenseCredits=signedSum(expenseRows.filter(row=>amount(row)>0));const deductions=round2(expenseDebits-expenseCredits);
  const tcsTds=Math.abs(signedSum(withholdingRows));const operationalFees=round2(deductions-tcsTds);
  const settlementReimbursements=financialRows.filter(isReimbursement);const reportReimbursementAudit=dedupe(input.reimbursements??[]);
  const reimbursementRows=settlementComplete?(settlementReimbursements.length?settlementReimbursements:reportReimbursementAudit.included):[];const reimbursements=settlementComplete?signedSum(reimbursementRows):null;

  const headerAudit=dedupe((input.settlementHeaders??[]).filter(row=>row.deposit_date&&inRange(row.deposit_date,range)&&!/failed/.test(text(row))&&row.report_document_id),row=>`${row.report_document_id}|${row.settlement_id}`);
  const transferRows=headerAudit.included.map(row=>({...row,amount:-Math.abs(Number(row.total_amount??row.amount??0))}));const settled=Math.abs(signedSum(transferRows));

  const gstImported=(input.gstInvoices??[]).filter(row=>Object.keys(row.raw??{}).length>0&&!/synthetic|order item estimate/.test(norm(`${row.source??''} ${JSON.stringify(row.raw??{})}`)));const gstAudit=dedupe(gstImported,gstKey);
  const gstAvailable=gstAudit.included.length>0;const gstInvoiceValue=gstAvailable?gstAudit.included.reduce((sum,row)=>{const kind=norm(`${rawField(row.raw,['document-type','invoice-type','transaction-type'])??row.document_type??''}`);return sum+(/credit|refund/.test(kind)?-Math.abs(Number(row.taxable_value??0)):Number(row.taxable_value??0));},0):null;
  const productGstRows=financialRows.filter(isProductGst);const genericTaxRows=financialRows.filter(isGenericTax);
  const incomeRows=financialRows.filter(row=>!isFee(row)&&!isWithholding(row)&&!isProductGst(row)&&!isGenericTax(row)&&!isTransfer(row));
  const gst=settlementComplete?signedSum(productGstRows):null,tax=settlementComplete?signedSum(genericTaxRows):null,income=settlementComplete?signedSum(incomeRows):null,expenses=settlementComplete?signedSum(expenseRows):null,transfers=signedSum(transferRows);
  const days=inclusiveDays(range.start,range.end);const unitRate=returnedUnits==null?null:shippedUnits==null||shippedUnits===0?(returnedUnits>0?null:0):returnedUnits/shippedUnits*100;const refundValueRate=grossSales?productRefunds/grossSales*100:null;
  const operatingActivity=settlementComplete?round2(income+expenses+tax+gst):null;const residual=settlementComplete?round2(operatingActivity+transfers):null;
  const diagnostics={sourceComplete:settlementComplete,missingSettlementIds,settlementChecks,sourcePolicy:{accountActivity:'Complete V2 Settlement report only',netSales:'Complete V2 Settlement Principal/Promotion rows; no partial Finances substitution',deductions:'Complete V2 Settlement expense rows',reimbursements:settlementReimbursements.length?'Settlement reimbursement rows':'Reimbursements report only when complete settlement has no reimbursement category',gst:'Complete V2 Settlement product tax rows',settled:'Successful settlement headers filtered by deposit_date',gstInvoiceValue:'Genuine imported GST documents only'},includedRows:financialRows.length,excludedRows:financeAudit.included.length+((input.settlementRows??[]).length-canonicalRows.length),duplicateRows:financialDuplicates.length+itemAudit.duplicates.length+returnAudit.duplicates.length+gstAudit.duplicates.length,categoryTotals:{grossSales,productRefunds,netPromotions,expenseDebits,expenseCredits,tcsTds,operationalFees,income,expenses,gst,tax,transfers,operatingActivity,residual},quantity:{eligibleOrders:eligibleOrders.length,eligibleOrderItems:itemAudit.included.length,rowsWithQuantity:itemAudit.included.filter(row=>num(row.quantity_ordered)!=null).length,rowsMissingQuantity:itemAudit.included.filter(row=>num(row.quantity_ordered)==null).length,shippedUnits,returnedUnits}};
  const metric=(value,unit,formula,components,rows,source=financialSource,status=value==null?'Unavailable':null)=>({value,unit,formula,components,rows,source,status,range,marketplaceRange,diagnostics});
  const metrics={
    netSales:metric(settlementComplete?netSales:null,'amount','Gross product Principal sales − Refund Principal lines − net seller-funded promotions',[component('gross_sales','Gross product sales',grossSales,grossRows),component('product_refunds','Product refunds',-productRefunds,refundPrincipalRows,'−'),component('promotions','Net seller-funded promotions',-netPromotions,promoRows,'−')],[...grossRows,...refundPrincipalRows,...promoRows],financialSource,settlementComplete?null:'Incomplete source data'),
    netQty:metric(netQty,'quantity','Shipped units − physically returned units; exact cancelled, pending/unshipped, and replacement statuses excluded',[component('shipped_units','Shipped units',shippedUnits,itemAudit.included),component('returned_units','Returned units',returnedUnits==null?null:-returnedUnits,returnAudit.included,'−')],[...itemAudit.included,...returnAudit.included],'Orders + Returns',netQty==null?'Unavailable / source mismatch':null),
    orders:metric(eligibleOrders.length,'quantity','Distinct eligible Amazon order IDs by order_date; cancelled, pending/unshipped, and replacement statuses excluded',[component('eligible_orders','Eligible distinct orders',eligibleOrders.length,eligibleOrders)],eligibleOrders,'Orders API'),
    returns:metric(returnedUnits,'quantity','Sum of Amazon return quantity; no missing quantity is guessed as one',[component('returned_units','Returned quantity',returnedUnits,returnAudit.included)],returnAudit.included,'Returns report',returnedUnits==null?'Unavailable':null),
    settled:metric(settled,'amount','Absolute value of successful bank deposits with deposit_date in the selected range',[component('successful_transfers','Successful bank transfers',settled,headerAudit.included)],headerAudit.included,'Settlement headers'),
    deductions:metric(settlementComplete?deductions:null,'amount','Gross expense debits − expense refunds/credits (includes TCS/TDS)',[component('expense_debits','Gross expense debits',expenseDebits,expenseRows.filter(r=>amount(r)<0)),component('expense_credits','Expense refunds/credits',-expenseCredits,expenseRows.filter(r=>amount(r)>0),'−'),component('tcs_tds','TCS/TDS included',tcsTds,withholdingRows),component('operational_fees','Operational fees excluding TCS/TDS',operationalFees,expenseRows.filter(r=>!isWithholding(r)))],expenseRows,financialSource,settlementComplete?null:'Incomplete source data'),
    reimbursements:metric(reimbursements,'amount','Reimbursement credits − reimbursement reversals',[component('net_reimbursements','Net reimbursements',reimbursements,reimbursementRows)],reimbursementRows,settlementReimbursements.length?financialSource:'Reimbursements report',settlementComplete?null:'Incomplete source data'),
    drr:metric(settlementComplete?round2(netSales/days):null,'amount',`Net Sales ÷ ${days} calendar days derived from the half-open range`,[component('net_sales','Net Sales',netSales,[]),component('days','Calendar days',days,[])],[],financialSource,settlementComplete?null:'Incomplete source data'),
    feeImpact:metric(settlementComplete&&grossSales?operationalFees/grossSales*100:null,'percentage','Operational Amazon fees excluding TCS/TDS ÷ gross product sales × 100',[component('operational_fees','Operational fees',operationalFees,expenseRows.filter(r=>!isWithholding(r))),component('gross_sales','Gross product sales',grossSales,grossRows)],expenseRows,financialSource,settlementComplete?null:'Incomplete source data'),
    returnRate:metric(unitRate,'percentage','Physically returned units ÷ shipped units × 100',[component('returned_units','Returned units',returnedUnits,returnAudit.included),component('shipped_units','Shipped units',shippedUnits,itemAudit.included)],[...returnAudit.included,...itemAudit.included],'Orders + Returns',unitRate==null?'Unavailable / source mismatch':null),
    refundValueRate:metric(settlementComplete?refundValueRate:null,'percentage','Product refund Principal value ÷ gross product Principal sales × 100',[component('product_refunds','Product refunds',productRefunds,refundPrincipalRows),component('gross_sales','Gross product sales',grossSales,grossRows)],[...refundPrincipalRows,...grossRows],financialSource,settlementComplete?null:'Incomplete source data'),
    gstValue:metric(gstInvoiceValue,'amount','Genuine GST sales-invoice taxable value − genuine credit-note/refund taxable value',[component('net_taxable_value','Net taxable invoice value',gstInvoiceValue,gstAudit.included)],gstAudit.included,'Imported GST B2B/B2C reports',gstAvailable?null:'Unavailable')
  };
  const group=rows=>{const map=new Map();for(const row of rows){const name=row.amount_description??row.category??row.transaction_type??'Other';const old=map.get(name)??{category:norm(name).replaceAll(' ','_'),label:name,amount:0,count:0};old.amount+=amount(row);old.count++;map.set(name,old);}return[...map.values()];};
  const statementStatus=settlementComplete?null:'Incomplete source data';
  const statement={income:metric(income,'amount','Net Amazon Income statement lines',group(incomeRows),incomeRows,financialSource,statementStatus),expenses:metric(expenses,'amount','Expense debits plus expense refunds/credits; includes TCS/TDS',group(expenseRows),expenseRows,financialSource,statementStatus),tax:metric(tax,'amount','Amazon generic Tax section only',group(genericTaxRows),genericTaxRows,financialSource,statementStatus),transfers:metric(transfers,'amount','Signed successful bank transfers by deposit_date',group(transferRows),transferRows,'Settlement headers'),gst:metric(gst,'amount','Product/shipping/gift-wrap GST collected plus GST refunds',group(productGstRows),productGstRows,financialSource,statementStatus)};
  return{metrics,statement,diagnostics};
}
