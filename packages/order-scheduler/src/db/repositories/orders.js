// Orders. Rule R1: sellerId is the first argument of every function and is
// always in the WHERE clause. Rule R4 (idempotency) carries forward: writes
// are upserts keyed on (marketplace_account_id, external_order_id), so an
// at-least-once notification delivery is harmless.
//
// The encrypted PII columns are deliberately NOT in the default projection.
import { query } from '../pool.js';

const COLUMNS = `id, seller_id, marketplace_id, marketplace_account_id, external_order_id,
  order_date, last_updated_date, marketplace_status, internal_status, fulfillment_channel,
  ship_service_level, is_prime, is_business_order, earliest_ship_date, ship_by_date,
  delivery_by_date, order_total_amount, order_total_currency, pii_purged_at,
  created_at, updated_at`;

/**
 * The only function that returns encrypted PII columns. Named so any call
 * site is obvious in review; callers must audit the access (req.auditPii())
 * before decrypting. See services/orderSyncService.js#decryptOrderPii.
 */
export async function findPiiById(sellerId, orderId, client) {
  const { rows } = await query(
    `SELECT id, buyer_name_enc, shipping_address_enc, buyer_phone_enc, pii_iv, pii_auth_tag, pii_purged_at
       FROM orders WHERE seller_id = $1 AND id = $2`,
    [sellerId, orderId],
    client,
  );
  return rows[0] ?? null;
}

export async function findById(sellerId, orderId, client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM orders WHERE seller_id = $1 AND id = $2`,
    [sellerId, orderId],
    client,
  );
  return rows[0] ?? null;
}

/**
 * Resolves which seller owns an order, WITHOUT checking whether the caller
 * may see it. Exists only for the cross-seller bulk-schedule flow (picking a
 * platform, not a seller, is the primary navigation — see
 * routes/marketplaces.js), which must discover an order's seller before it
 * can check that seller against the caller's accessible set. Every other
 * read still goes through a sellerId-scoped function; the caller here is
 * responsible for the access check immediately after calling this.
 */
export async function findSellerIdForOrder(orderId, client) {
  const { rows } = await query('SELECT seller_id FROM orders WHERE id = $1', [orderId], client);
  return rows[0]?.seller_id ?? null;
}

/**
 * Orders for one marketplace across every seller in `sellerIds` — the
 * platform-first "select Amazon, see every ready order across every
 * connected seller" view. `sellerIds` is computed by the caller from
 * verified access (sellersRepo.listAccessibleIds), never from a query
 * parameter — same rule as packagesRepo.listNeedingReview used to follow.
 */
export async function listForMarketplace(
  marketplaceId,
  sellerIds,
  { internalStatus, excludeInternalStatuses, search, limit = 50, offset = 0 } = {},
  client,
) {
  if (!sellerIds?.length) return { rows: [], total: 0 };
  const params = [marketplaceId, sellerIds];
  const where = ['o.marketplace_id = $1', 'o.seller_id = ANY($2::uuid[])'];

  if (internalStatus) {
    params.push(internalStatus);
    where.push(`o.internal_status = $${params.length}`);
  } else if (excludeInternalStatuses?.length) {
    params.push(excludeInternalStatuses);
    where.push(`o.internal_status <> ALL($${params.length})`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(o.external_order_id ILIKE $${params.length} OR t.company_name ILIKE $${params.length})`);
  }
  params.push(Math.min(limit, 200), offset);

  const { rows } = await query(
    `SELECT ${COLUMNS.split(',').map((c) => `o.${c.trim()}`).join(', ')},
            t.company_name AS seller_name,
            COUNT(*) OVER () AS total_count,
            (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id)::int AS item_count
       FROM orders o
       JOIN public.tenants t ON t.id = o.seller_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.order_date DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client,
  );
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { rows: rows.map(({ total_count, ...row }) => row), total };
}

export async function findByExternalOrderId(sellerId, marketplaceAccountId, externalOrderId, client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM orders
      WHERE seller_id = $1 AND marketplace_account_id = $2 AND external_order_id = $3`,
    [sellerId, marketplaceAccountId, externalOrderId],
    client,
  );
  return rows[0] ?? null;
}

