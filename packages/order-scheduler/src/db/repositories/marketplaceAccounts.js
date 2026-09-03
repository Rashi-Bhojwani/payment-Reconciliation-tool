// Marketplace accounts: one row per seller+marketplace connection. This is
// the isolation key everything below a seller now hangs off — sellerId is
// still the first argument (rule R1 is unchanged), but orders/packages/
// shipments additionally scope to marketplace_account_id.
import { query } from '../pool.js';

const COLUMNS = `id, seller_id, marketplace_id, external_account_id, region, display_name,
  status, metadata, connected_at, created_at, updated_at`;

export async function findById(sellerId, marketplaceAccountId, client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM marketplace_accounts WHERE seller_id = $1 AND id = $2`,
    [sellerId, marketplaceAccountId],
    client,
  );
  return rows[0] ?? null;
}

/** All connections for one seller, newest marketplace name first. */
export async function listBySeller(sellerId, client) {
  const { rows } = await query(
    `SELECT ma.*, m.code AS marketplace_code, m.name AS marketplace_name
       FROM marketplace_accounts ma
       JOIN marketplaces m ON m.id = ma.marketplace_id
      WHERE ma.seller_id = $1
      ORDER BY m.name`,
    [sellerId],
    client,
  );
  return rows;
}

/**
 * Every account on one marketplace, across the sellers in `sellerIds` — the
 * platform-first "select Amazon, see the sellers connected to it" view.
 * `sellerIds` is computed by the caller from verified access, never a query
 * parameter (same rule as ordersRepo.listForMarketplace).
 */
export async function listByMarketplaceForSellers(marketplaceId, sellerIds, client) {
  if (!sellerIds?.length) return [];
  const { rows } = await query(
    `SELECT ma.*, s.seller_name
       FROM marketplace_accounts ma
       JOIN sellers s ON s.id = ma.seller_id
      WHERE ma.marketplace_id = $1 AND ma.seller_id = ANY($2::uuid[])
      ORDER BY (ma.status = 'AUTHORIZED') DESC, s.seller_name`,
    [marketplaceId, sellerIds],
    client,
  );
  return rows;
}

export async function findBySellerAndMarketplace(sellerId, marketplaceId, client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM marketplace_accounts
      WHERE seller_id = $1 AND marketplace_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [sellerId, marketplaceId],
    client,
  );
  return rows[0] ?? null;
}

/** Used only by the OAuth callback, keyed by the external account Amazon (etc.) reports. */
export async function findByExternalAccount(marketplaceId, externalAccountId, client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM marketplace_accounts
      WHERE marketplace_id = $1 AND external_account_id = $2`,
    [marketplaceId, externalAccountId],
    client,
  );
  return rows[0] ?? null;
}

export async function create(sellerId, { marketplaceId, region, displayName, metadata }, client) {
  const { rows } = await query(
    `INSERT INTO marketplace_accounts (seller_id, marketplace_id, region, display_name, status, metadata)
     VALUES ($1,$2,$3,$4,'PENDING',COALESCE($5,'{}'::jsonb))
     RETURNING ${COLUMNS}`,
    [sellerId, marketplaceId, region, displayName ?? null, metadata ? JSON.stringify(metadata) : null],
    client,
  );
  return rows[0];
}

export async function markAuthorized(sellerId, marketplaceAccountId, { externalAccountId, metadata }, client) {
  const { rows } = await query(
    `UPDATE marketplace_accounts
        SET status = 'AUTHORIZED',
            external_account_id = COALESCE($3, external_account_id),
            metadata = metadata || COALESCE($4, '{}'::jsonb),
            connected_at = NOW(),
            updated_at = NOW()
      WHERE seller_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [sellerId, marketplaceAccountId, externalAccountId ?? null, metadata ? JSON.stringify(metadata) : null],
    client,
  );
  return rows[0] ?? null;
}

/** A 401 from the marketplace means it pulled our access. */
export async function markRevoked(marketplaceAccountId, client) {
  const { rows } = await query(
    `UPDATE marketplace_accounts SET status = 'REVOKED', updated_at = NOW()
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [marketplaceAccountId],
    client,
  );
  return rows[0] ?? null;
}

export async function setStatus(sellerId, marketplaceAccountId, status, client) {
  const { rows } = await query(
    `UPDATE marketplace_accounts SET status = $3, updated_at = NOW()
      WHERE seller_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [sellerId, marketplaceAccountId, status],
    client,
  );
  return rows[0] ?? null;
}

/** Every AUTHORIZED account, for the order-sync scheduler — no seller in scope by nature. */
export async function listAllAuthorized(client) {
  const { rows } = await query(
    `SELECT ma.*, m.code AS marketplace_code
       FROM marketplace_accounts ma
       JOIN marketplaces m ON m.id = ma.marketplace_id
      WHERE ma.status = 'AUTHORIZED'`,
    [],
    client,
  );
  return rows;
}
