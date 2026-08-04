import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDeferred, isFba, mapUnifiedColumns, parseUnifiedTransactionReport,
  sectionForOtherAmount, splitByRelease, summariseUnifiedStatement
} from './unified-transaction-report.js';

// Shaped from two real Custom Unified Transaction exports - the preamble,
// column names, column order and formatting are the files' own; every order
// id, SKU, product title, city, state and postal code is invented, and the
// amounts are small round numbers chosen so the arithmetic is checkable by eye.
const PREAMBLE = [
  '"Includes Amazon Marketplace, Fulfillment by Amazon (FBA), and Amazon Webstore transactions"',
  '"All amounts in INR, unless specified"',
  '"Definitions:"',
  '"Date/Time: Posted date/time of the transaction"',
  '"Note: Reports with start date of 1 Jan 2025 or later are indexed by posted date, include both released and deferred transactions and have two new columns."'
].join('\n');
const HEADER = '"date/time","settlement id","type","order id","Sku","description","quantity","marketplace","account type","fulfillment","order city","order state","order postal","product sales","shipping credits","gift wrap credits","promotional rebates","Total sales tax liable(GST before adjusting TCS)","TCS-CGST","TCS-SGST","TCS-IGST","TDS (Section 194-O)","selling fees","fba fees","other transaction fees","other","total","Transaction Status","Transaction Release Date"';

const row = (over = {}) => {
  const f = {
    'date/time': '1 Jul 2026 4:24:44 am UTC', 'settlement id': '1000001', type: 'Order', 'order id': 'ORD-1',
    Sku: 'SKU-1', description: 'Widget, small', quantity: '1', marketplace: 'amazon.in',
    'account type': 'Electronic Transactions (Credit Card/Net Banking/GC)', fulfillment: 'Merchant',
    'order city': 'CITY', 'order state': 'STATE', 'order postal': '000000',
    'product sales': '0', 'shipping credits': '0', 'gift wrap credits': '0', 'promotional rebates': '0',
    'sales tax': '0', 'TCS-CGST': '0', 'TCS-SGST': '0', 'TCS-IGST': '0', TDS: '0',
    'selling fees': '0', 'fba fees': '0', 'other transaction fees': '0', other: '0', total: '0',
    status: 'Released', release: '9 Jul 2026 11:19:48 pm UTC', ...over
  };
  return [f['date/time'], f['settlement id'], f.type, f['order id'], f.Sku, f.description, f.quantity,
    f.marketplace, f['account type'], f.fulfillment, f['order city'], f['order state'], f['order postal'],
    f['product sales'], f['shipping credits'], f['gift wrap credits'], f['promotional rebates'], f['sales tax'],
    f['TCS-CGST'], f['TCS-SGST'], f['TCS-IGST'], f.TDS, f['selling fees'], f['fba fees'],
    f['other transaction fees'], f.other, f.total, f.status, f.release].map(v => `"${v}"`).join(',');
};

const REPORT = [PREAMBLE, HEADER,
  row({ 'product sales': '1,000', 'sales tax': '180', 'selling fees': '-150', 'other transaction fees': '-50', 'TCS-IGST': '-5', TDS: '-1', total: '974' }),
  row({ fulfillment: 'Amazon', 'product sales': '500', 'sales tax': '90', 'fba fees': '-80', total: '510' }),
  row({ type: 'Refund', 'product sales': '-200', 'sales tax': '-36', 'selling fees': '30', total: '-206' }),
  row({ type: 'Refund', fulfillment: 'Amazon', 'product sales': '-100', 'sales tax': '-18', total: '-118' }),
  row({ 'shipping credits': '50', 'gift wrap credits': '10', 'promotional rebates': '-25', total: '35' }),
  row({ type: 'Transfer', fulfillment: '', description: 'To account ending with: 000', other: '-900', total: '-900' }),
  row({ type: 'Adjustment', fulfillment: '', description: 'Other', other: '-20', total: '-20' }),
  row({ type: 'FBA Inventory Fee', fulfillment: '', description: 'FBA Inbound Pickup Service', other: '-15', total: '-15' }),
  row({ type: 'SAFE-T Reimbursement', fulfillment: '', description: 'SAFE-T Claim ID: 000', other: '12', total: '12' }),
  row({ type: 'Adjustment', fulfillment: '', description: 'FBA Inventory Reimbursement - Customer Return', other: '8', total: '8' }),
  row({ 'product sales': '300', 'sales tax': '54', 'selling fees': '-45', total: '309', status: 'Deferred', release: '' })
].join('\r\n');

