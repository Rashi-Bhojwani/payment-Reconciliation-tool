// upsertFromMarketplace's ON CONFLICT path, in isolation from the sync service
// — the same order re-synced twice must actually apply the SECOND write's
// fields, not just the first. Real bug this reproduces: the SQL's ON CONFLICT
// DO UPDATE SET list was missing internal_status entirely, so a re-sync of an
// order that already existed silently discarded whatever internal_status
// orderSyncService computed for it — it only ever applied on that order's very
// first INSERT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase } from '../helpers/db.js';
import { createTenant, createMarketplaceAccount, asTenant } from '../helpers/fixtures.js';
import * as ordersRepo from '../../src/db/repositories/orders.js';

test.before(resetDatabase);
test.after(closeDatabase);

function baseOrder(marketplaceId, marketplaceAccountId, overrides = {}) {
  return {
    marketplaceId,
    marketplaceAccountId,
    externalOrderId: 'UPSERT-CONFLICT-TEST',
    orderDate: new Date('2026-08-01T00:00:00.000Z'),
    lastUpdatedDate: new Date('2026-08-01T00:00:00.000Z'),
    marketplaceStatus: null,
    internalStatus: 'READY_FOR_REVIEW',
    ...overrides,
  };
}

test('re-upserting an existing order actually applies its new internal_status and marketplace_status', async () => {
  const tenant = await createTenant('upsert-conflict');
  const account = await createMarketplaceAccount(tenant.id, { externalAccountId: 'EXT-UPSERT-CONFLICT' });

  await asTenant(tenant.id, async () => {
    const first = await ordersRepo.upsertFromMarketplace(
      tenant.id,
      baseOrder(account.marketplace_id, account.id, { internalStatus: 'READY_FOR_REVIEW', marketplaceStatus: null }),
    );
    assert.equal(first.internal_status, 'READY_FOR_REVIEW');

    const second = await ordersRepo.upsertFromMarketplace(
      tenant.id,
      baseOrder(account.marketplace_id, account.id, { internalStatus: 'SHIPPED', marketplaceStatus: 'SHIPPED' }),
    );
    assert.equal(second.id, first.id, 'the same row is reused (one row per external order id), not a duplicate insert');
    assert.equal(second.internal_status, 'SHIPPED', 'the SECOND write\'s internal_status must actually land, not be silently discarded');
    assert.equal(second.marketplace_status, 'SHIPPED');

    const reloaded = await ordersRepo.findByExternalOrderId(tenant.id, account.id, 'UPSERT-CONFLICT-TEST');
    assert.equal(reloaded.internal_status, 'SHIPPED', 'a fresh read must agree — this is not just the RETURNING clause lying');
  });
});

test('a search-only re-sync never erases what the getOrder detail call established', async () => {
  // The exact sequence that produced a live account of 100 orders all reading
  // "Amazon status: —", "Ship by —", "Deliver by —": once an order is settled,
  // orderSyncService skips the per-order getOrder call, so the next sync
  // carries ONLY search data - which does not include status, dates, channel,
  // service level or the order total at all. A plain assignment wrote NULL
  // over every one of them while internal_status survived, leaving an order
  // the app was certain about with nothing left to explain why.
  const tenant = await createTenant('upsert-null-clobber');
  const account = await createMarketplaceAccount(tenant.id, { externalAccountId: 'EXT-UPSERT-NULLS' });

  await asTenant(tenant.id, async () => {
    const detailed = await ordersRepo.upsertFromMarketplace(tenant.id, baseOrder(account.marketplace_id, account.id, {
      externalOrderId: 'DETAIL-THEN-SEARCH',
      internalStatus: 'SHIPPED',
      marketplaceStatus: 'SHIPPED',
      fulfillmentChannel: 'MFN',
      shipServiceLevel: 'Std IN Dom',
      shipByDate: new Date('2026-08-05T00:00:00.000Z'),
      deliveryByDate: new Date('2026-08-09T00:00:00.000Z'),
      orderTotalAmount: 1299.5,
      orderTotalCurrency: 'INR',
    }));
    assert.equal(detailed.marketplace_status, 'SHIPPED');

    // Now exactly what a later sweep sends for a settled order: search shape,
    // every detail-only field null.
    const afterSearchOnly = await ordersRepo.upsertFromMarketplace(tenant.id, baseOrder(account.marketplace_id, account.id, {
      externalOrderId: 'DETAIL-THEN-SEARCH',
      internalStatus: 'SHIPPED',
      marketplaceStatus: null,
      fulfillmentChannel: null,
      shipServiceLevel: null,
      shipByDate: null,
      deliveryByDate: null,
      orderTotalAmount: null,
      orderTotalCurrency: null,
    }));

    assert.equal(afterSearchOnly.marketplace_status, 'SHIPPED', 'Amazon\'s confirmed status must survive a search-only re-sync');
    assert.equal(afterSearchOnly.fulfillment_channel, 'MFN');
    assert.equal(afterSearchOnly.ship_service_level, 'Std IN Dom');
    assert.ok(afterSearchOnly.ship_by_date, 'the ship-by deadline must not be erased');
    assert.ok(afterSearchOnly.delivery_by_date, 'the deliver-by date must not be erased');
    assert.equal(Number(afterSearchOnly.order_total_amount), 1299.5);
    assert.equal(afterSearchOnly.order_total_currency, 'INR');
  });
});

test('a later detail sync still updates those fields — COALESCE must not freeze them', async () => {
  // The other half of the rule: never overwrite a known value with NULL is not
  // the same as never overwrite. A real new value has to land, or an order
  // whose ship-by date Amazon moved would keep showing the old deadline.
  const tenant = await createTenant('upsert-still-updates');
  const account = await createMarketplaceAccount(tenant.id, { externalAccountId: 'EXT-UPSERT-UPDATES' });

  await asTenant(tenant.id, async () => {
    await ordersRepo.upsertFromMarketplace(tenant.id, baseOrder(account.marketplace_id, account.id, {
      externalOrderId: 'DETAIL-THEN-DETAIL',
      marketplaceStatus: 'Unshipped',
      shipByDate: new Date('2026-08-05T00:00:00.000Z'),
    }));
    const updated = await ordersRepo.upsertFromMarketplace(tenant.id, baseOrder(account.marketplace_id, account.id, {
      externalOrderId: 'DETAIL-THEN-DETAIL',
      marketplaceStatus: 'SHIPPED',
      shipByDate: new Date('2026-08-07T00:00:00.000Z'),
    }));
    assert.equal(updated.marketplace_status, 'SHIPPED');
    assert.equal(new Date(updated.ship_by_date).toISOString(), '2026-08-07T00:00:00.000Z');
  });
});

test('an upsert with no tenant bound is refused rather than silently writing nothing', async () => {
  // Not a repository behaviour but a merge one, and it belongs next to the
  // write it protects: under FORCE row-level security this insert would be
  // rejected by the policy. db/pool.js turns it into a message that names the
  // actual mistake instead.
  const tenant = await createTenant('upsert-unbound');
  const account = await createMarketplaceAccount(tenant.id, { externalAccountId: 'EXT-UPSERT-UNBOUND' });
  await assert.rejects(
    () => ordersRepo.upsertFromMarketplace(tenant.id, baseOrder(account.marketplace_id, account.id)),
    /no tenant bound/i,
  );
});
