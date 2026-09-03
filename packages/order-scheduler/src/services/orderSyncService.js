// The generic Order Sync Engine (APP_ARCHITECTURE.md §9). Zero
// marketplace-specific code lives here — everything about pagination, rate
// limits and response shape is the adapter's problem; this file only knows
// the unified order model.
import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { getAdapter } from '../integrations/marketplace/registry.js';
import { loadAdapterAccount, markRevoked } from './marketplaceConnectionService.js';
import { encryptJson, decryptJson } from '../lib/crypto.js';
import { config } from '../config.js';
import { childLogger } from '../lib/logger.js';
import * as ordersRepo from '../db/repositories/orders.js';
import * as orderItemsRepo from '../db/repositories/orderItems.js';
import * as syncStateRepo from '../db/repositories/marketplaceAccountSyncState.js';
import { SpApiAuthError } from '../integrations/amazon/errors.js';

const log = childLogger('order-sync');

// Statuses at or beyond this point in the lifecycle must never be pushed
// back to READY_FOR_REVIEW by a re-sync (e.g. a reconciliation pass hitting
// an order the operator has already scheduled). SHIPPED/CANCELLED here are
// this tool's OWN internal_status values, set below from Amazon's real
// fulfillment status once known — they must stick even if a later sync's
// getOrder detail call fails and falls back to search data alone (which
// carries no status at all), the same protection SCHEDULED already had.
//
// FAILED is here too, but ONLY protects against the no-status fallback —
// nextStatus() below checks a confirmed external outcome FIRST and lets it
// override FAILED. Real bug this fixes: an order whose scheduling attempt
// failed in this tool, then got shipped directly via Seller Central
// afterwards, stayed stuck showing "Failed" forever — FAILED used to be
// checked ahead of Amazon's real status, so a re-sync could never move it
// off FAILED even once Amazon confirmed SHIPPED. SCHEDULED/SCHEDULING are
// NOT overridable this way (see nextStatus) — those are real outcomes THIS
// tool itself already achieved or has in flight right now.
const TERMINAL_OR_IN_FLIGHT = new Set(['SCHEDULING', 'SCHEDULED', 'FAILED', 'CANCELLED', 'SHIPPED']);

// Existing statuses a confirmed external outcome (see EXTERNALLY_HANDLED_STATUS
// below) must never override — a real result THIS tool already produced.
const PROTECTED_FROM_EXTERNAL_OVERRIDE = new Set(['SCHEDULED', 'SCHEDULING']);

// An order in one of these already has its final outcome — the expensive
// per-order getOrder call below is skipped for them entirely (see the loop).
// Deliberately excludes FAILED: that one is NOT final (a stalled scheduling
// attempt in this tool must keep being re-checked in case Amazon shows the
// order was shipped/cancelled directly afterwards).
const SETTLED_STATUSES = new Set(['SCHEDULED', 'SHIPPED', 'CANCELLED']);

// Amazon's real fulfillment.fulfillmentStatus values (from getOrder — see
// AmazonAdapter.js's normalizeGetOrder) that mean an order was already
// handled directly in Seller Central, entirely outside this tool, before
// this app ever saw it — confirmed live for accounts with fulfillment
// history predating this app's use. Only values actually observed in a
// live response are mapped here; an unrecognized or missing status (search
// data alone, or a getOrder detail fetch that failed this sync) always
// falls through to the normal READY_FOR_REVIEW path rather than being
// guessed at.
const EXTERNALLY_HANDLED_STATUS = { CANCELLED: 'CANCELLED', SHIPPED: 'SHIPPED' };

/**
 * Pull and store orders for one marketplace account. `since` is a cursor
 * (Date) for an incremental sync, or undefined for a first-time backfill.
 *
 * Guarded by a Postgres session-level advisory lock keyed to this account:
 * real production logs showed the scheduled reconciliation sweep (worker.js
 * — hourly, and again on every worker restart) and a manual "Force Sync"
 * click both calling this function for the SAME account at the same time.
 * They're separate processes sharing nothing but Postgres, so both ended up
 * hammering SP-API's getOrder for the same ~100 orders concurrently,
 * doubling the load against one shared rate limit/circuit breaker (http.js
 * keys both by marketplaceAccountId) and turning an already slow sync into
 * one that throttled itself into a CircuitOpenError and failed outright — a
 * real 15-minute request that ended in a 503 is what surfaced this. The
 * lock makes only one sync run at a time per account, regardless of which
 * process asked for it; a losing caller returns immediately instead of
 * piling onto the same budget.
 */
