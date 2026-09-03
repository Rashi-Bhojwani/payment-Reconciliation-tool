// Ported from the standalone order scheduling tool. A "seller" is a platform
// tenant now, and every call runs inside asTenant() because the scheduling
// tables are behind FORCE row-level security - a query with no tenant bound
// matches nothing rather than failing (see db/pool.js). The assertions are
// otherwise untouched.
//
// orderSyncService.syncAccount is the function that broke in production —
// it had zero direct test coverage of its own before this file (only
// jobs.reconcileAccounts.test.js exercised it, and only with an empty
// orders list, which could never have caught a real-data field-mapping
// bug). This exercises it end to end with a realistic (trimmed, from an
// actual production response) search result and checks what actually
// lands in the database.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { resetDatabase, closeDatabase } from '../helpers/db.js';
import { createTenant, createMarketplaceAccount, asTenant } from '../helpers/fixtures.js';
import { encryptJson } from '../../src/lib/crypto.js';
import * as credentialsRepo from '../../src/db/repositories/marketplaceAccountCredentials.js';
import * as ordersRepo from '../../src/db/repositories/orders.js';
import * as orderItemsRepo from '../../src/db/repositories/orderItems.js';
import * as orderSyncService from '../../src/services/orderSyncService.js';
import { _resetCaches } from '../../src/integrations/amazon/auth/lwa.js';
import { pool } from '../../src/db/pool.js';

test.before(resetDatabase);
test.after(closeDatabase);
test.beforeEach(() => _resetCaches());

async function buildAuthorizedAccount(tag) {
  const seller = await createTenant(`sync-${tag}`);
  const account = await createMarketplaceAccount(seller.id, { externalAccountId: `EXT-SYNC-${tag}` });
  const encrypted = encryptJson({ refreshToken: `refresh-${tag}` });
  await asTenant(seller.id, async () => {
    await credentialsRepo.upsert(account.id, {
      ciphertext: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion,
    });
  });
  return { seller, account };
}

test('a real (trimmed) search response stores the order and its items correctly', async (t) => {
  const { seller, account } = await buildAuthorizedAccount('real-shape');
  await asTenant(seller.id, async () => {

    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
    t.mock.method(axios, 'request', async () => ({
      status: 200,
      headers: {},
      data: {
        pagination: {},
        orders: [
          {
            orderId: '403-9973834-1219522',
            createdTime: '2026-08-04T08:47:59.480Z',
            lastUpdatedTime: '2026-08-09T19:00:32.078Z',
            programs: ['AMAZON_EASY_SHIP', 'AMAZON_BUSINESS'],
            salesChannel: { marketplaceId: 'A21TJRUUN4KGV', marketplaceName: 'Amazon.in', channelName: 'AMAZON' },
            orderItems: [
              {
                orderItemId: '66101250590922',
                quantityOrdered: 2,
                product: {
                  asin: 'B0H7XHVR2F',
                  sellerSku: 'SG-SPMB-64',
                  title: 'Solar Panel Mounting Bracket',
                  price: { unitPrice: { amount: '2029.0', currencyCode: 'INR' } },
                },
              },
            ],
          },
        ],
      },
    }));

    const outcome = await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    assert.equal(outcome.synced, 1);

    const stored = await ordersRepo.findByExternalOrderId(seller.id, account.id, '403-9973834-1219522');
    assert.ok(stored, 'the order must actually land in the database');
    assert.equal(stored.internal_status, 'READY_FOR_REVIEW');
    // Not present in a real list result — must not have been fabricated.
    assert.equal(stored.marketplace_status, null);
    // programs included AMAZON_BUSINESS — the one thing this app infers from
    // a field the real response does provide.
    assert.equal(stored.is_business_order, true);

    const items = await orderItemsRepo.listByOrder(seller.id, stored.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].external_product_id, 'B0H7XHVR2F');
    assert.equal(items[0].sku, 'SG-SPMB-64');
    assert.equal(Number(items[0].quantity_ordered), 2);
  });
});

