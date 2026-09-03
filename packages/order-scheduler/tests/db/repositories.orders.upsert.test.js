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
