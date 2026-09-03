// The standalone tool's cross-seller test lived here: it proved one
// scheduleOrderRefs() call could schedule orders belonging to DIFFERENT
// sellers, which was that product's headline feature — one operator managing
// many sellers, selecting a marketplace and scheduling across all of them.
//
// That capability does not survive the merge, and this file is the honest
// version of the same test. In this platform a user belongs to exactly one
// tenant, every route is scoped by a tenant id checked against the JWT, and
// withSchedulingTenant refuses to switch tenants mid-request rather than
// silently reinterpreting one. So the interesting question is no longer "can
// one call span two sellers" but its inverse: two tenants scheduling at the
// same time must not contaminate each other, and neither may read the other's
// shipment.
//
// The valuable assertion from the original is kept intact — each shipment's
// tracking id must reflect ITS OWN order, which is what proves the per-group
// sellerId derivation in scheduleOrderRefs is correct rather than accidentally
// sharing state between groups.
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
import { withSchedulingTenant } from '../../src/db/pool.js';
import { _resetCaches } from '../../src/integrations/amazon/auth/lwa.js';

test.before(resetDatabase);
test.after(closeDatabase);
test.beforeEach(() => _resetCaches());

async function buildReadyTenantOrder(tag) {
  const seller = await createTenant(`xt-${tag}`);
  const account = await createMarketplaceAccount(seller.id, { externalAccountId: `EXT-XT-${tag}` });
  const encrypted = encryptJson({ refreshToken: `refresh-${tag}` });
  const order = await createOrder(seller.id, account.id, { internalStatus: 'READY_TO_SCHEDULE', externalOrderId: `407-XT-${tag}` });
  await createOrderItem(seller.id, order.id);
  await asTenant(seller.id, async () => {
    await credentialsRepo.upsert(account.id, {
      ciphertext: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion,
    });
    const pkg = await packagesRepo.getOrCreatePrimary(seller.id, order.id);
    await packagesRepo.save(seller.id, pkg.id, { weightGrams: 500, lengthCm: 20, widthCm: 15, heightCm: 10, packageType: 'BOX' });
  });
  return { seller, account, order };
}

function stubAmazon(t) {
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async (config) => {
    if (config.url.includes('/timeSlot')) {
      return { status: 200, headers: {}, data: { slotList: [{ slotId: 'slot-1' }] } };
    }
    // A distinguishable tracking id per order, so a shipment attributed to
    // the wrong tenant is unmistakable rather than merely absent.
    const orderId = config.data?.amazonOrderId;
    return { status: 200, headers: {}, data: { packageId: `PKG-${orderId}`, trackingId: `TRK-${orderId}` } };
  });
}

test('two tenants scheduling concurrently each get their own shipment, correctly attributed', async (t) => {
  const a = await buildReadyTenantOrder('a');
  const b = await buildReadyTenantOrder('b');
  stubAmazon(t);

  // Genuinely concurrent, each in its own scope - which is exactly how two
  // simultaneous requests reach this code.
  const [resultsA, resultsB] = await Promise.all([
    asTenant(a.seller.id, () => schedulingService.scheduleOrders(a.seller.id, [a.order.id], null)),
    asTenant(b.seller.id, () => schedulingService.scheduleOrders(b.seller.id, [b.order.id], null)),
  ]);
  assert.equal(resultsA[0].ok, true, JSON.stringify(resultsA));
  assert.equal(resultsB[0].ok, true, JSON.stringify(resultsB));

  await asTenant(a.seller.id, async () => {
    assert.equal((await ordersRepo.findById(a.seller.id, a.order.id)).internal_status, 'SCHEDULED');
    const shipments = await shipmentsRepo.listByOrder(a.seller.id, a.order.id);
    assert.equal(shipments.length, 1);
    assert.equal(shipments[0].tracking_id, 'TRK-407-XT-a', 'tenant A\'s shipment must carry tenant A\'s order id');
  });
  await asTenant(b.seller.id, async () => {
    assert.equal((await ordersRepo.findById(b.seller.id, b.order.id)).internal_status, 'SCHEDULED');
    const shipments = await shipmentsRepo.listByOrder(b.seller.id, b.order.id);
    assert.equal(shipments.length, 1);
    assert.equal(shipments[0].tracking_id, 'TRK-407-XT-b', 'tenant B\'s shipment must carry tenant B\'s order id');
  });
});

test('one tenant cannot read the other\'s shipment, even holding its id', async (t) => {
  const a = await buildReadyTenantOrder('read-a');
  const b = await buildReadyTenantOrder('read-b');
  stubAmazon(t);

  await asTenant(a.seller.id, () => schedulingService.scheduleOrders(a.seller.id, [a.order.id], null));
  const shipmentOfA = await asTenant(a.seller.id, async () => (await shipmentsRepo.listByOrder(a.seller.id, a.order.id))[0]);
  assert.ok(shipmentOfA, 'tenant A must actually have a shipment for this to prove anything');

  await asTenant(b.seller.id, async () => {
    assert.equal(await shipmentsRepo.findById(b.seller.id, shipmentOfA.id), null,
      'asking with the other tenant\'s own id in the WHERE clause must still return nothing');
  });
  // The second line of defence - row-level security refusing it even if a
  // repository were handed the owner's id - is deliberately NOT asserted here.
  // It cannot be: these tests run against whatever DATABASE_URL points at, and
  // a scratch database is very often `postgres`, a superuser, which is exempt
  // from every policy. An assertion that passes or fails on who you happened
  // to connect as is worse than no assertion. `npm run check:scheduling-
  // isolation` covers exactly that claim properly, by creating its own
  // unprivileged role to make it with.
});

test('a tenant scope refuses to become a different tenant mid-request', async () => {
  // The one case a nested scope must never quietly allow: it would mean a
  // single request acting as two tenants, which is how a cross-tenant leak
  // gets written by accident.
  const a = await createTenant('switch-a');
  const b = await createTenant('switch-b');
  await asTenant(a.id, async () => {
    await assert.rejects(
      () => withSchedulingTenant(b.id, async () => 'should never run'),
      /Refusing to switch scheduling tenant scope/,
    );
    // Re-entering as the SAME tenant is fine and must not be broken by that.
    assert.equal(await withSchedulingTenant(a.id, async () => 'reused'), 'reused');
  });
});