test('a per-order detail fetch failure does not lose the order — it saves with search data only', async (t) => {
  // getOrder's schema has never been checked against a live response —
  // simulates exactly that: search succeeds, the per-order detail call
  // (a different URL) returns a shape that doesn't match what this app
  // still assumes for it. The order must still land, using what search
  // already had.
  const { seller, account } = await buildAuthorizedAccount('detail-fails');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        // The per-order detail call — deliberately the wrong shape.
        return { status: 200, headers: {}, data: { nothingRecognizable: true } };
      }
      return {
        status: 200,
        headers: {},
        data: { pagination: {}, orders: [{ orderId: '405-DETAIL-0000001', createdTime: '2026-08-01T00:00:00.000Z', lastUpdatedTime: '2026-08-01T00:00:00.000Z', orderItems: [] }] },
      };
    });

    const outcome = await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    assert.equal(outcome.synced, 1, 'the order must still be saved despite the detail call failing');

    const stored = await ordersRepo.findByExternalOrderId(seller.id, account.id, '405-DETAIL-0000001');
    assert.ok(stored, 'a detail-fetch failure on one order must not lose that order from the sync');
  });
});

test('a successful detail fetch enriches the order with real status', async (t) => {
  const { seller, account } = await buildAuthorizedAccount('detail-succeeds');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        // getOrder — the confirmed real v2026-01-01 shape (captured from a
        // live rawResponse dump): no payload wrapper, order.fulfillment.
        // fulfillmentStatus carries the real status, orderItems is already
        // inline (no separate getOrderItems call is made anymore).
        return {
          status: 200, headers: {},
          data: {
            order: {
              orderId: '405-ENRICH-0000001',
              createdTime: '2026-08-01T00:00:00.000Z',
              lastUpdatedTime: '2026-08-01T00:00:00.000Z',
              fulfillment: { fulfillmentStatus: 'SHIPPED', fulfilledBy: 'MERCHANT', fulfillmentServiceLevel: 'STANDARD' },
              orderItems: [],
            },
          },
        };
      }
      return {
        status: 200,
        headers: {},
        data: { pagination: {}, orders: [{ orderId: '405-ENRICH-0000001', createdTime: '2026-08-01T00:00:00.000Z', lastUpdatedTime: '2026-08-01T00:00:00.000Z', orderItems: [] }] },
      };
    });

    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const stored = await ordersRepo.findByExternalOrderId(seller.id, account.id, '405-ENRICH-0000001');
    assert.equal(stored.marketplace_status, 'SHIPPED', 'when the detail call succeeds, real status must actually be used');
    assert.equal(stored.internal_status, 'SHIPPED', 'a real-world already-shipped order needs no action from this tool');
  });
});

test('a CANCELLED fulfillmentStatus is stored as internal_status CANCELLED', async (t) => {
  const { seller, account } = await buildAuthorizedAccount('detail-cancelled');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        return {
          status: 200, headers: {},
          data: {
            order: {
              orderId: '405-CANCEL-0000001',
              createdTime: '2026-08-01T00:00:00.000Z',
              lastUpdatedTime: '2026-08-01T00:00:00.000Z',
              fulfillment: { fulfillmentStatus: 'CANCELLED' },
              orderItems: [],
            },
          },
        };
      }
      return {
        status: 200,
        headers: {},
        data: { pagination: {}, orders: [{ orderId: '405-CANCEL-0000001', createdTime: '2026-08-01T00:00:00.000Z', lastUpdatedTime: '2026-08-01T00:00:00.000Z', orderItems: [] }] },
      };
    });

    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const stored = await ordersRepo.findByExternalOrderId(seller.id, account.id, '405-CANCEL-0000001');
    assert.equal(stored.internal_status, 'CANCELLED', 'an order Amazon shows as cancelled needs no action from this tool');
  });
});

test('a re-sync that newly confirms SHIPPED actually updates a previously-synced order — not just on first insert', async (t) => {
  // The real bug this reproduces: orders.upsertFromMarketplace's ON
  // CONFLICT clause was missing internal_status from its SET list, so
  // orderSyncService.nextStatus()'s computed value only ever reached the
  // database on a brand new order's very first INSERT — every subsequent
  // re-sync of that SAME order silently discarded whatever internal_status
  // it recomputed (including CANCELLED/SHIPPED, once getOrder started
  // reporting them for real) and the order stayed frozen at whatever it was
  // the first time it was ever synced. Production symptom: dozens of
  // already-shipped orders kept showing "Ready For Review" forever after
  // their very first (pre-status) sync, no matter how many times Force Sync
  // ran afterwards.
  const { seller, account } = await buildAuthorizedAccount('resync-status-change');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));

    const orderPayload = { orderId: '405-RESYNC-STATUS', createdTime: '2026-08-01T00:00:00.000Z', lastUpdatedTime: '2026-08-01T00:00:00.000Z', orderItems: [] };

    // First sync: the detail call fails (as it always did before getOrder's
    // schema was fixed) — the order lands with no status at all.
    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        return { status: 200, headers: {}, data: { nothingRecognizable: true } };
      }
      return { status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] } };
    });
    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const afterFirstSync = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    assert.equal(afterFirstSync.internal_status, 'READY_FOR_REVIEW');

    // Second sync of the SAME order: the detail call now succeeds and Amazon
    // confirms SHIPPED. This must actually change the stored internal_status.
    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        return { status: 200, headers: {}, data: { order: { ...orderPayload, fulfillment: { fulfillmentStatus: 'SHIPPED' } } } };
      }
      return { status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] } };
    });
    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const afterSecondSync = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    assert.equal(afterSecondSync.internal_status, 'SHIPPED', 'a re-sync of an EXISTING order must actually apply its newly computed status, not just on first insert');
    assert.equal(afterSecondSync.marketplace_status, 'SHIPPED');
  });
});

