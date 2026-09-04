// Manually entered package info (no AI — rule from APP_ARCHITECTURE.md §14).
// "Ready to schedule" is not a stored flag; it's computed from whether every
// required field is present — see isComplete() below, used by both the UI
// and SchedulingService so they can never disagree.
import { query } from '../pool.js';

const COLUMNS = `id, order_id, seller_id, package_number, weight_grams, length_cm, width_cm,
  height_cm, package_type, entered_by_user_id, updated_at`;

export async function findById(sellerId, packageId, client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM packages WHERE seller_id = $1 AND id = $2`,
    [sellerId, packageId],
    client,
  );
  return rows[0] ?? null;
}

export async function listByOrder(sellerId, orderId, client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM packages
      WHERE seller_id = $1 AND order_id = $2 ORDER BY package_number`,
    [sellerId, orderId],
    client,
  );
  return rows;
}

/** The single package for each of a set of orders — for the order list's weight/dims columns. */
export async function findPrimaryByOrderIds(sellerId, orderIds, client) {
  if (!orderIds.length) return new Map();
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM packages
      WHERE seller_id = $1 AND order_id = ANY($2::uuid[]) AND package_number = 1`,
    [sellerId, orderIds],
    client,
  );
  return new Map(rows.map((r) => [r.order_id, r]));
}

/**
 * Same as findPrimaryByOrderIds, but for the cross-seller platform order
 * list (routes/marketplaces.js) where orderIds may already span several
 * sellers. Safe because the caller (ordersRepo.listForMarketplace) has
 * already scoped those order ids to the current user's accessible sellers —
 * this only fills in package data for ids the caller already vetted, never
 * an independent lookup a route could feed arbitrary ids into.
 */
export async function findPrimaryByOrderIdsAnySeller(orderIds, client) {
  if (!orderIds.length) return new Map();
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM packages WHERE order_id = ANY($1::uuid[]) AND package_number = 1`,
    [orderIds],
    client,
  );
  return new Map(rows.map((r) => [r.order_id, r]));
}

/**
 * The default flow is one package per order. Returns the existing
 * package_number = 1 row, creating an empty one (all fields NULL) if this
 * order has never had package info entered.
 */
export async function getOrCreatePrimary(sellerId, orderId, client) {
  const { rows } = await query(
    `INSERT INTO packages (order_id, seller_id, package_number)
     VALUES ($1, $2, 1)
     ON CONFLICT (order_id, package_number) DO UPDATE SET package_number = EXCLUDED.package_number
     RETURNING ${COLUMNS}`,
    [orderId, sellerId],
    client,
  );
  return rows[0];
}

/** A second, third, ... package for an order that needs to ship as multiple boxes. */
export async function addPackage(sellerId, orderId, client) {
  const { rows } = await query(
    `INSERT INTO packages (order_id, seller_id, package_number)
     SELECT $1, $2, COALESCE(MAX(package_number), 0) + 1 FROM packages WHERE order_id = $1
     RETURNING ${COLUMNS}`,
    [orderId, sellerId],
    client,
  );
  return rows[0];
}

/** Save the manually entered fields. Whoever saves last is entered_by_user_id. */
export async function save(sellerId, packageId, fields, userId, client) {
  const { rows } = await query(
    `UPDATE packages
        SET weight_grams = $3, length_cm = $4, width_cm = $5, height_cm = $6,
            package_type = $7, entered_by_user_id = $8, updated_at = NOW()
      WHERE seller_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [sellerId, packageId, fields.weightGrams ?? null, fields.lengthCm ?? null,
     fields.widthCm ?? null, fields.heightCm ?? null, fields.packageType ?? null, userId ?? null],
    client,
  );
  return rows[0] ?? null;
}

export async function remove(sellerId, packageId, client) {
  const { rowCount } = await query(
    'DELETE FROM packages WHERE seller_id = $1 AND id = $2 AND package_number > 1',
    [sellerId, packageId],
    client,
  );
  return rowCount > 0;
}

export async function listItems(sellerId, packageId, client) {
  const { rows } = await query(
    `SELECT pi.package_id, pi.order_item_id, pi.quantity,
            i.external_product_id, i.sku, i.title, i.quantity_ordered
       FROM package_items pi
       JOIN packages p    ON p.id = pi.package_id
       JOIN order_items i ON i.id = pi.order_item_id
      WHERE p.seller_id = $1 AND pi.package_id = $2
      ORDER BY i.external_item_id`,
    [sellerId, packageId],
    client,
  );
  return rows;
}

export async function assignItem(sellerId, packageId, orderItemId, quantity, client) {
  await query(
    `INSERT INTO package_items (package_id, order_item_id, quantity)
     SELECT $2, $3, $4 WHERE EXISTS (SELECT 1 FROM packages WHERE id = $2 AND seller_id = $1)
     ON CONFLICT (package_id, order_item_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
    [sellerId, packageId, orderItemId, quantity],
    client,
  );
}

/**
 * True once every field required to schedule is present. Used by both the
 * "Schedule" button's enabled state and SchedulingService's pre-flight check
 * (§15 of APP_ARCHITECTURE.md) — one function, so the UI and the guard that
 * actually blocks the API call can never drift apart.
 */
export function isComplete(pkg) {
  if (!pkg) return false;
  return [pkg.weight_grams, pkg.length_cm, pkg.width_cm, pkg.height_cm, pkg.package_type].every(
    (v) => v !== null && v !== undefined && v !== '',
  );
}

/** The specific field(s) blocking scheduling, for a readable message (§15). */
export function missingFields(pkg) {
  const labels = {
    weight_grams: 'Weight',
    length_cm: 'Length',
    width_cm: 'Width',
    height_cm: 'Height',
    package_type: 'Package type',
  };
  if (!pkg) return Object.values(labels);
  return Object.entries(labels)
    .filter(([key]) => pkg[key] === null || pkg[key] === undefined || pkg[key] === '')
    .map(([, label]) => label);
}
