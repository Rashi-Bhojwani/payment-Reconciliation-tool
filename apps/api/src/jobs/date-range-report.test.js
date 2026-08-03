import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCoverage, fileDigest, mapColumns, parseCsv, parseDateRangeReport, summariseDateRangeRows, toCalendarDay, toPaise } from './date-range-report.js';

// Shaped from a real 455-row "Transactions for time period" export, with the
// seller's order IDs and product titles replaced. Column names, order, date
// format and value formatting are the file's own.
const HEADER = '"Date","Transaction Status","Account Type","Transaction type","Order ID","Product Details","Total product charges","Total promotional rebates","Amazon fees","Other","Total (INR)"';
const row = (parts) => parts.map(p => `"${p}"`).join(',');
const ORDER = row(['25/7/2026', 'Released', 'Electronic Transactions (Credit Card/Net Banking/GC)', 'Order Payment', 'ORD-1', 'Widget, small', '583.9', '-33.9', '-152.22', '135.49', '533.27']);
const DEFERRED = row(['25/7/2026', 'Deferred', 'Electronic Transactions (Credit Card/Net Banking/GC)', 'Order Payment', 'ORD-2', 'Widget', '846.62', '-42.33', '-97.94', '139.93', '846.28']);
const withBom = text => `﻿${text}`;

test('parses the real export shape: BOM, CRLF, quoted commas', () => {
  const csv = withBom([HEADER, ORDER, DEFERRED].join('\r\n'));
  const result = parseDateRangeReport(csv);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].description, 'Widget, small', 'a comma inside a quoted product title is not a column break');
  assert.equal(result.rows[0].physicalRow, 2, 'physical row numbers start at the first line after the header');
  assert.equal(result.rows[1].physicalRow, 3);
  assert.deepEqual(result.errors, []);
});

test('every row balances its own stated total against its components', () => {
  const summary = summariseDateRangeRows(parseDateRangeReport(withBom([HEADER, ORDER, DEFERRED].join('\r\n'))).rows);
  assert.equal(summary.driftPaise, 0, "Amazon's stated Total equals the sum of its four component columns");
  assert.equal(summary.totals.total, 1379.55);
  assert.equal(summary.byStatus.Released.total, 533.27);
  assert.equal(summary.byStatus.Deferred.total, 846.28);
});

test('deferred rows are kept, not filtered - they are the settlement blind spot', () => {
  // On the real export the deferred rows total 28,816.89, which is the amount
  // by which settlement-derived Income fell short of that seller's statement.
  // A parser that drops them reproduces the original bug.
  const result = parseDateRangeReport(withBom([HEADER, ORDER, DEFERRED].join('\r\n')));
  assert.equal(result.rows.filter(r => r.status === 'Deferred').length, 1);
});

test('money is summed in integer paise, so it cannot drift', () => {
  assert.equal(toPaise('0.1'), 10);
  assert.equal(toPaise('0.2'), 20);
  const tenth = row(['1/7/2026', 'Released', 'x', 'Order Payment', 'O', 'd', '0.1', '0', '0', '0', '0.1']);
  const fifth = row(['1/7/2026', 'Released', 'x', 'Order Payment', 'O', 'd', '0.2', '0', '0', '0', '0.2']);
  const csv = [HEADER, ...Array.from({ length: 3 }, () => tenth), fifth].join('\n');
  const summary = summariseDateRangeRows(parseDateRangeReport(csv).rows);
  assert.equal(summary.totals.productCharges, 0.5, '0.1+0.1+0.1+0.2 must be exactly 0.50');
});

test('currency formatting Amazon actually emits', () => {
  assert.equal(toPaise('1,57,956.59'), 15795659, 'Indian grouping');
  assert.equal(toPaise('-310.14'), -31014);
  assert.equal(toPaise('(310.14)'), -31014, 'accounting parentheses');
  assert.equal(toPaise('0'), 0);
  assert.equal(toPaise(''), 0, 'a blank component is zero, not a failure');
  assert.equal(toPaise('₹ 1,234.50'), 123450);
  assert.equal(toPaise('not a number'), null, 'garbage is rejected rather than silently zeroed');
});

