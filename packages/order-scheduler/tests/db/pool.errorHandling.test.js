// A checked-out pg client is NOT covered by pool.on('error', ...) — that only
// catches idle clients (node-postgres's own documented behavior). An unhandled
// 'error' event on an EventEmitter throws synchronously and crashes the whole
// process, not just the one operation using that connection. withTransaction()
// attaches its own listener so a dropped connection mid-transaction logs
// instead of taking down the server — the same crash class that took down
// orderSyncService.js's sync advisory lock in production.
//
// The merge added a second path through withTransaction (reusing a
// withSchedulingTenant scope's connection instead of checking out its own), so
// both are exercised here — the tenant-scoped one is the path every route
// actually takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase } from '../helpers/db.js';
import { createTenant, asTenant } from '../helpers/fixtures.js';
import { withTransaction } from '../../src/db/pool.js';

test.before(resetDatabase);
test.after(closeDatabase);

test('an error event on the transaction client mid-transaction does not throw', async () => {
  let capturedClient;
  let emitThrew = false;

  await withTransaction(async (client) => {
    capturedClient = client;
    await client.query('SELECT 1');
    try {
      client.emit('error', new Error('Connection terminated unexpectedly'));
    } catch {
      emitThrew = true;
    }
  });

  assert.ok(capturedClient, 'the transaction client must have been captured');
  assert.equal(emitThrew, false, 'withTransaction must attach an error listener so this never throws/crashes the process');
});

test('the same holds on a tenant-scoped connection, which is the path routes take', async () => {
  const tenant = await createTenant('pool-error');
  let emitThrew = false;

  await asTenant(tenant.id, async () => {
    await withTransaction(async (client) => {
      await client.query('SELECT 1');
      try {
        client.emit('error', new Error('Connection terminated unexpectedly'));
      } catch {
        emitThrew = true;
      }
    });
  });

  assert.equal(emitThrew, false, 'withSchedulingTenant must attach an error listener to the connection it holds');
});

test('a transaction inside a tenant scope stays bound to that tenant', async () => {
  // The reason withTransaction reuses the scope's connection rather than
  // checking out its own: a fresh connection carries no app.current_tenant_id,
  // so every write inside the transaction would be refused by the same
  // policies the surrounding reads pass.
  const tenant = await createTenant('txn-binding');
  const bound = await asTenant(tenant.id, () =>
    withTransaction(async (client) => {
      const { rows } = await client.query("select current_setting('app.current_tenant_id', true) as tenant");
      return rows[0].tenant;
    }),
  );
  assert.equal(bound, tenant.id, 'the transaction must run on the connection the tenant is bound to');
});

test('a rollback inside a tenant scope leaves the connection usable', async () => {
  // The scope's connection is reused after the transaction ends, so a failed
  // transaction must not leave it in an aborted state - every later query on
  // it would fail with "current transaction is aborted".
  const tenant = await createTenant('txn-rollback');
  const afterRollback = await asTenant(tenant.id, async (client) => {
    await assert.rejects(withTransaction(async () => { throw new Error('deliberate'); }));
    const { rows } = await client.query('select 1 as ok');
    return rows[0].ok;
  });
  assert.equal(afterRollback, 1, 'the connection must still be usable after a rolled-back transaction');
});
