// Sellers: business-level identity only. The `id` of a row here IS the
// isolation key used by every other repository (rule R1). Everything
// marketplace-specific (connection status, region, fulfilment mode) lives on
// marketplace_accounts — see marketplaceAccounts.js.
import { query } from '../pool.js';

const COLUMNS = 'id, seller_name, contact_name, email, phone, timezone, created_at, updated_at';
const S_COLUMNS = COLUMNS.split(',').map((c) => `s.${c.trim()}`).join(', ');

export async function findById(sellerId, client) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM sellers WHERE id = $1`, [sellerId], client);
  return rows[0] ?? null;
}

/**
 * Sellers this user may act for, with a rollup of their marketplace accounts.
 * Admins see everything; everyone else sees only rows explicitly granted in
 * user_seller_access. This is the read side of the same rule
 * requireSellerAccess enforces on individual routes.
 */
export async function listVisibleTo(user, { search = '' } = {}, client) {
  const params = [];
  const where = [];

  if (user.role !== 'admin') {
    params.push(user.id);
    where.push(`s.id IN (SELECT seller_id FROM user_seller_access WHERE user_id = $${params.length})`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(s.seller_name ILIKE $${params.length} OR s.email ILIKE $${params.length})`);
  }

  const { rows } = await query(
    `SELECT ${S_COLUMNS},
            COALESCE(ma.account_count, 0)::int    AS marketplace_account_count,
            COALESCE(ma.authorized_count, 0)::int AS authorized_account_count,
            COALESCE(o.order_count, 0)::int        AS order_count,
            COALESCE(o.review_count, 0)::int       AS review_count
       FROM sellers s
       LEFT JOIN (
         SELECT seller_id,
                COUNT(*) AS account_count,
                COUNT(*) FILTER (WHERE status = 'AUTHORIZED') AS authorized_count
           FROM marketplace_accounts GROUP BY seller_id
       ) ma ON ma.seller_id = s.id
       LEFT JOIN (
         SELECT seller_id,
                COUNT(*) AS order_count,
                COUNT(*) FILTER (WHERE internal_status = 'READY_FOR_REVIEW') AS review_count
           FROM orders GROUP BY seller_id
       ) o ON o.seller_id = s.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.seller_name`,
    params,
    client,
  );
  return rows;
}

/** True when this user may act for this seller. Admins always may. */
export async function userHasAccess(userId, sellerId, userRole, client) {
  if (userRole === 'admin') {
    const { rows } = await query('SELECT 1 FROM sellers WHERE id = $1', [sellerId], client);
    return rows.length > 0;
  }
  const { rows } = await query(
    `SELECT 1 FROM user_seller_access a
       JOIN sellers s ON s.id = a.seller_id
      WHERE a.user_id = $1 AND a.seller_id = $2`,
    [userId, sellerId],
    client,
  );
  return rows.length > 0;
}

export async function grantAccess(userId, sellerId, grantedByUserId, client) {
  await query(
    `INSERT INTO user_seller_access (user_id, seller_id, granted_by_user_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [userId, sellerId, grantedByUserId ?? null],
    client,
  );
}

export async function revokeAccess(userId, sellerId, client) {
  await query('DELETE FROM user_seller_access WHERE user_id = $1 AND seller_id = $2', [userId, sellerId], client);
}

export async function create(seller, client) {
  const { rows } = await query(
    `INSERT INTO sellers (seller_name, contact_name, email, phone, timezone)
     VALUES ($1,$2,$3,$4,COALESCE($5,'Asia/Kolkata'))
     RETURNING ${COLUMNS}`,
    [seller.sellerName, seller.contactName ?? null, seller.email ?? null, seller.phone ?? null, seller.timezone ?? null],
    client,
  );
  return rows[0];
}

export async function update(sellerId, patch, client) {
  const { rows } = await query(
    `UPDATE sellers SET
        seller_name  = COALESCE($2, seller_name),
        contact_name = COALESCE($3, contact_name),
        email        = COALESCE($4, email),
        phone        = COALESCE($5, phone),
        timezone     = COALESCE($6, timezone),
        updated_at   = NOW()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [sellerId, patch.sellerName ?? null, patch.contactName ?? null, patch.email ?? null,
     patch.phone ?? null, patch.timezone ?? null],
    client,
  );
  return rows[0] ?? null;
}

/**
 * Permanently removes a seller and everything scoped to them — every FK
 * from marketplace_accounts, orders (and, transitively, order_items,
 * packages, shipments), user_seller_access etc. down to sellers(id) is
 * ON DELETE CASCADE (see db/migrations), so this one statement is enough;
 * there is no soft-delete flag to set instead. audit_logs.seller_id
 * deliberately carries no FK — the audit trail survives a deleted seller.
 * Irreversible: the caller must have already confirmed with the operator.
 */
export async function remove(sellerId, client) {
  await query('DELETE FROM sellers WHERE id = $1', [sellerId], client);
}

/** Seller ids this user may act for — the input to every cross-seller query. */
export async function listAccessibleIds(user, client) {
  if (user.role === 'admin') {
    const { rows } = await query('SELECT id FROM sellers ORDER BY seller_name', [], client);
    return rows.map((r) => r.id);
  }
  const { rows } = await query(
    `SELECT seller_id AS id FROM user_seller_access WHERE user_id = $1`,
    [user.id],
    client,
  );
  return rows.map((r) => r.id);
}
