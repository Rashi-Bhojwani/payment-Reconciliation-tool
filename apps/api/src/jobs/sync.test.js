import test from 'node:test';
import assert from 'node:assert/strict';
import { batchUpsert, ordinalsWithinGroup, withTenantSyncMutex } from './sync.js';

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