test('a known SHIPPED order is never pushed back to READY_FOR_REVIEW by a re-sync whose detail call fails', async (t) => {
  const { seller, account } = await buildAuthorizedAccount('shipped-no-regress');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));

    const orderPayload = { orderId: '405-SHIPPED-NOREGRESS', createdTime: '2026-08-01T00:00:00.000Z', lastUpdatedTime: '2026-08-01T00:00:00.000Z', orderItems: [] };

    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        return {
          status: 200, headers: {},
          data: { order: { ...orderPayload, fulfillment: { fulfillmentStatus: 'SHIPPED' } } },
        };
      }
      return { status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] } };
    });
    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const firstSync = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    assert.equal(firstSync.internal_status, 'SHIPPED');

    // Re-sync where the detail call now fails — falls back to status-less
    // search data, the same way a real throttle/circuit-open would.
    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        return { status: 200, headers: {}, data: { nothingRecognizable: true } };
      }
      return { status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] } };
    });
    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const afterResync = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    assert.equal(afterResync.internal_status, 'SHIPPED', 'a known SHIPPED outcome must survive a sync whose detail call failed');
  });
});

test('a FAILED scheduling attempt is overridden once Amazon confirms the order was shipped directly', async (t) => {
  // Real user report: an order this tool failed to schedule was then
  // shipped by hand via Seller Central — it stayed stuck showing "Failed"
  // forever, because FAILED used to be checked before Amazon's real status
  // and there was nothing left to retry through this tool.
  const { seller, account } = await buildAuthorizedAccount('failed-then-shipped');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));

    const orderPayload = { orderId: '405-FAILED-THEN-SHIPPED', createdTime: '2026-08-01T00:00:00.000Z', lastUpdatedTime: '2026-08-01T00:00:00.000Z', orderItems: [] };
    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        return { status: 200, headers: {}, data: { nothingRecognizable: true } };
      }
      return { status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] } };
    });
    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const synced = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    // Simulates a real scheduling attempt through this tool failing (the same
    // way schedulingService.js marks an order FAILED after Amazon rejects it).
    await ordersRepo.updateInternalStatus(seller.id, synced.id, 'FAILED');

    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        return { status: 200, headers: {}, data: { order: { ...orderPayload, fulfillment: { fulfillmentStatus: 'SHIPPED' } } } };
      }
      return { status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] } };
    });
    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const afterResync = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    assert.equal(afterResync.internal_status, 'SHIPPED', 'a confirmed external shipment must override a stale FAILED status — nothing left to retry');
  });
});

test('a SCHEDULED order is never overridden by external status, even if a re-sync somehow reports something else', async (t) => {
  // The one thing a confirmed external outcome must NOT clobber: a real
  // booking this tool itself already made.
  const { seller, account } = await buildAuthorizedAccount('scheduled-protected');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));

    const orderPayload = { orderId: '405-SCHEDULED-PROTECTED', createdTime: '2026-08-01T00:00:00.000Z', lastUpdatedTime: '2026-08-01T00:00:00.000Z', orderItems: [] };
    t.mock.method(axios, 'request', async () => ({ status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] } }));
    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const synced = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    await ordersRepo.updateInternalStatus(seller.id, synced.id, 'SCHEDULED');

    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        return { status: 200, headers: {}, data: { order: { ...orderPayload, fulfillment: { fulfillmentStatus: 'CANCELLED' } } } };
      }
      return { status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] } };
    });
    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const afterResync = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    assert.equal(afterResync.internal_status, 'SCHEDULED', 'a real booking this tool made must never be overridden by a later external status');
  });
});

