const normalize=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const compact=value=>normalize(value).replaceAll(' ','');
const set=(...values)=>new Set(values.map(normalize));

const PRINCIPAL=set('principal','item price');
const CUSTOMER_GST=set('product tax','shipping tax','gift wrap tax','product tax gst collected','product tax gst refund','gst collected','gst refund');
const PROMOTIONS=set('promo rebates','promotional rebate','promotional rebate refund','shipping discount');
const INCOME_CREDITS=set('shipping','shipping credits','shipping refund','gift wrap','fba inventory credit');
const WITHHOLDING_TYPES=set('itemtcs','itemtds','taxwithheld');
const FEE_TYPES=set('itemfees','amazonfees','itemfeeadjustment','fbaremovalorderreturnfee','fbainventorystoragefee');
const FEE_TRANSACTIONS=set('fbafees','cancellation','fulfillmentfeerefund','servicefee','servicefeerefund');
const REIMBURSEMENT_TYPES=set('safetreimbursement','fbainventoryreimbursement');
const GENERIC_TAX_TYPES=set('taxcollected','generictax');

/** Declarative Amazon row classifier. Unknown non-zero combinations stay unclassified. */
export function classifyAccountActivityRow(row,marketplace={}){
  const marketplaceId=marketplace.marketplaceId??null;const isIndia=marketplace.marketplaceTimezone==='Asia/Kolkata'||marketplace.region==='IN';
  const transaction=compact(row.parent_transaction_type??row.transaction_type);
  const account=compact(row.account_type);
  const amountType=compact(row.amount_type);
  const description=normalize(row.amount_description??row.category);
  const compactDescription=compact(row.amount_description??row.category);
  const sign=Number(row.amount_minor??Math.round(Number(row.amount??0)*100))<0?'debit':'credit';
  const base={marketplaceId:marketplaceId??null,parentTransactionType:transaction,accountType:account,amountType,amountDescription:description,fulfillmentChannel:compact(row.fulfillment_channel),sign};
  const result=(section,component,kpi,flags={})=>({...base,section,component,kpiCategory:kpi,customerGst:false,feeGst:false,withholding:false,refund:transaction==='refund',promotion:false,reimbursement:false,transfer:false,...flags,reason:`mapping:${section}.${component}`});
  if(PRINCIPAL.has(description)) return result('income',transaction==='refund'?'product_refund':'product_sale',transaction==='refund'?'product_refund':'gross_product_sales',{refund:transaction==='refund'});
  if(PROMOTIONS.has(description)||amountType==='promotion') return result('income',transaction==='refund'?'promotion_refund':'promotion_rebate','seller_funded_promotion',{promotion:true,refund:transaction==='refund'});
  if(REIMBURSEMENT_TYPES.has(transaction)||REIMBURSEMENT_TYPES.has(amountType)||set('safe t reimbursement','reimbursement','reversal reimbursement').has(description)) return result('income','reimbursement','reimbursement',{reimbursement:true});
  if(INCOME_CREDITS.has(description)) return result('income',description.replaceAll(' ','_'),'other_income',{refund:transaction==='refund'});
  if(CUSTOMER_GST.has(description)) return result(isIndia?'gst':'tax','customer_tax','customer_tax',{customerGst:isIndia,refund:transaction==='refund'});
  if(WITHHOLDING_TYPES.has(amountType)||/^(tcs|tds)( |$)/.test(description)) return result('expenses','withholding','tcs_tds',{withholding:true});
  if(transaction==='debtadjustment'||set('payable to amazon','debt adjustment against electronic transaction credit card net banking gc accounts','debt adjustment against cod transactions and non transactional fee accounts').has(description)) return result('transfers','debt_recovery','transfer',{transfer:true});
  const feeDescription=/^(commission|selling fee|fixed closing fee|fba pick pack fee|fba weight handling fee|refund commission|amazon easy ship|easy ship shipping fee|fee adjustment|order cancellation charge|digital services fee|advertising|base fee|discount on fee|tax on fee|cgst$|sgst$|igst$)/.test(description)||set('mfnpostagepurchasecompleteigst','fbainboundtransportationfee').has(compactDescription);
  if(FEE_TYPES.has(amountType)||FEE_TRANSACTIONS.has(transaction)||feeDescription){const feeGst=/\b(cgst|sgst|igst|tax on fee)\b/.test(description);return result('expenses',feeGst?'fee_gst':'amazon_fee','operational_fee',{feeGst,refund:transaction==='refund'||transaction==='fulfillmentfeerefund'});}
  if(GENERIC_TAX_TYPES.has(amountType)) return result('tax','generic_tax','generic_tax',{refund:transaction==='refund'});
  if(set('transfer','banktransfer','failedtransfer','creditcardcharge').has(transaction)) return result('transfers','transfer','transfer',{transfer:true});
  return {...base,section:'unclassified',component:'unclassified',kpiCategory:'unclassified',customerGst:false,feeGst:false,withholding:false,refund:false,promotion:false,reimbursement:false,transfer:false,reason:'No exact classification rule matched'};
}
