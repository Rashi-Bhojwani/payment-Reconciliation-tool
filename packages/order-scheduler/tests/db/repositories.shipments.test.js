// createPending's UPSERT semantics, in isolation from the full scheduling flow
// — the same order+package always produces the same deterministic idempotency
// key (rule R4), so a *retry* after a real failure hits this exact row, not a
// fresh one. Real bug this reproduces: the plain INSERT this replaced crashed
// with a raw 23505 unique-violation on any retry, since transitionInternalStatus
// was fixed (schedulingService.js) to allow retrying a FAILED order but nothing
// downstream expected the collision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase } from '../helpers/db.js';
import { createTenant, createMarketplaceAccount, createOrder, createPackage, asTenant } from '../helpers/fixtures.js';
import * as shipmentsRepo from '../../src/db/repositories/shipments.js';

test.before(resetDatabase);
test.after(closeDatabase);

async function buildOrderWithPackage(tag) {
  const tenant = await createTenant(`shipments-${tag}`);
  const account = await createMarketplaceAccount(tenant.id, { externalAccountId: `EXT-SHIP-${tag}` });
  const order = await createOrder(tenant.id, account.id);
  const pkg = await createPackage(tenant.id, order.id);
  return { tenant, account, order, pkg };
}

test('a FAILED shipment is reset and reused by a retry, not duplicated', async () => {
  const { tenant, account, order, pkg } = await buildOrderWithPackage('failed-retry');
  const idempotencyKey = 'test-key-failed-retry';

  await asTenant(tenant.id, async () => {
    const first = await shipmentsRepo.createPending(tenant.id, {
      orderId: order.id, packageId: pkg.id, marketplaceAccountId: account.id, provider: 'AMAZON', idempotencyKey,
    });
    assert.equal(first.status, 'PENDING');
    await shipmentsRepo.markFailed(tenant.id, first.id, 'a real failure');

    const retry = await shipmentsRepo.createPending(tenant.id, {
      orderId: order.id, packageId: pkg.id, marketplaceAccountId: account.id, provider: 'AMAZON', idempotencyKey,
    });
    assert.ok(retry, 'a FAILED row must be reusable, not a dead end');
    assert.equal(retry.id, first.id, 'the SAME row is reused (one row per idempotency key), not a duplicate insert');
    assert.equal(retry.status, 'PENDING', 'reset back to PENDING for the new attempt');
    assert.equal(retry.error_message, null, 'the stale error from the previous failure must not linger');
  });
});

test('a SCHEDULED shipment is never reset — createPending returns null instead of colliding', async () => {
  const { tenant, account, order, pkg } = await buildOrderWithPackage('already-scheduled');
  const idempotencyKey = 'test-key-already-scheduled';

  await asTenant(tenant.id, async () => {
    const first = await shipmentsRepo.createPending(tenant.id, {
      orderId: order.id, packageId: pkg.id, marketplaceAccountId: account.id, provider: 'AMAZON', idempotencyKey,
    });
    await shipmentsRepo.markScheduled(tenant.id, first.id, { trackingId: 'TRK-1' });

    const second = await shipmentsRepo.createPending(tenant.id, {
      orderId: order.id, packageId: pkg.id, marketplaceAccountId: account.id, provider: 'AMAZON', idempotencyKey,
    });
    assert.equal(second, null, 'a real booking must never be silently reset or duplicated');

    const stillThere = await shipmentsRepo.findById(tenant.id, first.id);
    assert.equal(stillThere.status, 'SCHEDULED');
    assert.equal(stillThere.tracking_id, 'TRK-1', 'the real booking record must be untouched');
  });
});

test('a PENDING shipment (a concurrent attempt genuinely in flight) is also never reset', async () => {
  const { tenant, account, order, pkg } = await buildOrderWithPackage('in-flight');
  const idempotencyKey = 'test-key-in-flight';

  await asTenant(tenant.id, async () => {
    const first = await shipmentsRepo.createPending(tenant.id, {
      orderId: order.id, packageId: pkg.id, marketplaceAccountId: account.id, provider: 'AMAZON', idempotencyKey,
    });
    assert.equal(first.status, 'PENDING');

    const concurrent = await shipmentsRepo.createPending(tenant.id, {
      orderId: order.id, packageId: pkg.id, marketplaceAccountId: account.id, provider: 'AMAZON', idempotencyKey,
    });
    assert.equal(concurrent, null, 'a second concurrent claim on the same key must not proceed');
  });
});

test('the shipments list joins public.tenants and returns the tenant name', async () => {
  // The join this covers used to read `JOIN sellers`, which after the merge
  // resolves through search_path to reconciliation's own sellers table - a
  // different table whose id is never a tenant id. The query would return
  // nothing at all, which reads on screen as "no shipments" rather than as a
  // bug.
  const { tenant, account, order, pkg } = await buildOrderWithPackage('tenants-join');
  await asTenant(tenant.id, async () => {
    await shipmentsRepo.createPending(tenant.id, {
      orderId: order.id, packageId: pkg.id, marketplaceAccountId: account.id, provider: 'AMAZON', idempotencyKey: 'test-key-join',
    });
    const { rows, total } = await shipmentsRepo.list([tenant.id], {});
    assert.equal(total, 1, 'the join must not silently drop the row');
    assert.equal(rows[0].seller_name, tenant.company_name);
    assert.equal(rows[0].external_order_id, order.external_order_id);
    assert.equal(rows[0].marketplace_code, 'AMAZON');
  });
});