const parsed = () => parseUnifiedTransactionReport(REPORT);

test('finds the header under Amazon\'s preamble, not at a fixed offset', () => {
  const result = parsed();
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 11);
  // The preamble grows whenever Amazon adds a definition line, so an offset
  // would silently start reading the wrong row.
  assert.equal(result.rows[0].physicalRow, 7);
  assert.equal(parseUnifiedTransactionReport(`"junk"\n${HEADER}\n${row({ total: '0' })}`).ok, true);
});

test('reproduces Amazon\'s four statement sections', () => {
  // Verified on the real matched pair (MINDCIRCUS, 1-25 Jul 2026) to the
  // paisa: Income 1,32,046.97  Expenses -42,314.88  GST 23,691.75
  // Transfers -1,07,559.21.
  const s = summariseUnifiedStatement(parsed().rows);
  assert.equal(s.income, 1555);
  assert.equal(s.expenses, -336);
  assert.equal(s.gst, 270);
  assert.equal(s.transfers, -900);
  assert.equal(s.tax, 0, 'Amazon keeps a Tax section separate from GST; this report has no column for it');
});

test('the sections must reconstruct Amazon\'s own stated Total', () => {
  // This is the control that makes the mapping trustworthy rather than
  // plausible. It is exactly 0 on both real reports.
  const s = summariseUnifiedStatement(parsed().rows);
  assert.equal(s.statedTotal, 589);
  assert.equal(s.income + s.expenses + s.gst + s.transfers, 589);
  assert.equal(s.controlDrift, 0);
});

test('splits product sales by fulfilment channel, which only this report carries', () => {
  // The older "Transactions for time period" export has no fulfilment column
  // at all - its account type is COD vs Electronic, a payment rail - so the
  // statement's FBA/seller-fulfilled split cannot be derived from it.
  const { lines } = summariseUnifiedStatement(parsed().rows);
  assert.equal(lines.sellerFulfilledProductSales, 1300);
  assert.equal(lines.fbaProductSales, 500);
  assert.equal(lines.sellerFulfilledProductSaleRefunds, -200);
  assert.equal(lines.fbaProductSaleRefunds, -100);
  assert.equal(isFba({ fulfillment: 'Amazon' }), true);
  assert.equal(isFba({ fulfillment: 'Merchant' }), false);
});

test('separates each credit line from its refund line', () => {
  const { lines } = summariseUnifiedStatement(parsed().rows);
  assert.equal(lines.shippingCredits, 50);
  assert.equal(lines.shippingCreditRefunds, 0);
  assert.equal(lines.promotionalRebates, -25);
  assert.equal(lines.promotionalRebateRefunds, 0);
  assert.equal(lines.gstCollected, 324);
  assert.equal(lines.gstRefunds, -54);
});

test('routes the "other" column by Amazon\'s own type, not by sign', () => {
  // Measured on the real pair, each of these landed on a named PDF line
  // exactly: Transfer -1,07,559.21, Adjustment|Other -923.64, FBA Inventory
  // Fee -847.34, SAFE-T 196.72, FBA Inventory Reimbursement 228.53.
  assert.equal(sectionForOtherAmount({ type: 'Transfer' }).section, 'transfers');
  assert.equal(sectionForOtherAmount({ type: 'Adjustment', description: 'Other' }).section, 'expenses');
  assert.equal(sectionForOtherAmount({ type: 'FBA Inventory Fee', description: 'FBA Inbound Pickup Service' }).section, 'expenses');
  assert.equal(sectionForOtherAmount({ type: 'SAFE-T Reimbursement', description: 'SAFE-T Claim ID: 1' }).section, 'income');
  assert.equal(sectionForOtherAmount({ type: 'Adjustment', description: 'FBA Inventory Reimbursement - Customer Return' }).section, 'income');
  // A positive "other" is not automatically income, nor a negative one an expense.
  assert.equal(sectionForOtherAmount({ type: 'Transfer', description: 'x' }).section, 'transfers');
});

