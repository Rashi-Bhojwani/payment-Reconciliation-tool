// Single-use OAuth state tokens for the generic marketplace connection flow
// (§8 of APP_ARCHITECTURE.md). The token itself is signed by whichever
// adapter's auth module built it; this table makes it single-use and expiring.
import { query } from '../pool.js';

export async function create(sellerId, { marketplaceId, marketplaceAccountId, stateToken, expiresAt }, client) {
  const { rows } = await query(
    `INSERT INTO marketplace_connection_requests
        (seller_id, marketplace_id, marketplace_account_id, state_token, expires_at)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, seller_id, marketplace_id, marketplace_account_id, state_token, expires_at, consumed_at, created_at`,
    [sellerId, marketplaceId, marketplaceAccountId ?? null, stateToken, expiresAt],
    client,
  );
  return rows[0];
}

/**
 * Atomically consume a state token.
 *
 * UPDATE ... WHERE consumed_at IS NULL AND expires_at > NOW() is the whole
 * defence: a replayed callback finds zero rows, even if two requests arrive
 * at the same instant.
 */
export async function consume(stateToken, client) {
  const { rows } = await query(
    `UPDATE marketplace_connection_requests
        SET consumed_at = NOW()
      WHERE state_token = $1 AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING id, seller_id, marketplace_id, marketplace_account_id, state_token, expires_at, consumed_at, created_at`,
    [stateToken],
    client,
  );
  return rows[0] ?? null;
}

export async function findLatestForAccount(sellerId, marketplaceId, client) {
  const { rows } = await query(
    `SELECT id, seller_id, marketplace_id, marketplace_account_id, state_token, expires_at, consumed_at, created_at
       FROM marketplace_connection_requests
      WHERE seller_id = $1 AND marketplace_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [sellerId, marketplaceId],
    client,
  );
  return rows[0] ?? null;
}

export async function deleteExpired(client) {
  const { rowCount } = await query(
    `DELETE FROM marketplace_connection_requests WHERE expires_at < NOW() - INTERVAL '7 days'`,
    [],
    client,
  );
  return rowCount;
}
