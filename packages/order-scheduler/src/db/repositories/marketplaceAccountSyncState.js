// Per-account sync bookkeeping: backfill cursor and the persisted half of the
// circuit breaker. Rekeyed from seller_id to marketplace_account_id — a
// seller with two marketplace accounts syncs each independently.
import { query } from '../pool.js';

const COLUMNS = `marketplace_account_id, last_synced_at, last_successful_cursor,
  notification_subscription_id, sqs_destination_id, consecutive_failures, circuit_open_until`;

export async function get(marketplaceAccountId, client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM marketplace_account_sync_state WHERE marketplace_account_id = $1`,
    [marketplaceAccountId],
    client,
  );
  return rows[0] ?? null;
}

export async function ensure(marketplaceAccountId, client) {
  const { rows } = await query(
    `INSERT INTO marketplace_account_sync_state (marketplace_account_id) VALUES ($1)
     ON CONFLICT (marketplace_account_id) DO UPDATE SET marketplace_account_id = EXCLUDED.marketplace_account_id
     RETURNING ${COLUMNS}`,
    [marketplaceAccountId],
    client,
  );
  return rows[0];
}

export async function recordSuccess(marketplaceAccountId, cursor, client) {
  const { rows } = await query(
    `INSERT INTO marketplace_account_sync_state
        (marketplace_account_id, last_synced_at, last_successful_cursor, consecutive_failures, circuit_open_until)
     VALUES ($1, NOW(), $2, 0, NULL)
     ON CONFLICT (marketplace_account_id) DO UPDATE SET
        last_synced_at = NOW(),
        last_successful_cursor = COALESCE(EXCLUDED.last_successful_cursor,
                                          marketplace_account_sync_state.last_successful_cursor),
        consecutive_failures = 0,
        circuit_open_until = NULL
     RETURNING ${COLUMNS}`,
    [marketplaceAccountId, cursor ?? null],
    client,
  );
  return rows[0];
}

export async function recordFailure(marketplaceAccountId, { openUntil = null } = {}, client) {
  const { rows } = await query(
    `INSERT INTO marketplace_account_sync_state (marketplace_account_id, consecutive_failures, circuit_open_until)
     VALUES ($1, 1, $2)
     ON CONFLICT (marketplace_account_id) DO UPDATE SET
        consecutive_failures = marketplace_account_sync_state.consecutive_failures + 1,
        circuit_open_until = COALESCE($2, marketplace_account_sync_state.circuit_open_until)
     RETURNING ${COLUMNS}`,
    [marketplaceAccountId, openUntil],
    client,
  );
  return rows[0];
}

export async function setSubscription(marketplaceAccountId, { subscriptionId, destinationId }, client) {
  const { rows } = await query(
    `INSERT INTO marketplace_account_sync_state
        (marketplace_account_id, notification_subscription_id, sqs_destination_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (marketplace_account_id) DO UPDATE SET
        notification_subscription_id = COALESCE(EXCLUDED.notification_subscription_id,
                                                marketplace_account_sync_state.notification_subscription_id),
        sqs_destination_id = COALESCE(EXCLUDED.sqs_destination_id,
                                      marketplace_account_sync_state.sqs_destination_id)
     RETURNING ${COLUMNS}`,
    [marketplaceAccountId, subscriptionId ?? null, destinationId ?? null],
    client,
  );
  return rows[0];
}

/** Admin view: which accounts are falling behind, and why. */
export async function listAtRisk({ lagMinutes = 120 } = {}, client) {
  const { rows } = await query(
    `SELECT ma.id AS marketplace_account_id, ma.seller_id, t.company_name AS seller_name,
            m.code AS marketplace_code, ma.status AS connection_status,
            st.last_synced_at, st.consecutive_failures, st.circuit_open_until
       FROM marketplace_accounts ma
       JOIN public.tenants t ON t.id = ma.seller_id
       JOIN marketplaces m ON m.id = ma.marketplace_id
       LEFT JOIN marketplace_account_sync_state st ON st.marketplace_account_id = ma.id
      WHERE ma.status <> 'PENDING'
        AND (ma.status <> 'AUTHORIZED'
             OR st.consecutive_failures > 0
             OR st.circuit_open_until > NOW()
             OR st.last_synced_at IS NULL
             OR st.last_synced_at < NOW() - ($1 || ' minutes')::interval)
      ORDER BY st.consecutive_failures DESC NULLS LAST, st.last_synced_at ASC NULLS FIRST`,
    [String(lagMinutes)],
    client,
  );
  return rows;
}