test('an unrecognised "other" type is still counted, and reported', () => {
  // Dropping money silently is the failure this tool exists to prevent, so an
  // unknown type is counted - but it can never quietly distort a section.
  const odd = [PREAMBLE, HEADER, row({ type: 'Some New Amazon Thing', fulfillment: '', other: '-77', total: '-77' })].join('\n');
  const s = summariseUnifiedStatement(parseUnifiedTransactionReport(odd).rows);
  assert.equal(s.expenses, -77, 'counted, not dropped');
  assert.equal(s.controlDrift, 0);
  assert.deepEqual(s.unclassified.map(u => [u.type, u.amount, u.rowCount]), [['Some New Amazon Thing', -77, 1]]);
  assert.deepEqual(summariseUnifiedStatement(parsed().rows).unclassified, [], 'the real types are all known');
});

test('deferred rows are identified and can be isolated', () => {
  // Deferred is a live population: measured on the real report it contributed
  // Income +7,152.59, Expenses -2,030.55 and GST +1,287.46, which is exactly
  // what a settlement-only figure is short by.
  const rows = parsed().rows;
  assert.equal(rows.filter(isDeferred).length, 1);
  const { released, deferred } = splitByRelease(rows);
  assert.equal(deferred.income, 300);
  assert.equal(deferred.expenses, -45);
  assert.equal(deferred.gst, 54);
  assert.equal(released.income, 1255);
  assert.equal(round(released.income + deferred.income), 1555, 'the two halves must reconstitute the whole');
});
const round = value => Math.round(value * 100) / 100;

test('a blank fulfilment is neither FBA nor seller fulfilled', () => {
  // Transfers, service fees and withholding rows carry no channel at all.
  const transfer = parsed().rows.find(r => r.type === 'Transfer');
  assert.equal(transfer.fulfillment, '');
  assert.equal(isFba(transfer), false);
  const { lines } = summariseUnifiedStatement([transfer]);
  assert.equal(lines.sellerFulfilledProductSales, 0);
});

test('money is summed in integer paise, so it cannot drift', () => {
  const tenth = over => row({ 'product sales': '0.1', total: '0.1', ...over });
  const csv = [PREAMBLE, HEADER, tenth(), tenth(), tenth(), row({ 'product sales': '0.2', total: '0.2' })].join('\n');
  const s = summariseUnifiedStatement(parseUnifiedTransactionReport(csv).rows);
  assert.equal(s.income, 0.5, '0.1+0.1+0.1+0.2 must be exactly 0.50');
  assert.equal(s.controlDrift, 0);
});

test('Indian grouping and quoted commas survive parsing', () => {
  const big = [PREAMBLE, HEADER, row({ 'product sales': '1,44,957.78', description: 'Widget, large', total: '1,44,957.78' })].join('\n');
  const result = parseUnifiedTransactionReport(big);
  assert.equal(result.rows[0].description, 'Widget, large', 'a comma in a quoted title is not a column break');
  assert.equal(summariseUnifiedStatement(result.rows).income, 144957.78);
});

test('a file that is not this report is refused, not misread', () => {
  const wrong = parseUnifiedTransactionReport('"Date","Transaction Status","Total (INR)"\n"1/7/2026","Released","5"');
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /not a Custom Unified Transaction report/);
  assert.deepEqual(wrong.rows, []);
});

test('a missing money column fails the import instead of summing zeros', () => {
  const short = parseUnifiedTransactionReport('"date/time","type","product sales"\n"1 Jul 2026","Order","5"');
  assert.equal(short.ok, false);
  assert.match(short.error, /Missing required column/);
  assert.match(short.error, /total/);
});

test('an unparseable amount is reported, never silently zeroed', () => {
  const bad = [PREAMBLE, HEADER, row({ 'product sales': 'abc', total: '0' })].join('\n');
  const result = parseUnifiedTransactionReport(bad);
  assert.equal(result.ok, false, 'the import cannot be marked complete');
  assert.equal(result.errors[0].column, 'productSales');
  assert.equal(result.errors[0].physicalRow, 7);
  assert.equal(result.rows.length, 0, 'the broken row contributes nothing');
});

test('header aliases tolerate Amazon renaming columns', () => {
  const { index, missing } = mapUnifiedColumns(['date/time', 'type', 'product sales', 'other', 'total',
    'fulfilment', 'Total sales tax liable', 'Transaction Status']);
  assert.deepEqual(missing, []);
  assert.equal(index.fulfillment, 5, 'British spelling still maps');
  assert.equal(index.salesTaxLiable, 6, 'the GST column without its parenthetical still maps');
});