test('two concurrent syncs for the same account never run at once — the second is skipped, not doubled up', async (t) => {
  const { seller, account } = await buildAuthorizedAccount('concurrent-guard');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
    let inFlight = 0;
    let sawOverlap = false;
    t.mock.method(axios, 'request', async () => {
      inFlight += 1;
      if (inFlight > 1) sawOverlap = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight -= 1;
      return { status: 200, headers: {}, data: { pagination: {}, orders: [] } };
    });

    const [first, second] = await Promise.all([
      orderSyncService.syncAccount(seller.id, account, 'AMAZON'),
      orderSyncService.syncAccount(seller.id, account, 'AMAZON'),
    ]);

    assert.equal(sawOverlap, false, 'the advisory lock must prevent two syncs for the same account from ever running concurrently');
    const outcomes = [first, second];
    const skipped = outcomes.filter((o) => o.skipped && o.reason === 'already-in-progress');
    const ran = outcomes.filter((o) => !o.skipped);
    assert.equal(skipped.length, 1, 'exactly one caller must be told a sync is already in progress');
    assert.equal(ran.length, 1, 'exactly one caller must actually run the sync');
  });
});

test('an order already scheduled is never pushed back to READY_FOR_REVIEW by a re-sync', async (t) => {
  const { seller, account } = await buildAuthorizedAccount('no-regress');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));

    const orderPayload = {
      orderId: '402-6538125-4261120',
      createdTime: '2026-08-04T13:34:33.433Z',
      lastUpdatedTime: '2026-08-04T17:35:27.372Z',
      orderItems: [],
    };
    t.mock.method(axios, 'request', async () => ({
      status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] },
    }));

    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const firstSync = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    await ordersRepo.updateInternalStatus(seller.id, firstSync.id, 'SCHEDULED');

    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const afterResync = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    assert.equal(afterResync.internal_status, 'SCHEDULED', 'a re-sync must never undo a real scheduling outcome');
  });
});

test('a re-sync of an already-SHIPPED order skips the getOrder detail call entirely', async (t) => {
  // Performance/reliability fix, not just correctness: once an order's
  // outcome is settled, re-fetching its detail on every future sync only
  // burns SP-API rate-limit budget for an answer that can't change. This is
  // what makes it safe for defaultBackfillStart() to cover a whole year
  // instead of 30 days — an old, already-resolved order re-discovered by a
  // wide backfill costs one cheap upsert, not another rate-limited call.
  const { seller, account } = await buildAuthorizedAccount('skip-settled');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));

    const orderPayload = { orderId: '405-SKIP-SETTLED', createdTime: '2026-08-01T00:00:00.000Z', lastUpdatedTime: '2026-08-01T00:00:00.000Z', orderItems: [] };
    let getOrderCalls = 0;
    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        getOrderCalls += 1;
        return { status: 200, headers: {}, data: { order: { ...orderPayload, fulfillment: { fulfillmentStatus: 'SHIPPED' } } } };
      }
      return { status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] } };
    });
    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    assert.equal(getOrderCalls, 1, 'the first sync must still fetch detail — the order is not yet known to be settled');
    const afterFirstSync = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    assert.equal(afterFirstSync.internal_status, 'SHIPPED');

    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    assert.equal(getOrderCalls, 1, 'a re-sync of an order already known SHIPPED must not call getOrder again');
  });
});

test('a re-sync of a FAILED order still calls getOrder — it is not settled, it may yet resolve externally', async (t) => {
  const { seller, account } = await buildAuthorizedAccount('no-skip-failed');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));

    const orderPayload = { orderId: '405-NO-SKIP-FAILED', createdTime: '2026-08-01T00:00:00.000Z', lastUpdatedTime: '2026-08-01T00:00:00.000Z', orderItems: [] };
    let getOrderCalls = 0;
    t.mock.method(axios, 'request', async (config) => {
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        getOrderCalls += 1;
        return { status: 200, headers: {}, data: { nothingRecognizable: true } };
      }
      return { status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] } };
    });
    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    const synced = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    await ordersRepo.updateInternalStatus(seller.id, synced.id, 'FAILED');
    assert.equal(getOrderCalls, 1);

    await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    assert.equal(getOrderCalls, 2, 'a FAILED order must keep being re-checked — it might get shipped externally later');
  });
});

