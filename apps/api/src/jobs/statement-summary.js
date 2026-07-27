const SECTION_ORDER = ['Income', 'Expenses', 'Tax', 'Goods and Services Tax', 'Transfers'];

const EMPTY_LINES = Object.freeze({
  Income: ['Seller fulfilled product sales', 'Seller fulfilled product sale refunds', 'FBA product sales', 'FBA product sale refunds', 'FBA inventory credit', 'Shipping credits', 'Shipping credit refunds', 'NetCo Transaction', 'Gift wrap credits', 'Gift wrap credit refunds', 'Promotional rebates', 'Promotional rebate refunds', 'A-to-Z Guarantee claims', 'Chargebacks', 'SAFE-T Reimbursements', 'Reimbursements', 'Clawbacks', 'TDS Reimbursement', 'Amazon Shipping Reimbursement Adjustments', 'Others'],
  Expenses: ['Seller fulfilled selling fees', 'FBA selling fees', 'Selling fee refunds', 'FBA transaction fees', 'FBA transaction fee refunds', 'Other transaction fees', 'Other transaction fee refunds', 'FBA inventory and inbound services fees', 'Shipping label purchases', 'Shipping label refunds', 'Carrier shipping label adjustments', 'Service fees', 'Refund administration fees', 'Adjustments', 'Cost of Advertising', 'Refund for Advertiser', 'TCS-CGST Net', 'TCS-SGST Net', 'TCS-IGST Net', 'TDS - Section 194-O Net'],
  Tax: ['Product, shipping and gift wrap taxes collected', 'Product, shipping and gift wrap taxes refunded'],
  'Goods and Services Tax': ['GST Collected', 'GST Refunds'],
  Transfers: ['Transfers to bank account', 'Failed transfers to bank account', 'Credit card charges and debt recovery']
});

function wording(row) {
  return `${row.transaction_type ?? ''} ${row.description ?? ''} ${row.amount_field ?? ''}`.replace(/\s+/g, ' ').trim();
}

export function statementSection(row) {
  const value = wording(row).toLowerCase();
  if (/transfer|bank account|debt recovery/.test(value)) return 'Transfers';
  if (/tcs|tds|194-o/.test(value)) return 'Expenses';
  if (/gst|goods and service/.test(value)) return 'Goods and Services Tax';
  if (/product, shipping and gift wrap taxes/.test(value)) return 'Tax';
  if (/fee|advertis|adjustment|shipping label|service charge/.test(value)) return 'Expenses';
  return 'Income';
}

export function statementLabel(row, section = statementSection(row)) {
  const description = String(row.description ?? '').trim();
  const transactionType = String(row.transaction_type ?? '').trim();
  const value = `${transactionType} ${description} ${row.amount_field ?? ''}`.toLowerCase();
  if (section === 'Goods and Services Tax') return Number(row.amount ?? 0) < 0 || /refund/.test(value) ? 'GST Refunds' : 'GST Collected';
  if (section === 'Tax') return Number(row.amount ?? 0) < 0 || /refund/.test(value) ? 'Product, shipping and gift wrap taxes refunded' : 'Product, shipping and gift wrap taxes collected';
  if (section === 'Expenses' && /tcs.*cgst/.test(value)) return 'TCS-CGST Net';
  if (section === 'Expenses' && /tcs.*sgst/.test(value)) return 'TCS-SGST Net';
  if (section === 'Expenses' && /tcs.*igst/.test(value)) return 'TCS-IGST Net';
  if (section === 'Expenses' && /tds|194-o/.test(value)) return 'TDS - Section 194-O Net';
  if (description && !/^no description supplied$/i.test(description) && description.toLowerCase() !== transactionType.toLowerCase()) return description;
  return transactionType || row.amount_field || 'Others';
}

export function buildStatement(rows) {
  const lines = new Map();
  for (const section of SECTION_ORDER) {
    for (const label of EMPTY_LINES[section]) lines.set(`${section}\0${label}`, { section, label, debits: 0, credits: 0, net: 0, source_lines: 0 });
  }
  for (const row of rows) {
    const section = statementSection(row);
    const label = statementLabel(row, section);
    const key = `${section}\0${label}`;
    const target = lines.get(key) ?? { section, label, debits: 0, credits: 0, net: 0, source_lines: 0 };
    const amount = Number(row.amount ?? 0);
    target.net += amount;
    if (amount < 0) target.debits += amount;
    else target.credits += amount;
    target.source_lines += Number(row.source_lines ?? 0);
    lines.set(key, target);
  }
  const details = [...lines.values()];
  const summaries = SECTION_ORDER.map(section => ({
    section,
    debits: details.filter(row => row.section === section).reduce((sum, row) => sum + row.debits, 0),
    credits: details.filter(row => row.section === section).reduce((sum, row) => sum + row.credits, 0),
    total: details.filter(row => row.section === section).reduce((sum, row) => sum + row.net, 0)
  }));
  return { details, summaries };
}

export { SECTION_ORDER as STATEMENT_SECTION_ORDER };
