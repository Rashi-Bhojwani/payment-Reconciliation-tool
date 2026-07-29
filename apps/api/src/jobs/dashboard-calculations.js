const money = value => Number(value ?? 0) || 0;
const norm = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const rawValue = (raw, names) => {
  const entries = Object.entries(raw ?? {});
  for (const name of names) {
    const wanted = norm(name).replaceAll(' ', '');
    const found = entries.find(([key]) => norm(key).replaceAll(' ', '') === wanted);
    if (found && found[1] !== '') return found[1];
  }
  return undefined;
};
const quantity = row => money(row.quantity) || money(rawValue(row.raw, ['quantity', 'quantity-returned', 'quantity returned', 'return-quantity'])) || 1;
const label = row => norm(`${row.transaction_type ?? ''} ${row.amount_type ?? ''} ${row.amount_description ?? ''} ${row.category ?? ''}`);
const isSummary = row => String(row.category ?? '').startsWith('summary_');
const isWithholding = row => /\b(tcs|tds)\b/.test(label(row));
const isFee = row => /fee|commission|closing|storage|shipping label|service|advertis|chargeback|adjustment/.test(label(row)) && !/refund|reimbursement/.test(label(row));
const isFeeRefund = row => /fee.*refund|refund.*fee/.test(label(row));
const isPromotion = row => /promotion|promo rebate|discount/.test(label(row));
const isRefund = row => /refund/.test(label(row)) && !isFeeRefund(row);
const isProduct = row => /principal|item price|product charge/.test(label(row));
const isReimbursement = row => /reimburse|safe t|lost|damaged|clawback/.test(label(row));
const isGst = row => (/\bgst\b|cgst|sgst|igst|product tax|shipping tax|gift wrap tax/.test(label(row))) && !isWithholding(row) && !/fee|commission|service/.test(label(row));
const unique = (rows, key) => [...new Map(rows.map(row => [key(row), row])).values()];
const component = (category, labelText, amount, rows, operation = '+') => ({ category, label: labelText, amount, count: rows.length, operation });
const amazonDate = value => { const text=String(value??''); const match=text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/); return match?new Date(Date.UTC(+match[3],+match[2]-1,+match[1],+(match[4]??0),+(match[5]??0),+(match[6]??0))):new Date(text); };

export function inclusiveDays(start, end) {
  const first = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate());
  const exclusive = Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), new Date(end).getUTCDate());
  return Math.max(1, Math.round((exclusive - first) / 864e5));
}