export async function syncAccount(sellerId, marketplaceAccount, marketplaceCode, { since } = {}) {
  const adapter = getAdapter(marketplaceCode);
  if (!adapter.capabilities.supportsOrderSync) {
    log.info({ marketplaceCode }, 'marketplace does not support order sync, skipping');
    return { synced: 0, skipped: true, reason: 'not-supported' };
  }

  const lockClient = await pool.connect();
  // Real crash this fixes: this client is held open for the whole sync
  // (minutes, on a large account) — a checked-out pg client is NOT covered
  // by pool.on('error', ...) in db/pool.js (that only catches IDLE clients;
  // node-postgres requires the caller to handle a checked-out one). If the
  // underlying connection drops mid-sync (a real network hiccup to a remote
  // RDS instance over a multi-minute hold is exactly the kind of thing that
  // happens), pg emits a bare 'error' event with no listener — Node treats
  // that as an uncaught exception and crashes the ENTIRE process, taking
  // down every other request in flight, not just this sync. This handler is
  // the fix: log it and move on. Nothing else here depends on lockClient
  // staying alive — runSync() does its own work through separate pool
  // connections — and Postgres releases a session-level advisory lock
  // automatically the moment its owning connection closes, so a dropped
  // lockClient already means the lock is gone; there's nothing left to
  // clean up for it beyond not crashing. Named and explicitly removed in
  // the finally block below: pg-pool reuses the same underlying Client
  // across many checkouts, so an anonymous listener added on every sync and
  // never removed accumulates forever — a real (if slow) leak in a
  // long-running server, and Node warns loudly past 10 listeners.
  const onLockError = (error) => {
    log.error({ err: error, marketplaceAccountId: marketplaceAccount.id }, 'sync lock connection dropped mid-sync');
  };
  lockClient.on('error', onLockError);
  const lockKey = advisoryLockKey(marketplaceAccount.id);
  try {
    const { rows: [{ locked }] } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
    if (!locked) {
      log.info({ marketplaceAccountId: marketplaceAccount.id }, 'sync already in progress for this account, skipping');
      return { synced: 0, skipped: true, reason: 'already-in-progress' };
    }

    return await runSync(sellerId, marketplaceAccount, marketplaceCode, adapter, since);
  } finally {
    // Both wrapped individually (not just the query) — release() itself
    // must never be allowed to throw here either, on a connection that may
    // already be dead.
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    } catch (error) {
      log.warn({ err: error, marketplaceAccountId: marketplaceAccount.id }, 'failed to release sync advisory lock');
    }
    lockClient.removeListener('error', onLockError);
    try {
      lockClient.release();
    } catch (error) {
      log.warn({ err: error, marketplaceAccountId: marketplaceAccount.id }, 'failed to return sync lock connection to the pool');
    }
  }
}

