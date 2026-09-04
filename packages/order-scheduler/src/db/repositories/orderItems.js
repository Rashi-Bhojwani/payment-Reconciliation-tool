// Line items. Product data, not buyer PII.
import { query } from '../pool.js';

const COLUMNS = `id, order_id, seller_id, external_item_id, sku, external_product_id, title,
  quantity_ordered, quantity_shipped, unit_price, currency`;

export async function listByOrder(sellerId, orderId, client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM order_items
      WHERE seller_id = $1 AND order_id = $2
      ORDER BY external_item_id`,
    [sellerId, orderId],
    client,
  );
  return rows;
}

export async function listByOrderIds(sellerId, orderIds, client) {
  if (!orderIds.length) return [];
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM order_items
      WHERE seller_id = $1 AND order_id = ANY($2::uuid[])
      ORDER BY order_id, external_item_id`,
    [sellerId, orderIds],
    client,
  );
  return rows;
}

/** Upsert on (order_id, external_item_id) — same idempotency rule as orders. */
export async function upsertMany(sellerId, orderId, items, client) {
  const saved = [];
  for (const item of items) {
    const { rows } = await query(
      `INSERT INTO order_items (order_id, seller_id, external_item_id, sku, external_product_id,
                                title, quantity_ordered, quantity_shipped, unit_price, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (order_id, external_item_id) DO UPDATE SET
          sku                 = EXCLUDED.sku,
          external_product_id = EXCLUDED.external_product_id,
          title               = EXCLUDED.title,
          quantity_ordered    = EXCLUDED.quantity_ordered,
          quantity_shipped    = EXCLUDED.quantity_shipped,
          unit_price          = EXCLUDED.unit_price,
          currency            = EXCLUDED.currency
       RETURNING ${COLUMNS}`,
      [
        orderId,
        sellerId,
        item.externalItemId,
        item.sku ?? null,
        item.externalProductId,
        item.title ?? null,
        item.quantityOrdered,
        item.quantityShipped ?? 0,
        item.unitPrice ?? null,
        item.currency ?? null,
      ],
      client,
    );
    saved.push(rows[0]);
  }
  return saved;
}

/** Distinct products this seller has ever sold — used by the products page. */
export async function listDistinctProducts(sellerId, { limit = 500 } = {}, client) {
  const { rows } = await query(
    `SELECT external_product_id,
            MAX(title) AS title,
            MAX(sku) AS sku,
            COUNT(*)::int AS order_count
       FROM order_items
      WHERE seller_id = $1
      GROUP BY external_product_id
      ORDER BY order_count DESC, external_product_id
      LIMIT $2`,
    [sellerId, limit],
    client,
  );
  return rows;
}
