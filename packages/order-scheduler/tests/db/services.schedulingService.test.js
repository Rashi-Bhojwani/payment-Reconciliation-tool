// Ported from the standalone order scheduling tool. Two things changed and
// nothing else did: a "seller" is a platform tenant now, and every call runs
// inside asTenant(), because the scheduling tables are behind FORCE row-level
// security and a query with no tenant bound matches nothing (see db/pool.js).
// The assertions themselves are untouched - each one covers a bug that
// actually happened.
//
// Proves schedulingService resolves cleanly on both paths — a genuine
// network/API failure never leaves an order stuck in SCHEDULING with no
// shipment record, and a success stores tracking info and flips the order
// to SCHEDULED. Network is stubbed at the axios layer (the same technique
// as integrations.amazon.http.test.js), so this exercises the real
// AmazonAdapter + http.js + schedulingService chain end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { resetDatabase, closeDatabase } from '../helpers/db.js';
import { createTenant, createMarketplaceAccount, createOrder, createOrderItem, asTenant } from '../helpers/fixtures.js';
import { encryptJson } from '../../src/lib/crypto.js';
import * as credentialsRepo from '../../src/db/repositories/marketplaceAccountCredentials.js';
import * as packagesRepo from '../../src/db/repositories/packages.js';
import * as ordersRepo from '../../src/db/repositories/orders.js';
import * as shipmentsRepo from '../../src/db/repositories/shipments.js';
import * as schedulingService from '../../src/services/schedulingService.js';
import { _resetCaches } from '../../src/integrations/amazon/auth/lwa.js';

test.before(resetDatabase);
test.after(closeDatabase);
test.beforeEach(() => _resetCaches());

async function buildReadyOrder(tag) {
  const seller = await createTenant(`scheduling-${tag}`);
  const account = await createMarketplaceAccount(seller.id, { externalAccountId: `EXT-SCHED-${tag}` });
  const encrypted = encryptJson({ refreshToken: `refresh-${tag}` });
  await asTenant(seller.id, async () => {
    await credentialsRepo.upsert(account.id, {
      ciphertext: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion,
    });
  });
  const order = await createOrder(seller.id, account.id, { internalStatus: 'READY_TO_SCHEDULE' });
  await createOrderItem(seller.id, order.id);
  await asTenant(seller.id, async () => {
    const pkg = await packagesRepo.getOrCreatePrimary(seller.id, order.id);
    await packagesRepo.save(seller.id, pkg.id, { weightGrams: 500, lengthCm: 20, widthCm: 15, heightCm: 10, packageType: 'BOX' });
  });
  return { seller, account, order };
}

test('a persistent API failure marks the order FAILED with a real shipment record — never stuck in SCHEDULING', async (t) => {
  const { seller, order } = await buildReadyOrder('fail');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
    // A plain 400: non-retryable, fails on the very first attempt — fast.
    t.mock.method(axios, 'request', async () => ({ status: 400, headers: {}, data: {} }));

    const [result] = await schedulingService.scheduleOrders(seller.id, [order.id], null);

    assert.equal(result.ok, false);
    assert.match(result.reason, /SP-API rejected the request/);

    const updated = await ordersRepo.findById(seller.id, order.id);
    assert.equal(updated.internal_status, 'FAILED', 'order must not be left stuck in SCHEDULING');

    const shipments = await shipmentsRepo.listByOrder(seller.id, order.id);
    assert.equal(shipments.length, 1);
    assert.equal(shipments[0].status, 'FAILED');
    assert.ok(shipments[0].error_message, 'a failed shipment must record why');
  });
});

test('a previously FAILED order can be retried and succeed — not permanently stuck', async (t) => {
  // Real bug this reproduces: a genuine failure (Amazon's own 403, a
  // transient network error, ...) left the order FAILED, and clicking
  // Schedule again was rejected with "already scheduled or cancelled" —
  // false, and with no way to ever retry, since transitionInternalStatus
  // only accepted READY_TO_SCHEDULE as a starting point.
  const { seller, order } = await buildReadyOrder('retry-after-fail');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));

    let attempt = 0;
    t.mock.method(axios, 'request', async (config) => {
      attempt += 1;
      if (attempt === 1) return { status: 403, headers: {}, data: {} }; // the first, real failure
      if (config.url.includes('/timeSlot')) {
        return {
          status: 200, headers: {},
          data: { slotList: [{ slotId: 'slot-1', slotStartTime: '2026-01-01T09:00:00Z', slotEndTime: '2026-01-01T12:00:00Z' }] },
        };
      }
      return { status: 200, headers: {}, data: { packageId: 'PKG-RETRY', trackingId: 'TRK-RETRY' } };
  });

  const [firstResult] = await schedulingService.scheduleOrders(seller.id, [order.id], null);
  assert.equal(firstResult.ok, false);
  const afterFirst = await ordersRepo.findById(seller.id, order.id);
  assert.equal(afterFirst.internal_status, 'FAILED');

  const [secondResult] = await schedulingService.scheduleOrders(seller.id, [order.id], null);
  assert.equal(secondResult.ok, true, JSON.stringify(secondResult));

  const afterRetry = await ordersRepo.findById(seller.id, order.id);
  assert.equal(afterRetry.internal_status, 'SCHEDULED');
  });
});