async function runSync(sellerId, marketplaceAccount, marketplaceCode, adapter, since) {
  const account = await loadAdapterAccount(marketplaceAccount, marketplaceCode);
  let synced = 0;
  let cursor;

  try {
    let nextCursor = null;
    do {
      const query = since
        ? { lastUpdatedAfter: since.toISOString(), nextToken: nextCursor ?? undefined }
        : { createdAfter: defaultBackfillStart().toISOString(), nextToken: nextCursor ?? undefined };

      const { orders, nextCursor: pageCursor } = await adapter.getOrders(account, query);
      for (const summary of orders) {
        const existing = await ordersRepo.findByExternalOrderId(sellerId, marketplaceAccount.id, summary.externalOrderId);
        // getOrders() (search) has no order status at all (confirmed
        // against a live response). An account with fulfillment history
        // predating this app needs that status: without it, every order
        // synced looks identical to one that still needs scheduling, even
        // one already shipped weeks ago straight from Seller Central. This
        // per-order detail call is wrapped so a failure (throttling, a
        // shape mismatch) logs and this order still saves with whatever
        // search already gave it, rather than losing the sync over one bad
        // order.
        //
        // SETTLED orders skip the call entirely — their outcome is already
        // known and nextStatus() protects it, so re-checking Amazon can
        // never change what's stored (except FAILED, deliberately excluded:
        // it's the one non-final state where a later confirmed SHIPPED/
        // CANCELLED must still be allowed to land — see nextStatus()). This
        // is what makes a wide defaultBackfillStart() window (below) cheap:
        // once an account's history settles into mostly SHIPPED/CANCELLED/
        // SCHEDULED, most orders a backfill re-discovers cost one cheap
        // upsert, not another rate-limited API call.
        let full = summary;
        if (!existing || !SETTLED_STATUSES.has(existing.internal_status)) {
          try {
            const detail = await adapter.getOrder(account, summary.externalOrderId);
            full = { ...summary, ...detail, items: detail.items?.length ? detail.items : summary.items };
          } catch (error) {
            log.warn(
              { err: error, marketplaceAccountId: marketplaceAccount.id, externalOrderId: summary.externalOrderId },
              'could not fetch order detail — status/ship-by dates unavailable for this order this sync',
            );
          }
        }
        await upsertNormalizedOrder(sellerId, marketplaceAccount, marketplaceCode, full);
        synced += 1;
      }
      nextCursor = pageCursor;
    } while (nextCursor);

    cursor = new Date();
    await syncStateRepo.recordSuccess(marketplaceAccount.id, cursor);
  } catch (error) {
    if (error instanceof SpApiAuthError) {
      // Revoked/invalid credentials — halt this account, don't keep retrying
      // a sync that can never succeed until the seller re-authorises.
      await markRevoked(marketplaceAccount.id, error.message);
    }
    await syncStateRepo.recordFailure(marketplaceAccount.id, {
      openUntil: new Date(Date.now() + 15 * 60_000),
    });
    throw error;
  }

  log.info({ sellerId, marketplaceAccountId: marketplaceAccount.id, synced }, 'order sync complete');
  return { synced, skipped: false, cursor };
}

/**
 * pg_try_advisory_lock takes a signed 64-bit integer — the first 8 bytes of
 * a stable hash of the account id, read as a signed BigInt (same technique
 * as schedulingService.js's deterministicIdempotencyKey, just narrower).
 */
function advisoryLockKey(marketplaceAccountId) {
  const hash = crypto.createHash('sha256').update(`order-sync:${marketplaceAccountId}`).digest();
  return hash.readBigInt64BE(0).toString();
}

async function upsertNormalizedOrder(sellerId, marketplaceAccount, marketplaceCode, normalized) {
  return withTransaction(async (client) => {
    const existing = await ordersRepo.findByExternalOrderId(
      sellerId, marketplaceAccount.id, normalized.externalOrderId, client,
    );
    const internalStatus = nextStatus(existing?.internal_status, normalized.marketplaceStatus);

    const pii = buildPiiColumns(normalized);
    const order = await ordersRepo.upsertFromMarketplace(
      sellerId,
      {
        marketplaceId: marketplaceAccount.marketplace_id,
        marketplaceAccountId: marketplaceAccount.id,
        externalOrderId: normalized.externalOrderId,
        orderDate: normalized.orderDate,
        lastUpdatedDate: normalized.lastUpdatedDate,
        marketplaceStatus: normalized.marketplaceStatus,
        internalStatus,
        fulfillmentChannel: normalized.fulfillmentChannel,
        shipServiceLevel: normalized.shipServiceLevel,
        isPrime: normalized.isPrime,
        isBusinessOrder: normalized.isBusinessOrder,
        earliestShipDate: normalized.earliestShipDate,
        shipByDate: normalized.shipByDate,
        deliveryByDate: normalized.deliveryByDate,
        orderTotalAmount: normalized.orderTotalAmount,
        orderTotalCurrency: normalized.orderTotalCurrency,
        rawResponse: normalized.rawResponse,
      },
      pii,
      client,
    );

    if (normalized.items?.length) {
      await orderItemsRepo.upsertMany(sellerId, order.id, normalized.items, client);
    }
    return order;
  });
}

