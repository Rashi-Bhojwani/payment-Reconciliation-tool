// Marketplace-agnostic scheduling (APP_ARCHITECTURE.md §11–12). This file
// never checks `if (marketplace === 'AMAZON')` — it reads
// `capabilities.supportsBulkScheduling` from the registry and routes
// accordingly. Adding a marketplace with real bulk scheduling changes zero
// lines here.
import crypto from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { getAdapter } from '../integrations/marketplace/registry.js';
import { loadAdapterAccount } from './marketplaceConnectionService.js';
import { InvalidStateError } from '../lib/errors.js';
import { childLogger } from '../lib/logger.js';
import * as ordersRepo from '../db/repositories/orders.js';
import * as packagesRepo from '../db/repositories/packages.js';
import * as shipmentsRepo from '../db/repositories/shipments.js';
import * as marketplaceAccountsRepo from '../db/repositories/marketplaceAccounts.js';
import * as marketplacesRepo from '../db/repositories/marketplaces.js';

const log = childLogger('scheduling');

/**
 * Schedule one or many orders for a single seller. Thin wrapper over
 * scheduleOrderRefs() below — kept because the per-seller order page always
 * has exactly one seller in scope.
 */
export async function scheduleOrders(sellerId, orderIds, userId) {
  return scheduleOrderRefs(orderIds.map((orderId) => ({ sellerId, orderId })), userId);
}

/**
 * Schedule orders that may belong to DIFFERENT sellers — the platform-first
 * "select Amazon, select orders across every connected seller, schedule
 * all" flow (§11/§12: the actual value of bulk scheduling). Every
 * `{ sellerId, orderId }` pair must already be access-checked by the caller
 * (see routes/marketplaces.js) — this function trusts the pairing it's given.
 *
 * Orders are grouped by marketplace account (a bulk call can never span two
 * accounts), and since a marketplace_account_id belongs to exactly one
 * seller, every group is inherently single-seller even when the input spans
 * many. Each group is scheduled bulk or single depending on that
 * marketplace's capabilities. Returns a per-order result so the UI can show
 * which succeeded and which didn't, even within one "Schedule Selected" click.
 */
export async function scheduleOrderRefs(orderRefs, userId) {
  const groups = new Map(); // marketplace_account_id -> orders[]
  const results = [];

  for (const { sellerId, orderId } of orderRefs) {
    const order = await ordersRepo.findById(sellerId, orderId);
    if (!order) {
      results.push({ orderId, ok: false, reason: 'Order not found' });
      continue;
    }
    if (!groups.has(order.marketplace_account_id)) groups.set(order.marketplace_account_id, []);
    groups.get(order.marketplace_account_id).push(order);
  }

  for (const [marketplaceAccountId, orders] of groups) {
    // Every order in a group shares one marketplace_account_id, and an
    // account belongs to exactly one seller — so orders[0].seller_id is
    // correct for the whole group, cross-seller input included.
    const sellerId = orders[0].seller_id;
    const account = await marketplaceAccountsRepo.findById(sellerId, marketplaceAccountId);
    const marketplace = await marketplacesRepo.findById(account.marketplace_id);
    const adapter = getAdapter(marketplace.code);

    if (adapter.capabilities.supportsBulkScheduling && orders.length > 1) {
      const bulkResults = await scheduleBulk(sellerId, userId, account, marketplace.code, orders);
      results.push(...bulkResults);
    } else {
      for (const order of orders) {
        results.push(await scheduleSingle(sellerId, userId, account, marketplace.code, order));
      }
    }
  }

  return results;
}