test('a successful schedule call stores tracking info and flips the order to SCHEDULED', async (t) => {
  const { seller, order } = await buildReadyOrder('ok');
  await asTenant(seller.id, async () => {
    const requestedOrderIds = [];
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
    t.mock.method(axios, 'request', async (config) => {
      // Catches the exact bug this test file once missed: AmazonAdapter must
      // send Amazon's own order id (external_order_id), not a camelCase
      // property name that doesn't exist on a raw DB row and silently
      // resolves to undefined.
      requestedOrderIds.push(config.data?.amazonOrderId);
      if (config.url.includes('/timeSlot')) {
        return {
          status: 200, headers: {},
          data: { slotList: [{ slotId: 'slot-1', slotStartTime: '2026-01-01T09:00:00Z', slotEndTime: '2026-01-01T12:00:00Z' }] },
        };
      }
      return { status: 200, headers: {}, data: { packageId: 'PKG-123', trackingId: 'TRK-123' } };
  });

  const [result] = await schedulingService.scheduleOrders(seller.id, [order.id], null);

  assert.equal(result.ok, true, JSON.stringify(result));
  const updated = await ordersRepo.findById(seller.id, order.id);
  assert.equal(updated.internal_status, 'SCHEDULED');

  const shipments = await shipmentsRepo.listByOrder(seller.id, order.id);
  assert.equal(shipments.length, 1);
  assert.equal(shipments[0].status, 'SCHEDULED');
  assert.equal(shipments[0].tracking_id, 'TRK-123');
  assert.ok(shipments[0].idempotency_key, 'rule R4: every scheduled shipment carries an idempotency key');
  assert.ok(
    requestedOrderIds.every((id) => id === order.external_order_id),
    `every SP-API request must carry the real order id, got: ${JSON.stringify(requestedOrderIds)}`,
  );
  });
});

test('scheduling an order a second time does not double-book (rule R4)', async (t) => {
  const { seller, order } = await buildReadyOrder('retry');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/timeSlot')) {
        return { status: 200, headers: {}, data: { slotList: [{ slotId: 'slot-1' }] } };
      }
      return { status: 200, headers: {}, data: { packageId: 'PKG-999', trackingId: 'TRK-999' } };
  });

  const [first] = await schedulingService.scheduleOrders(seller.id, [order.id], null);
  assert.equal(first.ok, true);

  // The order is now SCHEDULED, not READY_TO_SCHEDULE — a retried click (or a
  // duplicated job) must be refused, not silently re-book a second pickup.
  const [second] = await schedulingService.scheduleOrders(seller.id, [order.id], null);
  assert.equal(second.ok, false);
  assert.match(second.reason, /not ready to schedule/i);
  assert.match(second.reason, /SCHEDULED/, 'the message must name the order\'s real current status, not a canned guess');

  const shipments = await shipmentsRepo.listByOrder(seller.id, order.id);
  assert.equal(shipments.length, 1, 'exactly one shipment must exist after a retried schedule click');
  });
});

test('scheduling refuses an order with incomplete package info before ever calling the adapter', async (t) => {
  const seller = await createTenant('incomplete-package');
  const account = await createMarketplaceAccount(seller.id, { externalAccountId: 'EXT-INCOMPLETE' });
  const order = await createOrder(seller.id, account.id, { internalStatus: 'READY_TO_SCHEDULE' });
  await asTenant(seller.id, async () => {
    // No package fields saved — getOrCreatePrimary() inside preflight() will
    // create an empty placeholder, which is not complete.
    let networkCalled = false;
    t.mock.method(axios, 'request', async () => {
      networkCalled = true;
      return { status: 200, headers: {}, data: {} };
  });

  const [result] = await schedulingService.scheduleOrders(seller.id, [order.id], null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /required before scheduling/);
  assert.equal(networkCalled, false, 'an incomplete package must never reach the network');

  const updated = await ordersRepo.findById(seller.id, order.id);
  assert.equal(updated.internal_status, 'READY_TO_SCHEDULE', 'a rejected preflight must not change order status');
  });
});

test('an order Amazon already shipped via Seller Central cannot be scheduled through this tool', async (t) => {
  // internal_status SHIPPED is set by orderSyncService from Amazon's real
  // fulfillmentStatus (see orderSyncService.js's EXTERNALLY_HANDLED_STATUS)
  // — there is genuinely nothing to schedule, and never a network call to
  // make for it.
  const seller = await createTenant('already-shipped');
  const account = await createMarketplaceAccount(seller.id, { externalAccountId: 'EXT-SHIPPED' });
  const order = await createOrder(seller.id, account.id, { internalStatus: 'SHIPPED' });
  await asTenant(seller.id, async () => {
    let networkCalled = false;
    t.mock.method(axios, 'request', async () => {
      networkCalled = true;
      return { status: 200, headers: {}, data: {} };
  });

  const [result] = await schedulingService.scheduleOrders(seller.id, [order.id], null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /already shipped/i);
  assert.equal(networkCalled, false, 'an already-shipped order must never reach the network');

  const updated = await ordersRepo.findById(seller.id, order.id);
  assert.equal(updated.internal_status, 'SHIPPED', 'a rejected preflight must not change order status');
  });
});
