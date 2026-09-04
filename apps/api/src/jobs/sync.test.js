import test from 'node:test';
import assert from 'node:assert/strict';
import { assertGstInvoiceTypeMatchesContent, batchUpsert, dropRepeatedSettlements, gstInvoiceDate, isPermissionRefusal, ordinalsWithinGroup, parseDelimited, settlementBalanceErrors, withTenantSyncMutex } from './sync.js';

function fakeClient() {
  const calls = [];
  return { calls, query: async (text, params) => { calls.push({ text, params }); return { rows: [] }; } };
}

test('batchUpsert inserts every column for every row in a single statement when under the chunk size', async () => {
  const client = fakeClient();
  const imported = await batchUpsert(client, {
    table: 'widgets',
    columns: ['tenant_id', 'sku', 'amount'],
    rows: [['t1', 'sku-1', 10], ['t1', 'sku-2', 20]]
  });
  assert.equal(imported, 2);
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].text, /^insert into widgets\(tenant_id,sku,amount\) values \(\$1,\$2,\$3\),\(\$4,\$5,\$6\) on conflict do nothing$/);
  assert.deepEqual(client.calls[0].params, ['t1', 'sku-1', 10, 't1', 'sku-2', 20]);
});

test('batchUpsert returns 0 and issues no query for an empty row set', async () => {
  const client = fakeClient();
  const imported = await batchUpsert(client, { table: 'widgets', columns: ['tenant_id'], rows: [] });
  assert.equal(imported, 0);
  assert.equal(client.calls.length, 0);
});

test('batchUpsert splits rows across multiple statements once past the chunk size', async () => {
  const client = fakeClient();
  const rows = Array.from({ length: 5 }, (_, i) => [`t${i}`]);
  const imported = await batchUpsert(client, { table: 'widgets', columns: ['tenant_id'], rows, chunkSize: 2 });
  assert.equal(imported, 5);
  assert.equal(client.calls.length, 3);
  assert.equal(client.calls[0].params.length, 2);
  assert.equal(client.calls[1].params.length, 2);
  assert.equal(client.calls[2].params.length, 1);
});

test('batchUpsert builds an explicit on conflict do update clause when updateColumns is given', async () => {
  const client = fakeClient();
  await batchUpsert(client, {
    table: 'settlement_rows',
    columns: ['tenant_id', 'order_id', 'amount', 'raw'],
    conflictColumns: ['tenant_id', 'order_id'],
    updateColumns: ['amount', 'raw'],
    rows: [['t1', 'o1', 10, { a: 1 }]]
  });
  assert.match(client.calls[0].text, /on conflict \(tenant_id,order_id\) do update set amount=excluded\.amount, raw=excluded\.raw$/);
});

test('batchUpsert keeps only the latest row per conflict key within a chunk, since a single statement cannot update the same target row twice', async () => {
  const client = fakeClient();
  await batchUpsert(client, {
    table: 'inventory_snapshots',
    columns: ['tenant_id', 'sku', 'fulfillable_quantity'],
    conflictColumns: ['tenant_id', 'sku'],
    updateColumns: ['fulfillable_quantity'],
    rows: [['t1', 'sku-1', 5], ['t1', 'sku-1', 9], ['t1', 'sku-2', 3]]
  });
  assert.equal(client.calls.length, 1);
  // Two input rows share (t1, sku-1); only the later one (quantity 9) should
  // survive, alongside the unrelated sku-2 row - three input rows, two sent.
  assert.deepEqual(client.calls[0].params, ['t1', 'sku-1', 9, 't1', 'sku-2', 3]);
});

test('batchUpsert never treats two rows with a null conflict-key column as duplicates of each other, matching real unique-constraint semantics', async () => {
  const client = fakeClient();
  // Real Amazon settlement header rows all share tenant_id and a null
  // order_id/amount_type/amount_description/posted_date - only settlement_id
  // and total-amount differ. Postgres never matches NULL to NULL for
  // uniqueness, so both of these must survive into the same batch untouched.
  await batchUpsert(client, {
    table: 'settlement_rows',
    columns: ['tenant_id', 'order_id', 'amount_type', 'amount', 'settlement_id'],
    conflictColumns: ['tenant_id', 'order_id', 'amount_type', 'amount'],
    updateColumns: ['settlement_id'],
    rows: [['t1', null, null, 0, 'settlement-A'], ['t1', null, null, 0, 'settlement-B']]
  });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].params, ['t1', null, null, 0, 'settlement-A', 't1', null, null, 0, 'settlement-B']);
});