/**
 * Filtered, paginated order list for one seller, optionally narrowed to one
 * marketplace account. `search` matches the external order id or any item
 * SKU/external product id on the order.
 */
export async function list(
  sellerId,
  { marketplaceAccountId, internalStatus, excludeInternalStatuses, from, to, search, limit = 50, offset = 0 } = {},
  client,
) {
  const params = [sellerId];
  const where = ['o.seller_id = $1'];

  if (marketplaceAccountId) {
    params.push(marketplaceAccountId);
    where.push(`o.marketplace_account_id = $${params.length}`);
  }
  if (internalStatus) {
    params.push(internalStatus);
    where.push(`o.internal_status = $${params.length}`);
  } else if (excludeInternalStatuses?.length) {
    // The default "not yet scheduled" view (no explicit ?status= filter
    // chosen) — everything except the terminal, done-with-it statuses.
    params.push(excludeInternalStatuses);
    where.push(`o.internal_status <> ALL($${params.length})`);
  }
  if (from) {
    params.push(from);
    where.push(`o.order_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`o.order_date <= $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const p = params.length;
    where.push(`(o.external_order_id ILIKE $${p} OR EXISTS (
        SELECT 1 FROM order_items i
         WHERE i.order_id = o.id AND i.seller_id = o.seller_id
           AND (i.external_product_id ILIKE $${p} OR i.sku ILIKE $${p})))`);
  }

  params.push(Math.min(limit, 200), offset);
  const { rows } = await query(
    `SELECT ${COLUMNS.split(',').map((c) => `o.${c.trim()}`).join(', ')},
            m.code AS marketplace_code, m.name AS marketplace_name,
            COUNT(*) OVER () AS total_count,
            (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id)::int AS item_count
       FROM orders o
       JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.order_date DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client,
  );
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { rows: rows.map(({ total_count, ...row }) => row), total };
}

export async function countsByInternalStatus(sellerId, client) {
  const { rows } = await query(
    `SELECT internal_status, COUNT(*)::int AS count
       FROM orders WHERE seller_id = $1 GROUP BY internal_status`,
    [sellerId],
    client,
  );
  return Object.fromEntries(rows.map((r) => [r.internal_status, r.count]));
}

/**
 * Idempotent write of an order pulled from a marketplace (rule R4).
 * `piiColumns` carries already-encrypted buffers; optional so callers that
 * only know the business fields cannot accidentally blank stored PII.
 */
export async function upsertFromMarketplace(sellerId, order, piiColumns, client) {
  const pii = piiColumns ?? {};
  const { rows } = await query(
    `INSERT INTO orders (
        seller_id, marketplace_id, marketplace_account_id, external_order_id,
        order_date, last_updated_date, marketplace_status, internal_status,
        fulfillment_channel, ship_service_level, is_prime, is_business_order,
        earliest_ship_date, ship_by_date, delivery_by_date,
        order_total_amount, order_total_currency,
        buyer_name_enc, shipping_address_enc, buyer_phone_enc, pii_iv, pii_auth_tag,
        raw_response, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'NEW'),$9,$10,$11,$12,$13,$14,$15,$16,$17,
             $18,$19,$20,$21,$22,$23,NOW())
     ON CONFLICT (marketplace_account_id, external_order_id) DO UPDATE SET
        order_date           = EXCLUDED.order_date,
        last_updated_date    = EXCLUDED.last_updated_date,
        marketplace_status   = EXCLUDED.marketplace_status,
        -- internal_status was missing from this list entirely — a real bug
        -- that silently discarded orderSyncService.nextStatus()'s computed
        -- value on every re-sync of an order that already existed (i.e.
        -- every order after its very first sync). It only ever applied on a
        -- brand new INSERT, so an order kept whatever internal_status it
        -- got the first time it was ever synced — usually READY_FOR_REVIEW,
        -- since Amazon's real status wasn't even readable until getOrder's
        -- schema was fixed — forever after, no matter what a later sync
        -- recomputed (Amazon confirming SHIPPED/CANCELLED included). Safe
        -- to write unconditionally here: nextStatus() already decides
        -- upstream whether to keep a terminal/in-flight status or move on,
        -- so its result is always the correct final answer, not a guess.
        internal_status      = EXCLUDED.internal_status,
        fulfillment_channel  = EXCLUDED.fulfillment_channel,
        ship_service_level   = EXCLUDED.ship_service_level,
        is_prime             = EXCLUDED.is_prime,
        is_business_order    = EXCLUDED.is_business_order,
        earliest_ship_date   = EXCLUDED.earliest_ship_date,
        ship_by_date         = EXCLUDED.ship_by_date,
        delivery_by_date     = EXCLUDED.delivery_by_date,
        order_total_amount   = EXCLUDED.order_total_amount,
        order_total_currency = EXCLUDED.order_total_currency,
        -- Never overwrite stored PII with NULL, and never resurrect purged PII.
        buyer_name_enc       = CASE WHEN orders.pii_purged_at IS NULL
                                    THEN COALESCE(EXCLUDED.buyer_name_enc, orders.buyer_name_enc)
                                    ELSE NULL END,
        shipping_address_enc = CASE WHEN orders.pii_purged_at IS NULL
                                    THEN COALESCE(EXCLUDED.shipping_address_enc, orders.shipping_address_enc)
                                    ELSE NULL END,
        buyer_phone_enc      = CASE WHEN orders.pii_purged_at IS NULL
                                    THEN COALESCE(EXCLUDED.buyer_phone_enc, orders.buyer_phone_enc)
                                    ELSE NULL END,
        pii_iv               = CASE WHEN orders.pii_purged_at IS NULL
                                    THEN COALESCE(EXCLUDED.pii_iv, orders.pii_iv) ELSE NULL END,
        pii_auth_tag         = CASE WHEN orders.pii_purged_at IS NULL
                                    THEN COALESCE(EXCLUDED.pii_auth_tag, orders.pii_auth_tag) ELSE NULL END,
        raw_response         = COALESCE(EXCLUDED.raw_response, orders.raw_response),
        updated_at           = NOW()
     RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
    [
      sellerId,
      order.marketplaceId,
      order.marketplaceAccountId,
      order.externalOrderId,
      order.orderDate,
      order.lastUpdatedDate,
      order.marketplaceStatus ?? null,
      order.internalStatus ?? null,
      order.fulfillmentChannel ?? null,
      order.shipServiceLevel ?? null,
      order.isPrime ?? false,
      order.isBusinessOrder ?? false,
      order.earliestShipDate ?? null,
      order.shipByDate ?? null,
      order.deliveryByDate ?? null,
      order.orderTotalAmount ?? null,
      order.orderTotalCurrency ?? null,
      pii.buyerNameEnc ?? null,
      pii.shippingAddressEnc ?? null,
      pii.buyerPhoneEnc ?? null,
      pii.iv ?? null,
      pii.authTag ?? null,
      order.rawResponse ?? null,
    ],
    client,
  );
  return rows[0];
}

/** Status transitions always name the seller, even though id alone is unique. */
export async function updateInternalStatus(sellerId, orderId, internalStatus, client) {
  const { rows } = await query(
    `UPDATE orders SET internal_status = $3, updated_at = NOW()
      WHERE seller_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [sellerId, orderId, internalStatus],
    client,
  );
  return rows[0] ?? null;
}

/**
 * Conditional transition: only moves the row when it is in one of
 * `fromStatuses`. Returns null when the precondition failed, which is how
 * the scheduling job detects that an order was cancelled or already
 * scheduled underneath it.
 */
export async function transitionInternalStatus(sellerId, orderId, fromStatuses, toStatus, client) {
  const { rows } = await query(
    `UPDATE orders SET internal_status = $4, updated_at = NOW()
      WHERE seller_id = $1 AND id = $2 AND internal_status = ANY($3)
      RETURNING ${COLUMNS}`,
    [sellerId, orderId, fromStatuses, toStatus],
    client,
  );
  return rows[0] ?? null;
}
