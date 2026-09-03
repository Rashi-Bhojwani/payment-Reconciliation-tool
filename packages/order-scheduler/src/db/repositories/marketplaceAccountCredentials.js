// Marketplace credentials, kept in their own table so business queries never
// join against ciphertext. Nothing here decrypts — that is each adapter's
// auth module's job (e.g. src/integrations/amazon/auth/).
import { query } from '../pool.js';

// ciphertext / iv / auth_tag excluded from the default projection so a
// careless `SELECT *` cannot spill them into a log or a view.
const SAFE_COLUMNS = `id, marketplace_account_id, key_version, granted_roles,
  last_refreshed_at, last_error, created_at`;

export async function findByAccount(marketplaceAccountId, client) {
  const { rows } = await query(
    `SELECT ${SAFE_COLUMNS} FROM marketplace_account_credentials WHERE marketplace_account_id = $1`,
    [marketplaceAccountId],
    client,
  );
  return rows[0] ?? null;
}

/**
 * The only function that returns ciphertext. Named so any call site is
 * obvious in review — used exclusively inside adapter auth modules.
 */
export async function findSecretsByAccount(marketplaceAccountId, client) {
  const { rows } = await query(
    `SELECT id, marketplace_account_id, ciphertext, iv, auth_tag, key_version
       FROM marketplace_account_credentials WHERE marketplace_account_id = $1`,
    [marketplaceAccountId],
    client,
  );
  return rows[0] ?? null;
}

/** Re-authorisation replaces, never duplicates: marketplace_account_id is UNIQUE. */
export async function upsert(marketplaceAccountId, credentials, client) {
  const { rows } = await query(
    `INSERT INTO marketplace_account_credentials (
        marketplace_account_id, ciphertext, iv, auth_tag, key_version, granted_roles,
        last_refreshed_at, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),NULL)
     ON CONFLICT (marketplace_account_id) DO UPDATE SET
        ciphertext    = EXCLUDED.ciphertext,
        iv            = EXCLUDED.iv,
        auth_tag      = EXCLUDED.auth_tag,
        key_version   = EXCLUDED.key_version,
        granted_roles = COALESCE(EXCLUDED.granted_roles, marketplace_account_credentials.granted_roles),
        last_refreshed_at = NOW(),
        last_error    = NULL
     RETURNING ${SAFE_COLUMNS}`,
    [marketplaceAccountId, credentials.ciphertext, credentials.iv, credentials.authTag,
     credentials.keyVersion, credentials.grantedRoles ?? null],
    client,
  );
  return rows[0];
}

export async function markRefreshed(marketplaceAccountId, client) {
  await query(
    `UPDATE marketplace_account_credentials SET last_refreshed_at = NOW(), last_error = NULL
      WHERE marketplace_account_id = $1`,
    [marketplaceAccountId],
    client,
  );
}

export async function markError(marketplaceAccountId, message, client) {
  await query(
    `UPDATE marketplace_account_credentials SET last_error = $2
      WHERE marketplace_account_id = $1`,
    [marketplaceAccountId, String(message).slice(0, 2000)],
    client,
  );
}