test('defaultBackfillStart covers roughly a year, not the old 30-day rolling window', async (t) => {
  // Real user report this reproduces: three orders created ~30 days ago
  // silently stopped being returned by any future Force Sync (the manual
  // button always does a fresh createdAfter search, never an incremental
  // one) the moment "30 days ago" rolled past their creation date — an
  // already-resolved SHIPPED status the app had once fetched could never be
  // re-applied, because the order was no longer in range to be re-synced at
  // all. Verifies the fix at the boundary that actually broke: an order
  // ~35 days old (inside the old 30-day window's blind spot) must still be
  // found by a fresh (no `since`) sync.
  const { seller, account } = await buildAuthorizedAccount('wide-backfill');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));

    const THIRTY_FIVE_DAYS_AGO = new Date(Date.now() - 35 * 24 * 3600_000).toISOString();
    let capturedCreatedAfter;
    const orderPayload = { orderId: '405-OLD-ORDER', createdTime: THIRTY_FIVE_DAYS_AGO, lastUpdatedTime: THIRTY_FIVE_DAYS_AGO, orderItems: [] };
    t.mock.method(axios, 'request', async (config) => {
      if (config.params?.createdAfter) capturedCreatedAfter = config.params.createdAfter;
      if (config.url.includes('/orders/') && !config.url.endsWith('/orders')) {
        return { status: 200, headers: {}, data: { order: { ...orderPayload, fulfillment: { fulfillmentStatus: 'SHIPPED' } } } };
      }
      return { status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] } };
    });

    const outcome = await orderSyncService.syncAccount(seller.id, account, 'AMAZON');
    assert.equal(outcome.synced, 1, 'a fresh (no `since`) sync must still reach a 35-day-old order');
    const daysBack = (Date.now() - new Date(capturedCreatedAfter).getTime()) / (24 * 3600_000);
    assert.ok(daysBack > 300, `createdAfter must cover well over a month back (got ${daysBack.toFixed(1)} days)`);

    const stored = await ordersRepo.findByExternalOrderId(seller.id, account.id, orderPayload.orderId);
    assert.equal(stored.internal_status, 'SHIPPED');
  });
});

test('a dropped sync-lock connection mid-sync does not crash the process', async (t) => {
  // Real production crash this reproduces: the advisory-lock connection is
  // held open for the whole sync (minutes, on a large account). A checked-
  // out pg client is not covered by pool.on('error', ...) in db/pool.js
  // (idle clients only — node-postgres requires the caller to handle a
  // checked-out one) — an unhandled 'error' event on it throws
  // synchronously and takes down the entire Node process, not just this
  // sync. Verifies syncAccount() now attaches a listener to that connection
  // BEFORE the sync's own work starts, so an error on it mid-sync logs
  // instead of throwing — and the sync itself still completes normally.
  const { seller, account } = await buildAuthorizedAccount('lock-connection-drop');
  await asTenant(seller.id, async () => {
    t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));

    const originalConnect = pool.connect.bind(pool);
    let lockClient;
    let capturedFirst = false;
    t.mock.method(pool, 'connect', async (...args) => {
      const client = await originalConnect(...args);
      if (!capturedFirst) {
        capturedFirst = true;
        lockClient = client; // syncAccount's own lock connection — grabbed before runSync's work
      }
      return client;
    });

    let injected = false;
    let emitThrew = false;
    const orderPayload = { orderId: '405-LOCK-DROP', createdTime: '2026-08-01T00:00:00.000Z', lastUpdatedTime: '2026-08-01T00:00:00.000Z', orderItems: [] };
    t.mock.method(axios, 'request', async (config) => {
      if (!injected && lockClient) {
        injected = true;
        try {
          // Simulates the real network drop — fired while the lock connection
          // is still checked out, i.e. exactly the window that crashed.
          lockClient.emit('error', new Error('Connection terminated unexpectedly'));
        } catch {
          emitThrew = true;
        }
      }
      return { status: 200, headers: {}, data: { pagination: {}, orders: [orderPayload] } };
    });

    const outcome = await orderSyncService.syncAccount(seller.id, account, 'AMAZON');

    assert.ok(lockClient, 'the lock connection must have been captured');
    assert.ok(injected, 'the error must have actually been injected mid-sync');
    assert.equal(emitThrew, false, 'an error on the held lock connection must never throw/crash the process');
    assert.equal(outcome.skipped, false, 'the sync itself must still complete normally despite the lock connection erroring');
  });
});