test('withTenantSyncMutex runs same-tenant calls one at a time instead of letting them race Amazon concurrently', async () => {
  const order = [];
  let inFlight = 0;
  const run = label => withTenantSyncMutex('tenant-a', async () => {
    inFlight += 1;
    assert.equal(inFlight, 1, 'a second same-tenant call started before the first finished');
    order.push(`start:${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push(`end:${label}`);
    inFlight -= 1;
  });
  await Promise.all([run('first'), run('second'), run('third')]);
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second', 'start:third', 'end:third']);
});

test('withTenantSyncMutex keeps different tenants independent', async () => {
  const order = [];
  const run = (tenantId, label) => withTenantSyncMutex(tenantId, async () => {
    order.push(`start:${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push(`end:${label}`);
  });
  await Promise.all([run('tenant-a', 'a'), run('tenant-b', 'b')]);
  // Two different tenants must be allowed to overlap - both starts happen
  // before either end, proving they ran concurrently rather than queued.
  assert.deepEqual(order.slice(0, 2).sort(), ['start:a', 'start:b']);
});

test('withTenantSyncMutex keeps queuing later calls even after an earlier one rejects', async () => {
  let secondRan = false;
  await assert.rejects(withTenantSyncMutex('tenant-c', async () => { throw new Error('boom'); }), /boom/);
  await withTenantSyncMutex('tenant-c', async () => { secondRan = true; });
  assert.equal(secondRan, true);
});

test('two byte-identical settlement lines keep separate identities', () => {
  // An order shipping two units of one SKU at one price emits two identical
  // settlement lines. Hashing their content produced one key, so the in-chunk
  // pre-merge and "on conflict do update" kept only one - and the lost line
  // took its own tax line with it, which is why a real seller's shortfall sat
  // at exactly India's 18% GST ratio.
  const line = { 'settlement-id': 'S1', 'order-id': 'o1', 'amount-type': 'ItemPrice', 'amount-description': 'Principal', amount: '141.90' };
  const rows = [{ ...line }, { ...line }, { 'settlement-id': 'S2', ...line, 'settlement-id': 'S2' }];
  const ordinals = ordinalsWithinGroup(rows, row => row['settlement-id']);
  assert.deepEqual(ordinals, [1, 2, 1]);
  // Ordinals restart per settlement document, so re-importing one immutable
  // document yields the same values regardless of what else was fetched.
  assert.notEqual(ordinals[0], ordinals[1]);
});

test('batchUpsert refuses to silently drop rows from a financial ledger', async () => {
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
  const duplicate = ['tenant', 'same-key'];
  await assert.rejects(
    () => batchUpsert(client, {
      table: 'settlement_rows',
      columns: ['tenant_id', 'source_key'],
      conflictColumns: ['tenant_id', 'source_key'],
      updateColumns: ['source_key'],
      rows: [duplicate, [...duplicate]]
    }),
    /Refusing to silently drop financial rows/
  );
  assert.equal(calls.length, 0, 'nothing may be written when rows would be lost');
  // A non-ledger table still warns rather than failing the whole sync.
  const imported = await batchUpsert(client, {
    table: 'inventory_snapshots',
    columns: ['tenant_id', 'source_key'],
    conflictColumns: ['tenant_id', 'source_key'],
    updateColumns: ['source_key'],
    rows: [duplicate, [...duplicate]]
  });
  assert.equal(imported, 1);
});

// Shaped from five real Amazon settlement documents for one seller. Those
// documents hold 1, 10, 10, 15 and 16 settlements respectively, and 13
// settlements appear in up to four of them at once, byte-for-byte identical -
// Amazon's settlement report is a rolling window, not one document per
// settlement.
const settlementDoc = (id, total, lines) => [
  { 'settlement-id': id, 'settlement-start-date': '21.07.2026 18:28:59 UTC', 'settlement-end-date': '25.07.2026 17:22:30 UTC', 'deposit-date': '27.07.2026 17:22:30 UTC', 'total-amount': total, 'transaction-type': '', 'amount': '' },
  ...lines.map(([desc, amount]) => ({ 'settlement-id': id, 'total-amount': '', 'transaction-type': 'Order', 'amount-description': desc, 'amount': amount }))
];

test('a settlement repeated by a later document in the same fetch is stored once', () => {
  // The downloader merges every document of one fetch into a single blob
  // before parsing, so an overlapping settlement arrives twice in one parse.
  const docA = settlementDoc('S1', '100.00', [['Principal', '120.00'], ['Commission', '-20.00']]);
  const docB = [...settlementDoc('S1', '100.00', [['Principal', '120.00'], ['Commission', '-20.00']]),
                ...settlementDoc('S2', '50.00', [['Principal', '50.00']])];

  const kept = dropRepeatedSettlements([...docA, ...docB]);
  assert.deepEqual(kept.map(r => r['settlement-id']), ['S1', 'S1', 'S1', 'S2', 'S2']);
  assert.deepEqual(settlementBalanceErrors(kept), [], 'each settlement now sums to what Amazon says it should');
});

test('the ordinal tiebreak is what let the duplicate through, so it must survive dedup', () => {
  // Two genuinely identical Amazon lines in ONE document must stay two rows;
  // that is why the ordinal exists. It is also why a repeated settlement got
  // different source_keys and could not be collapsed by the upsert.
  const doc = settlementDoc('S1', '20.00', [['Principal', '10.00'], ['Principal', '10.00']]);
  const kept = dropRepeatedSettlements([...doc, ...doc]);
  assert.equal(kept.length, 3, 'one header plus the two identical lines, kept once');
  const ordinals = ordinalsWithinGroup(kept, row => row['settlement-id']);
  assert.deepEqual(ordinals, [1, 2, 3], 'the two identical lines remain distinguishable');
  assert.deepEqual(settlementBalanceErrors(kept), []);
});

test("Amazon's own document total is used as the checksum on every import", () => {
  const short = settlementDoc('S1', '100.00', [['Principal', '120.00']]);
  assert.deepEqual(settlementBalanceErrors(short), [
    { settlement_id: 'S1', header_total: 100, rows_total: 120, difference: 20 }
  ]);
  const exact = settlementDoc('S1', '100.00', [['Principal', '120.00'], ['Commission', '-20.00']]);
  assert.deepEqual(settlementBalanceErrors(exact), []);
});

test('a money row with no transaction-type is not mistaken for the header', () => {
  // Real settlements carry FBAInboundTransportationFee and its CGST/SGST with
  // the transaction-type column empty. Treating "blank transaction-type" as
  // the header read their empty total-amount as 0 - number('') is 0, not null
  // - and reported a balanced settlement as broken by its full value.
  const doc = [
    { 'settlement-id': 'S1', 'total-amount': '5205.50', 'transaction-type': '', 'amount': '' },
    { 'settlement-id': 'S1', 'total-amount': '', 'transaction-type': '', 'amount-description': 'FBAInboundTransportationFee', 'amount': '-718.08' },
    { 'settlement-id': 'S1', 'total-amount': '', 'transaction-type': '', 'amount-description': 'CGST', 'amount': '-64.63' },
    { 'settlement-id': 'S1', 'total-amount': '', 'transaction-type': '', 'amount-description': 'SGST', 'amount': '-64.63' },
    { 'settlement-id': 'S1', 'total-amount': '', 'transaction-type': 'Order', 'amount-description': 'Principal', 'amount': '6052.84' }
  ];
  assert.deepEqual(settlementBalanceErrors(doc), []);
});

test('settlements that were never repeated are left exactly as they came', () => {
  const doc = [...settlementDoc('S1', '10.00', [['Principal', '10.00']]),
               ...settlementDoc('S2', '20.00', [['Principal', '20.00']])];
  assert.deepEqual(dropRepeatedSettlements(doc), doc);
});

// A real Merchant Tax Report downloaded directly from Seller Central (Manage
// Taxes > GST Monthly Reports) came back as RFC4180 CSV, not the tab-only
// format every API-fetched report has always used - comma-delimited,
// double-quote-wrapped fields, embedded commas inside a quoted field. The
// old naive split('\t') found zero tabs in the whole document, so the header
// line collapsed into one bogus column and every real field (order id,
// invoice date, every tax amount) silently came back undefined/0 instead of
// erroring. These lock in the fix against exactly that shape.
test('parseDelimited reads a real Seller Central GST CSV export with quoted, comma-containing fields', () => {
  const csv = '"Order Id","Item Description","Igst Tax"\n' +
    '"171-9245913-1713967","Golden Bird, Resin Statue, 3-pack","216.61"\n';
  const rows = parseDelimited(csv);
  assert.deepEqual(rows, [{ 'Order Id': '171-9245913-1713967', 'Item Description': 'Golden Bird, Resin Statue, 3-pack', 'Igst Tax': '216.61' }]);
});

test('parseDelimited handles an escaped literal quote ("" inside a quoted field) as one literal quote character', () => {
  const csv = '"Sku","Item Description"\n"SKU1","12"" Wall Clock"\n';
  const rows = parseDelimited(csv);
  assert.equal(rows[0]['Item Description'], '12" Wall Clock');
});

test('parseDelimited still reads a real tab-delimited API settlement report unchanged', () => {
  const tsv = 'settlement-id\ttotal-amount\tamount\nS1\t100.00\t100.00\n';
  const rows = parseDelimited(tsv);
  assert.deepEqual(rows, [{ 'settlement-id': 'S1', 'total-amount': '100.00', amount: '100.00' }]);
});

test('parseDelimited skips a trailing blank line without producing a phantom empty row', () => {
  const csv = '"a","b"\n"1","2"\n\n';
  const rows = parseDelimited(csv);
  assert.equal(rows.length, 1);
});

test('parseDelimited returns nothing for empty content', () => {
  assert.deepEqual(parseDelimited(''), []);
  assert.deepEqual(parseDelimited('   '), []);
});

// A B2B invoice legally requires the buyer's GSTIN; a B2C (consumer) one
// never has one - confirmed against a real Seller Central B2B download,
// where every row carried a populated Customer Bill To Gstid. This is the
// only thing standing between an admin clicking the wrong Upload button and
// silently mislabeling a whole file's invoice_type.
test('assertGstInvoiceTypeMatchesContent rejects a B2C-shaped file (no buyer GSTIN) uploaded as B2B', () => {
  const rows = [{ 'Customer Bill To Gstid': '', 'Order Id': '1' }, { 'Customer Bill To Gstid': '', 'Order Id': '2' }];
  assert.throws(() => assertGstInvoiceTypeMatchesContent(rows, 'b2b'), /looks like a B2C file/);
});

test('assertGstInvoiceTypeMatchesContent rejects a B2B-shaped file (every row has a buyer GSTIN) uploaded as B2C', () => {
  const rows = [{ 'Customer Bill To Gstid': '29BRMPR5033G2ZE', 'Order Id': '1' }, { 'Customer Bill To Gstid': '19ADAPA7979H1ZA', 'Order Id': '2' }];
  assert.throws(() => assertGstInvoiceTypeMatchesContent(rows, 'b2c'), /looks like a B2B file/);
});

test('assertGstInvoiceTypeMatchesContent passes a correctly matched B2B file', () => {
  const rows = [{ 'Customer Bill To Gstid': '29BRMPR5033G2ZE', 'Order Id': '1' }];
  assert.doesNotThrow(() => assertGstInvoiceTypeMatchesContent(rows, 'b2b'));
});

test('assertGstInvoiceTypeMatchesContent passes a correctly matched B2C file', () => {
  const rows = [{ 'Customer Bill To Gstid': '', 'Order Id': '1' }];
  assert.doesNotThrow(() => assertGstInvoiceTypeMatchesContent(rows, 'b2c'));
});

test('assertGstInvoiceTypeMatchesContent never fires when the file has no GSTID column at all - an unfamiliar shape is not evidence of anything', () => {
  const rows = [{ 'Order Id': '1', Sku: 'ABC' }];
  assert.doesNotThrow(() => assertGstInvoiceTypeMatchesContent(rows, 'b2b'));
  assert.doesNotThrow(() => assertGstInvoiceTypeMatchesContent(rows, 'b2c'));
});

// The rule these lock in: a report Amazon refused is never reported as a
// success. A seller looking at a green COMPLETED pill above Amazon's own 403
// concluded the sync had worked and the data did not exist - it cost real time
// to unpick, and a completed row also stops the automatic sync retrying the
// report after the permission is actually fixed.
test('a permission refusal is recognised however Amazon and the client word it', () => {
  const refusals = [
    // The exact string a live account saw, wrapped by this repo's SP-API client.
    'Create report failed: 403 - Amazon says: Unauthorized: Access to the resource is forbidden - GET_GST_MTR_B2B_CUSTOM requires the "Tax Invoicing" role on the SP-API application (granted in Developer Central, not in Seller Central).',
    'SP-API 403: Access to requested resource is denied',
    'Unauthorized',
    'Request failed with status code 401',
    'Access to the resource is denied'
  ];
  for (const message of refusals) {
    assert.equal(isPermissionRefusal(message), true, `should be treated as a refusal: ${message.slice(0, 60)}`);
  }
});

test('an ordinary empty or failed report is NOT treated as a permission refusal', () => {
  // These must keep their existing behaviour. "No data" in particular is a
  // correct, finished answer and has always earned a green pill; misreading it
  // as a refusal would turn every quiet period into a false alarm.
  const notRefusals = [
    'No completed GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 report is available for this range yet',
    'Report CANCELLED by Amazon',
    'no data',
    'Rate limit exceeded: 429',
    'fetch failed',
    'Report processing FATAL',
    '',
    null,
    undefined
  ];
  for (const message of notRefusals) {
    assert.equal(isPermissionRefusal(message), false, `should NOT be treated as a refusal: ${String(message).slice(0, 60)}`);
  }
});

test('a 403 inside an unrelated number does not read as a refusal', () => {
  // Word-bounded on purpose: an order id or a row count containing 403 is not
  // a status code.
  assert.equal(isPermissionRefusal('Imported 4030 rows for order 403-2036854-8535523'), false);
  assert.equal(isPermissionRefusal('HTTP 403'), true);
});

// A live account imported 1,274 GST rows and the dashboard still said "No
// invoices yet" - both true at once, because every page that shows GST filters
// by date and these rows had none Postgres could place correctly.
test('an Indian DD-MM-YYYY invoice date is normalised, not handed to Postgres raw', () => {
  // 04-08-2026 is 4 August. Passed through as-is, Postgres reads it as 8 April
  // under the default MDY DateStyle - four months from where it belongs, and
  // invisible on every range that should contain it.
  assert.equal(gstInvoiceDate({ 'invoice-date': '04-08-2026' }), '2026-08-04');
  // And this one is not a date at all under MDY: month 14. It fails the whole
  // import rather than one row.
  assert.equal(gstInvoiceDate({ 'invoice-date': '14-07-2026' }), '2026-07-14');
  assert.equal(gstInvoiceDate({ 'Invoice Date': '9.8.2026' }), '2026-08-09');
});

test('an ISO date is left exactly as it is', () => {
  // Amazon's own API may well send ISO. Normalising must not damage it.
  assert.equal(gstInvoiceDate({ 'invoice-date': '2026-08-04' }), '2026-08-04');
  assert.equal(gstInvoiceDate({ 'invoice-date': '2026-08-04T10:30:00Z' }), '2026-08-04T10:30:00Z');
});

test('column naming variants all resolve to the same date', () => {
  // pick() normalises case and punctuation, so these are the same column.
  for (const name of ['invoice-date', 'invoice date', 'Invoice Date', 'invoiceDate', 'transaction-date', 'Transaction Date']) {
    assert.equal(gstInvoiceDate({ [name]: '2026-08-04' }), '2026-08-04', `${name} must resolve`);
  }
});

test('a row whose date column is unrecognised yields null rather than a wrong date', () => {
  // Null is the honest answer, and saveGstInvoices refuses the import outright
  // when it is null for every row - storing them would mean rows that exist
  // and can never be seen.
  assert.equal(gstInvoiceDate({ 'Some Other Column': '2026-08-04' }), null);
  assert.equal(gstInvoiceDate({ 'invoice-date': '' }), null);
  assert.equal(gstInvoiceDate({}), null);
});