/** Single-order path — what Amazon (Easy Ship, no bulk support) always takes. */
async function scheduleSingle(sellerId, userId, account, marketplaceCode, order) {
  const orderId = order.id;
  try {
    const pkg = await preflight(sellerId, orderId);
    const idempotencyKey = deterministicIdempotencyKey(account.id, order.external_order_id, pkg.id);

    // Refuse unless the order is actually in a schedulable state, and claim
    // it atomically — a concurrent click cannot schedule the same order
    // twice. FAILED is included alongside READY_TO_SCHEDULE: a failed
    // attempt (a real 403 from Amazon, a transient network error, ...) must
    // be retryable by clicking Schedule again, not a dead end.
    const claimed = await ordersRepo.transitionInternalStatus(
      sellerId, orderId, ['READY_TO_SCHEDULE', 'FAILED'], 'SCHEDULING',
    );
    if (!claimed) {
      return { orderId, ok: false, reason: await notReadyReason(sellerId, orderId) };
    }

    const adapterAccount = await loadAdapterAccount(account, marketplaceCode);
    const adapter = getAdapter(marketplaceCode);

    const shipment = await withTransaction((client) =>
      shipmentsRepo.createPending(
        sellerId,
        { orderId, packageId: pkg.id, marketplaceAccountId: account.id, provider: marketplaceCode, idempotencyKey },
        client,
      ),
    );
    if (!shipment) {
      // The deterministic key (rule R4) collided with a shipment that isn't
      // FAILED — a concurrent attempt is genuinely in flight, or this exact
      // package really is already booked. Either way, we already claimed
      // SCHEDULING above and can't proceed — release that claim rather than
      // leave the order stuck there with nothing actually happening.
      await ordersRepo.updateInternalStatus(sellerId, orderId, 'FAILED');
      return { orderId, ok: false, reason: 'This exact package is already booked or a scheduling attempt is already in progress' };
    }

    try {
      const result = await adapter.scheduleOrder(adapterAccount, { ...order, idempotencyKey }, packageForAdapter(pkg));
      await shipmentsRepo.markScheduled(sellerId, shipment.id, result);
      await ordersRepo.updateInternalStatus(sellerId, orderId, 'SCHEDULED');
      log.info({ sellerId, orderId, shipmentId: shipment.id }, 'order scheduled');
      return { orderId, ok: true, shipmentId: shipment.id };
    } catch (error) {
      await shipmentsRepo.markFailed(sellerId, shipment.id, error.message);
      await ordersRepo.updateInternalStatus(sellerId, orderId, 'FAILED');
      log.warn({ sellerId, orderId, err: error }, 'scheduling failed');
      return { orderId, ok: false, reason: error.message };
    }
  } catch (error) {
    if (error instanceof InvalidStateError) return { orderId, ok: false, reason: error.message };
    throw error;
  }
}

/** Bulk path — exercised once an adapter actually declares supportsBulkScheduling. */
async function scheduleBulk(sellerId, userId, account, marketplaceCode, orders) {
  const prepared = [];
  const results = [];
  for (const order of orders) {
    try {
      const pkg = await preflight(sellerId, order.id);
      // See scheduleSingle's identical claim above — FAILED must be
      // retryable, not a dead end.
      const claimed = await ordersRepo.transitionInternalStatus(
        sellerId, order.id, ['READY_TO_SCHEDULE', 'FAILED'], 'SCHEDULING',
      );
      if (!claimed) {
        results.push({ orderId: order.id, ok: false, reason: await notReadyReason(sellerId, order.id) });
        continue;
      }
      prepared.push({ order, pkg, idempotencyKey: deterministicIdempotencyKey(account.id, order.external_order_id, pkg.id) });
    } catch (error) {
      results.push({ orderId: order.id, ok: false, reason: error.message });
    }
  }
  if (!prepared.length) return results;

  const adapterAccount = await loadAdapterAccount(account, marketplaceCode);
  const adapter = getAdapter(marketplaceCode);

  const shipments = new Map();
  const readyForAdapter = [];
  for (const entry of prepared) {
    const { order, pkg, idempotencyKey } = entry;
    const shipment = await withTransaction((client) =>
      shipmentsRepo.createPending(
        sellerId,
        { orderId: order.id, packageId: pkg.id, marketplaceAccountId: account.id, provider: marketplaceCode, idempotencyKey },
        client,
      ),
    );
    if (!shipment) {
      // Same race as scheduleSingle: the deterministic key collided with a
      // non-FAILED row — release the SCHEDULING claim, this order isn't
      // going to the adapter.
      await ordersRepo.updateInternalStatus(sellerId, order.id, 'FAILED');
      results.push({ orderId: order.id, ok: false, reason: 'This exact package is already booked or a scheduling attempt is already in progress' });
      continue;
    }
    shipments.set(order.id, shipment);
    readyForAdapter.push(entry);
  }
  if (!readyForAdapter.length) return results;

  const bulkResults = await adapter.scheduleOrdersBulk(
    adapterAccount,
    readyForAdapter.map(({ order, pkg, idempotencyKey }) => ({ ...order, idempotencyKey, package: packageForAdapter(pkg) })),
  );

  for (const { order } of readyForAdapter) {
    const shipment = shipments.get(order.id);
    const outcome = bulkResults.find((r) => r.externalOrderId === order.external_order_id);
    if (outcome?.ok) {
      await shipmentsRepo.markScheduled(sellerId, shipment.id, outcome);
      await ordersRepo.updateInternalStatus(sellerId, order.id, 'SCHEDULED');
      results.push({ orderId: order.id, ok: true, shipmentId: shipment.id });
    } else {
      const reason = outcome?.reason ?? 'Bulk scheduling did not return a result for this order';
      await shipmentsRepo.markFailed(sellerId, shipment.id, reason);
      await ordersRepo.updateInternalStatus(sellerId, order.id, 'FAILED');
      results.push({ orderId: order.id, ok: false, reason });
    }
  }
  return results;
}

