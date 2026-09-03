// Booked shipments. `idempotency_key` is unique across the table — rule R4's
// guarantee that a retried scheduling call cannot double-book a pickup.
import { query } from '../pool.js';

const COLUMNS = `id, order_id, package_id, seller_id, marketplace_account_id, provider,
  external_shipment_id, tracking_id, carrier_name, scheduled_pickup_start, scheduled_pickup_end,
  label_url, invoice_url, status, confirmed_at, idempotency_key, error_message, created_at`;

export async function findById(sellerId, shipmentId, client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM shipments WHERE seller_id = $1 AND id = $2`,
    [sellerId, shipmentId],
    client,
  );
  return rows[0] ?? null;
}

export async function findByIdempotencyKey(sellerId, idempotencyKey, client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM shipments WHERE seller_id = $1 AND idempotency_key = $2`,
    [sellerId, idempotencyKey],
    client,
  );
  return rows[0] ?? null;
}

export async function listByOrder(sellerId, orderId, client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM shipments
      WHERE seller_id = $1 AND order_id = $2 ORDER BY created_at DESC`,
    [sellerId, orderId],
    client,
  );
  return rows;
}

/** Cross-seller list for the shipments page; caller supplies verified ids. */
export async function list(sellerIds, { status, search, limit = 50, offset = 0 } = {}, client) {
  if (!sellerIds?.length) return { rows: [], total: 0 };
  const params = [sellerIds];
  const where = ['sh.seller_id = ANY($1::uuid[])'];

  if (status) {
    params.push(status);
    where.push(`sh.status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(sh.tracking_id ILIKE $${params.length} OR o.external_order_id ILIKE $${params.length})`);
  }
  params.push(Math.min(limit, 200), offset);

  const { rows } = await query(
    `SELECT ${COLUMNS.split(',').map((c) => `sh.${c.trim()}`).join(', ')},
            COUNT(*) OVER () AS total_count,
            o.external_order_id, o.ship_by_date, s.seller_name, s.timezone,
            m.code AS marketplace_code
       FROM shipments sh
       JOIN orders  o ON o.id = sh.order_id AND o.seller_id = sh.seller_id
       JOIN sellers s ON s.id = sh.seller_id
       JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE ${where.join(' AND ')}
      ORDER BY sh.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client,
  );
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { rows: rows.map(({ total_count, ...row }) => row), total };
}

/**
 * Claims the idempotency key before the marketplace call is made — an
 * UPSERT, not a plain INSERT. The same order+package always produces the
 * same deterministic key (rule R4), so a *retry* after a real failure hits
 * this exact row, not a fresh one: reset it back to PENDING and reuse it
 * rather than colliding with it. Only a FAILED row is reusable this way —
 * if it's PENDING (a concurrent attempt genuinely in flight) or SCHEDULED
 * (already really booked), the conflict is left untouched and this returns
 * null, which the caller reads as "can't proceed, this is already spoken
 * for" rather than letting a raw 23505 crash all the way up.
 */
export async function createPending(sellerId, { orderId, packageId, marketplaceAccountId, provider, idempotencyKey }, client) {
  const { rows } = await query(
    `INSERT INTO shipments (order_id, package_id, seller_id, marketplace_account_id, provider, status, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,'PENDING',$6)
     ON CONFLICT (idempotency_key) DO UPDATE
        SET status = 'PENDING', error_message = NULL
      WHERE shipments.status = 'FAILED'
     RETURNING ${COLUMNS}`,
    [orderId, packageId, sellerId, marketplaceAccountId, provider, idempotencyKey],
    client,
  );
  return rows[0] ?? null;
}

export async function markScheduled(sellerId, shipmentId, result, client) {
  const { rows } = await query(
    `UPDATE shipments
        SET status = 'SCHEDULED',
            external_shipment_id = $3, tracking_id = $4, carrier_name = $5,
            scheduled_pickup_start = $6, scheduled_pickup_end = $7,
            label_url = $8, invoice_url = $9,
            confirmed_at = NOW(), error_message = NULL
      WHERE seller_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [sellerId, shipmentId, result.externalShipmentId ?? null, result.trackingId ?? null,
     result.carrierName ?? null, result.pickupStart ?? null, result.pickupEnd ?? null,
     result.labelUrl ?? null, result.invoiceUrl ?? null],
    client,
  );
  return rows[0] ?? null;
}

export async function markFailed(sellerId, shipmentId, message, client) {
  const { rows } = await query(
    `UPDATE shipments SET status = 'FAILED', error_message = $3
      WHERE seller_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [sellerId, shipmentId, String(message).slice(0, 2000)],
    client,
  );
  return rows[0] ?? null;
}

export async function updateStatus(sellerId, shipmentId, status, client) {
  const { rows } = await query(
    `UPDATE shipments SET status = $3 WHERE seller_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [sellerId, shipmentId, status],
    client,
  );
  return rows[0] ?? null;
}
