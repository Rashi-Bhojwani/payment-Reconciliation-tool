import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRestoreStatements, createSyncQueue } from './sync-queue.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('identical requests share one run instead of calling Amazon twice', async () => {
  const queue = createSyncQueue();
  const gate = deferred();
  let starts = 0;
  const start = () => { starts += 1; return gate.promise; };

  const first = queue.run({ resourceKey: 't:SETTLEMENT', start });
  const second = queue.run({ resourceKey: 't:SETTLEMENT', start });
  assert.equal(starts, 1);
  assert.equal(first, second);

  gate.resolve('ok');
  assert.equal(await first, 'ok');
  assert.equal(await second, 'ok');
  assert.equal(queue.isBusy('t:SETTLEMENT'), false);
});

test('a queued reset waits for an in-flight sync on the same rate bucket', async () => {
  const queue = createSyncQueue();
  const syncGate = deferred();
  const order = [];

  const sync = queue.run({
    resourceKey: 't:SETTLEMENT',
    start: () => { order.push('sync-start'); return syncGate.promise.then(() => order.push('sync-end')); }
  });
  const reset = queue.run({
    resourceKey: 't:SETTLEMENT',
    dedupeKey: 't:reset:SETTLEMENT:a:b',
    queue: true,
    start: () => { order.push('reset-start'); return 'reset'; }
  });

  assert.deepEqual(order, ['sync-start'], 'the reset must not start while the sync is talking to Amazon');
  syncGate.resolve();
  await sync;
  await reset;
  assert.deepEqual(order, ['sync-start', 'sync-end', 'reset-start']);
});

test('a double-clicked reset runs once, not twice against the document bucket', async () => {
  const queue = createSyncQueue();
  const gate = deferred();
  let starts = 0;
  const params = {
    resourceKey: 't:SETTLEMENT',
    dedupeKey: 't:reset:SETTLEMENT:a:b',
    queue: true,
    start: () => { starts += 1; return gate.promise; }
  };

  const first = queue.run(params);
  const second = queue.run(params);
  assert.equal(starts, 1);
  assert.equal(first, second);
  gate.resolve('done');
  await first;
  assert.equal(starts, 1);
});

test('a failed run does not cancel the work queued behind it', async () => {
  const queue = createSyncQueue();
  const failing = queue.run({ resourceKey: 't:SETTLEMENT', start: () => Promise.reject(new Error('429')) });
  const next = queue.run({ resourceKey: 't:SETTLEMENT', dedupeKey: 'other', queue: true, start: () => 'ran anyway' });

  await assert.rejects(failing, /429/, 'the first caller still sees its own error');
  assert.equal(await next, 'ran anyway');
});

test('a long sync settling does not release a queued successor that now owns the bucket', async () => {
  const queue = createSyncQueue();
  const slow = deferred();
  const queued = deferred();

  const first = queue.run({ resourceKey: 't:SETTLEMENT', start: () => slow.promise });
  const second = queue.run({ resourceKey: 't:SETTLEMENT', dedupeKey: 'second', queue: true, start: () => queued.promise });

  slow.resolve();
  await first;
  assert.equal(queue.isBusy('t:SETTLEMENT'), true, 'the bucket is still owned by the queued run');

  queued.resolve();
  await second;
  assert.equal(queue.isBusy('t:SETTLEMENT'), false);
});

test('deleted settlement rows rebuild into insert statements that cannot clobber refetched rows', () => {
  const rows = [
    { id: 'a', tenant_id: 't', amount: '10.00', raw: { 'order-id': '1' }, posted_date: null },
    { id: 'b', tenant_id: 't', amount: '-2.50', raw: { 'order-id': '2' }, posted_date: null }
  ];
  const [statement, ...rest] = buildRestoreStatements(rows);
  assert.equal(rest.length, 0);
  assert.match(statement.text, /^insert into settlement_rows \("id","tenant_id","amount","raw","posted_date"\) values \(\$1,\$2,\$3,\$4,\$5\),\(\$6,\$7,\$8,\$9,\$10\) on conflict do nothing$/);
  assert.deepEqual(statement.values, ['a', 't', '10.00', { 'order-id': '1' }, null, 'b', 't', '-2.50', { 'order-id': '2' }, null]);
});

test('a restore of many rows is chunked below the Postgres parameter limit', () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ id: String(index), amount: '1.00' }));
  const statements = buildRestoreStatements(rows, { maxParameters: 10 });
  assert.equal(statements.length, 10, '10 parameters / 2 columns = 5 rows per statement');
  for (const statement of statements) assert.ok(statement.values.length <= 10);
  assert.equal(statements.flatMap(statement => statement.values).length, 100);
});

test('an empty snapshot restores nothing rather than emitting invalid SQL', () => {
  assert.deepEqual(buildRestoreStatements([]), []);
});