test('two identical rows are two transactions and both survive', () => {
  const csv = [HEADER, ORDER, ORDER].join('\n');
  const result = parseDateRangeReport(csv);
  assert.equal(result.rows.length, 2);
  assert.notEqual(result.rows[0].physicalRow, result.rows[1].physicalRow, 'identity is the physical row, not a content hash');
  assert.equal(summariseDateRangeRows(result.rows).totals.total, 1066.54);
});

test('escaped quotes and embedded newlines inside a field', () => {
  const csv = `${HEADER}\n"1/7/2026","Released","x","Order Payment","O","A 12"" widget\nsecond line","10","0","0","0","10"`;
  const result = parseDateRangeReport(csv);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].description, 'A 12" widget\nsecond line');
});

test('header name variations still map', () => {
  const { index, missing } = mapColumns(['Date', 'Status', 'Account Type', 'Type', 'Amazon Order Id', 'Description',
    'Product charges', 'Promotional rebates', 'Fees', 'Other', 'Total']);
  assert.deepEqual(missing, []);
  assert.equal(index.total, 10);
  assert.equal(index.orderId, 4);
});

test('a missing mandatory column fails the import instead of summing zeros', () => {
  const result = parseDateRangeReport('"Date","Transaction type","Other"\n"1/7/2026","Order Payment","5"');
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing required column/);
  assert.match(result.error, /productCharges/);
  assert.deepEqual(result.rows, []);
});

test('an unparseable amount is reported, and never silently becomes zero', () => {
  const bad = row(['1/7/2026', 'Released', 'x', 'Order Payment', 'O', 'd', 'abc', '0', '0', '0', '0']);
  const result = parseDateRangeReport([HEADER, ORDER, bad].join('\n'));
  assert.equal(result.ok, false, 'the import cannot be marked complete');
  assert.equal(result.rows.length, 1, 'the good row is still parsed');
  assert.equal(result.errors[0].physicalRow, 3);
  assert.equal(result.errors[0].column, 'productCharges');
});

test('dates are calendar days in the marketplace zone, never instants', () => {
  assert.equal(toCalendarDay('25/7/2026'), '2026-07-25');
  assert.equal(toCalendarDay('1/7/2026'), '2026-07-01');
  assert.equal(toCalendarDay('2026-07-25'), '2026-07-25');
  assert.equal(toCalendarDay(''), null);
  // No Date object is constructed, so no host timezone can shift the day.
  const result = parseDateRangeReport([HEADER, ORDER].join('\n'));
  assert.equal(result.rows[0].day, '2026-07-25');
});

test('the same bytes hash the same, so a re-import is recognisable', () => {
  const csv = [HEADER, ORDER].join('\n');
  assert.equal(fileDigest(csv), fileDigest(csv));
  assert.notEqual(fileDigest(csv), fileDigest(`${csv}\n${DEFERRED}`));
});

test('a bare CSV parse keeps empty trailing fields', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,,3')[1], ['1', '', '3']);
});

test('coverage never claims completeness, because a truncated export looks whole', () => {
  // Two real exports of one account: 1-25 Jul gave 455 rows, 1-30 Jul gave 313
  // - fewer rows for a longer period, short on every single overlapping day.
  // Both parsed cleanly with zero control drift, so the file cannot be trusted
  // to declare itself complete.
  const csv = [HEADER, ORDER, DEFERRED].join('\n');
  const coverage = assessCoverage(parseDateRangeReport(csv).rows, { start: '2026-07-24', end: '2026-07-26' });
  assert.equal(coverage.rowCount, 2);
  assert.equal(coverage.dayCount, 1);
  assert.equal(coverage.firstDay, '2026-07-25');
  assert.deepEqual(coverage.missingDays, ['2026-07-24', '2026-07-26']);
  assert.equal(coverage.canBeTreatedAsComplete, false, 'must never be true, whatever the file looks like');
  assert.match(coverage.whyNot, /omit rows on days it still reports/);
});

test('a full-looking export still refuses to certify itself', () => {
  const csv = [HEADER, ORDER, DEFERRED].join('\n');
  const coverage = assessCoverage(parseDateRangeReport(csv).rows, { start: '2026-07-25', end: '2026-07-25' });
  assert.deepEqual(coverage.missingDays, [], 'every requested day is present');
  assert.equal(coverage.canBeTreatedAsComplete, false, 'and it still cannot be called complete');
});