/**
 * transitionInternalStatus() failed its precondition — report the order's
 * actual current status rather than a canned, potentially wrong guess. A
 * prior version of this message unconditionally said "already scheduled or
 * cancelled", which was flatly false for the (common) case of retrying a
 * FAILED order before FAILED was added to the allowed source statuses above
 * — clicking Schedule again after a real failure (e.g. Amazon's own 403)
 * reported a misleading reason instead of the true one.
 */
async function notReadyReason(sellerId, orderId) {
  const order = await ordersRepo.findById(sellerId, orderId);
  const status = order?.internal_status ?? 'unknown';
  return `Order is not ready to schedule (current status: ${status})`;
}

/**
 * Rule from §15: refuse to schedule unless every required package field is
 * present. Throws InvalidStateError naming exactly what's missing — this is
 * the one function the UI's "Schedule" button check and the actual guard
 * share, so they can never disagree.
 */
async function preflight(sellerId, orderId) {
  const order = await ordersRepo.findById(sellerId, orderId);
  if (!order) throw new InvalidStateError('Order not found');
  if (order.internal_status === 'CANCELLED') {
    throw new InvalidStateError('This order was cancelled and cannot be scheduled');
  }
  if (order.internal_status === 'SHIPPED') {
    // Set by orderSyncService from Amazon's own confirmed fulfillmentStatus
    // — the order was already shipped directly via Seller Central, outside
    // this tool, before it was ever synced here. Nothing to schedule.
    throw new InvalidStateError('This order was already shipped via Seller Central and cannot be scheduled');
  }
  const pkg = await packagesRepo.getOrCreatePrimary(sellerId, orderId);
  if (!packagesRepo.isComplete(pkg)) {
    const missing = packagesRepo.missingFields(pkg);
    throw new InvalidStateError(`${missing.join(', ')} required before scheduling this order.`);
  }
  return pkg;
}

function packageForAdapter(pkg) {
  return {
    weightGrams: pkg.weight_grams,
    lengthCm: pkg.length_cm,
    widthCm: pkg.width_cm,
    heightCm: pkg.height_cm,
    packageType: pkg.package_type,
  };
}

/** Deterministic — rule R4: a retried scheduling call can never double-book. */
function deterministicIdempotencyKey(marketplaceAccountId, externalOrderId, packageId) {
  return crypto
    .createHash('sha256')
    .update(`${marketplaceAccountId}:${externalOrderId}:${packageId}`)
    .digest('hex')
    .slice(0, 64);
}