/**
 * NEW/SYNCED orders land as READY_FOR_REVIEW — this application has no
 * auto-approval (no AI, no confidence gate), so every order needs a human
 * to enter package info regardless — UNLESS Amazon's own real status says
 * the order was already handled directly in Seller Central (shipped or
 * cancelled) before this app ever saw it, in which case there is nothing
 * for this tool to do and it's marked accordingly instead.
 *
 * A confirmed external outcome is checked FIRST and wins over almost
 * everything, including a previous FAILED scheduling attempt in this tool —
 * real bug this fixes: an order this tool failed to schedule, then the
 * seller shipped directly via Seller Central, stayed stuck showing "Failed"
 * forever, because FAILED used to be checked before Amazon's real status
 * and there was nothing left to retry. The two things it must NOT override
 * are SCHEDULED and SCHEDULING (PROTECTED_FROM_EXTERNAL_OVERRIDE) — a real
 * outcome this tool itself already produced or has in flight right now, not
 * a guess to be second-guessed by a later status check.
 *
 * Once neither of those applies, the existing TERMINAL_OR_IN_FLIGHT check
 * protects a known outcome (including a FAILED that's still genuinely
 * unresolved) from a sync whose getOrder detail call failed and fell back
 * to status-less search data alone.
 */
function nextStatus(existingStatus, marketplaceStatus) {
  const externallyHandled = EXTERNALLY_HANDLED_STATUS[marketplaceStatus];
  if (externallyHandled && !PROTECTED_FROM_EXTERNAL_OVERRIDE.has(existingStatus)) {
    return externallyHandled;
  }
  if (existingStatus && TERMINAL_OR_IN_FLIGHT.has(existingStatus)) return existingStatus;
  return 'READY_FOR_REVIEW';
}

/**
 * The orders table gives buyer_name_enc / shipping_address_enc /
 * buyer_phone_enc exactly ONE shared pii_iv / pii_auth_tag pair (see
 * 001_init.sql). AES-256-GCM must never reuse an IV to encrypt more than one
 * independent plaintext under the same key — doing so breaks both
 * confidentiality and the authentication guarantee. So all buyer PII is
 * encrypted together, ONCE, as a single bundle stored in buyer_name_enc;
 * shipping_address_enc and buyer_phone_enc are left NULL rather than holding
 * a second, misleadingly-independent copy of the same ciphertext.
 * decryptOrderPii() below is the one place that un-bundles it.
 */
function buildPiiColumns(normalized) {
  const hasPii = normalized.buyerName || normalized.shippingAddress;
  if (!hasPii) return {};

  const bundle = encryptJson({
    name: normalized.buyerName ?? null,
    address: normalized.shippingAddress ?? null,
    phone: normalized.shippingAddress?.Phone ?? null,
  });
  return {
    buyerNameEnc: bundle.ciphertext,
    shippingAddressEnc: null,
    buyerPhoneEnc: null,
    iv: bundle.iv,
    authTag: bundle.authTag,
  };
}

/**
 * The read-side counterpart of buildPiiColumns — decrypts the one bundle.
 * Note: unlike marketplace_account_credentials, the orders table has no
 * per-row key_version column for its PII (a gap in the inherited schema) —
 * decryption always assumes the current configured key. A future migration
 * should add orders.pii_key_version before rotating ENCRYPTION_KEY in a
 * deployment with real, undeleted order PII on disk.
 */
export function decryptOrderPii(order) {
  if (!order.buyer_name_enc || !order.pii_iv || !order.pii_auth_tag) return null;
  return decryptJson({
    ciphertext: order.buyer_name_enc,
    iv: order.pii_iv,
    authTag: order.pii_auth_tag,
    keyVersion: config.crypto.keyVersion,
  });
}

/**
 * Real bug this fixes: this was 30 days, and it's a ROLLING window —
 * recomputed from Date.now() on every single Force Sync (the manual sync
 * button never has a `since` cursor to fall back on incremental
 * lastUpdatedAfter — see runSync). An order created more than 30 days ago
 * simply stopped being returned by search at all once that day rolled past,
 * regardless of anything about the order itself — permanently orphaning it
 * from every future sync, bug fixes included: a user's real, confirmed
 * report was orders sitting stuck exactly at the 30-day mark, showing
 * "Marketplace status: SHIPPED" (the app HAD once fetched the truth) next
 * to internal_status "Ready For Review" (a stale value from before earlier
 * fixes landed) that no future Force Sync could ever correct, because the
 * order had already aged out of the window before those fixes shipped.
 * Widened to a year — safe to be generous now that the sync loop skips the
 * expensive per-order getOrder call entirely for orders already SETTLED
 * (see SETTLED_STATUSES above), so re-discovering an old, already-resolved
 * order on a wide backfill costs one cheap upsert, not another rate-limited
 * SP-API call.
 */
function defaultBackfillStart() {
  const ONE_YEAR_MS = 365 * 24 * 3600_000;
  return new Date(Date.now() - ONE_YEAR_MS);
}