export function calculateDashboardMetrics(input, range) {
  const orders = unique(input.orders ?? [], row => row.amazon_order_id);
  const validOrders = new Set(orders.filter(row => !/cancel|replacement|pending|unshipped/i.test(`${row.status ?? ''} ${JSON.stringify(row.raw ?? {})}`)).map(row => row.amazon_order_id));
  const items = unique((input.orderItems ?? []).filter(row => validOrders.has(row.amazon_order_id)), row => `${row.amazon_order_id}|${row.sku ?? ''}|${row.asin ?? ''}`);
  const finance = unique((input.financeItems ?? []).filter(row => !isSummary(row)), row => `${row.transaction_id}|${row.order_id ?? ''}|${row.sku ?? ''}|${row.category}|${row.amount_description}|${row.amount}`);
  const settlement = unique(input.settlementRows ?? [], row => `${row.settlement_id}|${row.order_id ?? ''}|${row.amount_type}|${row.amount_description}|${row.posted_date}|${row.amount}`);
  const moneyRows = finance.length ? finance : settlement;
  const productRows = moneyRows.filter(isProduct);
  const refundRows = moneyRows.filter(isRefund);
  const promotionRows = moneyRows.filter(isPromotion);
  const grossSales = productRows.filter(row => money(row.amount) > 0).reduce((sum,row)=>sum+money(row.amount),0) || items.reduce((sum,row)=>sum+money(row.item_price),0);
  const productRefunds = Math.abs(refundRows.reduce((sum,row)=>sum+Math.min(0,money(row.amount)),0));
  const promotions = Math.abs(promotionRows.reduce((sum,row)=>sum+Math.min(0,money(row.amount)),0)) || items.reduce((sum,row)=>sum+money(row.promotion_discount),0);
  const netSales = grossSales - productRefunds - promotions;
  const shippedUnits = items.reduce((sum,row)=>sum+money(row.quantity_ordered),0);
  const returnRows = unique(input.returns ?? [], row => `${row.order_id}|${row.return_date}|${row.return_reason}|${row.disposition}`);
  const returnedUnits = returnRows.reduce((sum,row)=>sum+quantity(row),0);
  const feeRows = moneyRows.filter(row => (isFee(row)||isFeeRefund(row)) && !isWithholding(row) && !isGst(row));
  const feeDebits = Math.abs(feeRows.reduce((sum,row)=>sum+Math.min(0,money(row.amount)),0));
  const feeRefunds = feeRows.reduce((sum,row)=>sum+Math.max(0,money(row.amount)),0);
  const deductions = feeDebits-feeRefunds;
  const withholdingRows = moneyRows.filter(isWithholding);
  const taxWithheld = Math.abs(withholdingRows.reduce((sum,row)=>sum+money(row.amount),0));
  let reimbursementRows = moneyRows.filter(isReimbursement);
  if (!reimbursementRows.length) reimbursementRows = unique(input.reimbursements ?? [], row => `${row.sku}|${row.reimbursement_date}|${row.reason}|${row.amount}`);
  const reimbursements = reimbursementRows.reduce((sum,row)=>sum+money(row.amount),0);
  const gstRows = unique(input.gstInvoices ?? [], row => `${row.invoice_type}|${row.order_id}|${row.invoice_date}|${row.taxable_value}|${JSON.stringify(row.raw ?? {})}`);
  const gstValue = gstRows.reduce((sum,row) => {
    const type = norm(`${rawValue(row.raw,['invoice-type','transaction-type','document-type','type']) ?? ''} ${row.invoice_type ?? ''}`);
    return sum + (/credit|refund/.test(type) ? -Math.abs(money(row.taxable_value)) : money(row.taxable_value));
  },0);
  const deposits = unique((input.settlementHeaders ?? []).filter(row => { const date=amazonDate(row.deposit_date); return row.deposit_date && !Number.isNaN(date.getTime()) && date>=new Date(range.start) && date<new Date(range.end) && !/failed/i.test(label(row)); }), row => row.settlement_id);
  const settledAmount = deposits.reduce((sum,row)=>sum+money(row.total_amount),0);
  const days = inclusiveDays(range.start,range.end);
  const netQty = shippedUnits-returnedUnits;
  const metrics = {
    netSales:{value:netSales,unit:'amount',formula:'Gross product sales − product refunds − seller-funded promotions',components:[component('gross_sales','Gross product sales',grossSales,productRows),component('product_refunds','Product refunds',-productRefunds,refundRows,'−'),component('promotions','Seller-funded promotions',-promotions,promotionRows,'−')],rows:[...productRows,...refundRows,...promotionRows]},
    netQty:{value:netQty,unit:'quantity',formula:'Shipped units − returned units; cancelled and replacement orders excluded',components:[component('shipped_units','Shipped units',shippedUnits,items),component('returned_units','Returned units',-returnedUnits,returnRows,'−')],rows:[...items,...returnRows]},
    orders:{value:orders.length,unit:'quantity',formula:'Distinct Amazon order IDs in the selected order-date range',components:[component('orders','Distinct synced orders',orders.length,orders)],rows:orders},
    returns:{value:returnedUnits,unit:'quantity',formula:'Sum of returned quantity (not return-row count)',components:[component('returned_units','Returned quantity',returnedUnits,returnRows)],rows:returnRows},
    settled:{value:settledAmount,unit:'amount',formula:'Successful settlement deposits whose deposit date is in the selected range',components:[component('bank_deposits','Successful bank deposits',settledAmount,deposits)],rows:deposits},
    deductions:{value:deductions,unit:'amount',formula:'Fee debits − fee refunds; TCS/TDS excluded',components:[component('fee_debits','Fee debits',feeDebits,feeRows.filter(r=>money(r.amount)<0)),component('fee_refunds','Fee refunds',-feeRefunds,feeRows.filter(r=>money(r.amount)>0),'−'),component('tcs_tds','TCS/TDS shown separately',taxWithheld,withholdingRows)],rows:[...feeRows,...withholdingRows]},
    reimbursements:{value:reimbursements,unit:'amount',formula:'Reimbursement credits − reimbursement reversals',components:[component('reimbursements','Net reimbursements',reimbursements,reimbursementRows)],rows:reimbursementRows},
    drr:{value:netSales/days,unit:'amount',formula:`Net Sales ÷ ${days} inclusive calendar days`,components:[component('net_sales','Net sales',netSales,[]),component('days','Inclusive calendar days',days,[])],rows:[]},
    feeImpact:{value:grossSales?deductions/grossSales*100:0,unit:'percentage',formula:'Net Amazon fees excluding TCS/TDS ÷ gross product sales × 100',components:[component('net_fees','Net Amazon fees',deductions,feeRows),component('gross_sales','Gross product sales',grossSales,productRows)],rows:[...feeRows,...productRows]},
    returnRate:{value:shippedUnits?returnedUnits/shippedUnits*100:0,unit:'percentage',formula:'Returned units ÷ shipped units × 100',components:[component('returned_units','Returned units',returnedUnits,returnRows),component('shipped_units','Shipped units',shippedUnits,items)],rows:[...returnRows,...items]},
    gstValue:{value:gstValue,unit:'amount',formula:'Sales-invoice taxable value − credit-note/refund taxable value',components:[component('gst_invoice_value','Net GST invoice taxable value',gstValue,gstRows)],rows:gstRows}
  };
  const statementGroups = { income:[], expenses:[], tax:[], transfers:deposits.map(row=>({...row,total_amount:null,amount:-Math.abs(money(row.total_amount))})), gst:[] };
  for (const row of moneyRows) {
    if (isWithholding(row)) statementGroups.expenses.push(row); else if (isFee(row)||isFeeRefund(row)) statementGroups.expenses.push(row); else if (isGst(row)) statementGroups.gst.push(row); else if (/tax/.test(label(row))) statementGroups.tax.push(row); else statementGroups.income.push(row);
  }
  const statement = Object.fromEntries(Object.entries(statementGroups).map(([key,rows])=>[key,{value:rows.reduce((sum,row)=>sum+money(row.total_amount??row.amount),0),unit:'amount',formula:key==='transfers'?'Net successful bank deposits and withdrawals':'Net persisted Amazon source lines assigned to this account-activity section',components:groupStatement(rows),rows}]));
  return { metrics, statement };
}

function groupStatement(rows) {
  const groups=new Map();
  for(const row of rows){const key=row.amount_description??row.category??row.transaction_type??'Other';const entry=groups.get(key)??{category:norm(key).replaceAll(' ','_'),label:key,amount:0,count:0};entry.amount+=money(row.total_amount??row.amount);entry.count++;groups.set(key,entry);}
  return [...groups.values()];
}
