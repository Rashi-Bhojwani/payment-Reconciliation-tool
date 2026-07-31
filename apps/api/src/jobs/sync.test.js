import test from 'node:test';
import assert from 'node:assert/strict';
import { batchUpsert } from './sync.js';

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
