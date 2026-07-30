import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmazonAmount,
  parseAmazonDate,
  parseGstReport,
  parseReimbursementsReport,
  parseReturnsReport,
  parseSalesTrafficReport,
  parseSettlementReport
} from './report-normalization.js';

test('parses Amazon money in international, Indian, and decimal-comma formats', () => {
  assert.equal(parseAmazonAmount('₹1,23,456.78'), 123456.78);
  assert.equal(parseAmazonAmount('1.234,56'), 1234.56);
  assert.equal(parseAmazonAmount('95,00'), 95);
  assert.equal(parseAmazonAmount('(2,345.10) INR'), -2345.1);
  assert.equal(parseAmazonAmount('1,234'), 1234);
});

test('normalizes Amazon localized report dates without timezone drift', () => {
  assert.equal(parseAmazonDate('22.05.2023 10:13:06 UTC'), '2023-05-22T10:13:06.000Z');
  assert.equal(parseAmazonDate('22/05/2023', { dateOnly: true }), '2023-05-22');
  assert.equal(parseAmazonDate('22.05.2023 10:13:06 IST'), '2023-05-22T04:43:06.000Z');
});

test('separates settlement metadata from monetary rows and creates stable keys', () => {
  const content = [
    'settlement-id\tsettlement-start-date\tsettlement-end-date\tdeposit-date\ttotal-amount\tcurrency\ttransaction-type\torder-id\tamount-type\tamount-description\tamount\tposted-date-time',
    'S1\t01.07.2026 00:00:00 UTC\t15.07.2026 00:00:00 UTC\t17.07.2026 12:00:00 UTC\t1.234,56\tINR\t\t\t\t\t\t',
    'S1\t\t\t\t\tINR\tOrder\tORDER1\tItemPrice\tPrincipal\t95,00\t10.07.2026 09:10:11 UTC'
  ].join('\n');
  const parsed = parseSettlementReport(content, 'R1');
  assert.equal(parsed.statements.length, 1);
  assert.equal(parsed.statements[0].totalAmount, 1234.56);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].amount, 95);
  assert.equal(parsed.rows[0].postedDate, '2026-07-10T09:10:11.000Z');
  assert.equal(parsed.rows[0].sourceKey, parseSettlementReport(content, 'R1').rows[0].sourceKey);
});

test('maps official GST report columns and preserves invoice lines', () => {
  const content = [
    'Invoice Number\tInvoice Date\tTransaction Type\tOrder Id\tShipment Id\tShipment Item Id\tSKU\tTax Exclusive Gross\tTotal Tax Amount\tCGST Tax\tShipping CGST Tax\tSGST Tax\tIGST Tax',
    'INV-1\t12/07/2026\tShipment\tORDER1\tSHIP1\tITEM1\tSKU1\t100.00\t18.00\t8.00\t1.00\t9.00\t0',
    'CN-1\t13/07/2026\tRefund\tORDER1\tSHIP2\tITEM2\tSKU1\t40.00\t7.20\t3.60\t0\t3.60\t0'
  ].join('\n');
  const rows = parseGstReport(content, 'b2c');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].taxableValue, 100);
  assert.equal(rows[0].cgst, 9);
  assert.equal(rows[0].lineId, 'ITEM1');
  assert.equal(rows[0].taxTotal, 18);
  assert.equal(rows[1].taxableValue, -40);
  assert.equal(rows[1].taxTotal, -7.2);
  assert.notEqual(rows[0].sourceKey, rows[1].sourceKey);
});

test('maps official reimbursement amount-total and quantities', () => {
  const content = [
    'approval-date\treimbursement-id\tamazon-order-id\treason\tsku\tcurrency-unit\tamount-per-unit\tamount-total\tquantity-reimbursed-cash\tquantity-reimbursed-inventory\tquantity-reimbursed-total',
    '20/07/2026\tRMB1\tORDER1\tLost_Warehouse\tSKU1\tINR\t50,00\t100,00\t2\t0\t2'
  ].join('\n');
  const [row] = parseReimbursementsReport(content);
  assert.equal(row.amount, 100);
  assert.equal(row.amountPerUnit, 50);
  assert.equal(row.quantityCash, 2);
  assert.equal(row.reimbursementId, 'RMB1');
});

test('treats FBA customer-return report rows as received and retains Amazon status', () => {
  const content = [
    'return-date\torder-id\tsku\tasin\tquantity\tdetailed-disposition\treason\tstatus',
    '18/07/2026\tORDER1\tSKU1\tASIN1\t1\tSELLABLE\tUNWANTED_ITEM\tUnit returned to inventory',
    '19/07/2026\tORDER2\tSKU2\tASIN2\t1\tCUSTOMER_DAMAGED\tDEFECTIVE\tDamaged'
  ].join('\n');
  const rows = parseReturnsReport(content);
  assert.equal(rows[0].status, 'received');
  assert.equal(rows[0].amazonStatus, 'Unit returned to inventory');
  assert.equal(rows[1].status, 'received_not_in_hand');
});

test('keeps Sales and Traffic date aggregates separate from ASIN aggregates', () => {
  const content = JSON.stringify({
    reportSpecification: {
      reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
      dataStartTime: '2026-07-01',
      dataEndTime: '2026-07-07'
    },
    salesAndTrafficByDate: [{
      date: '2026-07-01',
      salesByDate: {
        unitsOrdered: 4,
        unitsRefunded: 1,
        orderedProductSales: { amount: 400, currencyCode: 'INR' }
      },
      trafficByDate: { sessions: 50, pageViews: 70 }
    }],
    salesAndTrafficByAsin: [{
      parentAsin: 'PARENT',
      childAsin: 'CHILD',
      sku: 'SKU1',
      salesByAsin: { unitsOrdered: 4, orderedProductSales: { amount: 400, currencyCode: 'INR' } },
      trafficByAsin: { sessions: 20, pageViews: 30, buyBoxPercentage: 98.5 }
    }]
  });
  const parsed = parseSalesTrafficReport(content);
  assert.deepEqual(parsed.daily.map(row => row.date), ['2026-07-01']);
  assert.equal(parsed.daily[0].sessions, 50);
  assert.equal(parsed.asin[0].periodStart, '2026-07-01');
  assert.equal(parsed.asin[0].childAsin, 'CHILD');
  assert.equal(parsed.asin[0].featuredOfferPercentage, 98.5);
});

test('accepts an empty Sales and Traffic document for a CANCELLED no-data report', () => {
  const parsed = parseSalesTrafficReport('', { start: '2026-07-01', end: '2026-07-02' });
  assert.deepEqual(parsed.daily, []);
  assert.deepEqual(parsed.asin, []);
  assert.equal(parsed.periodStart, '2026-07-01');
  assert.equal(parsed.periodEnd, '2026-07-02');
});
