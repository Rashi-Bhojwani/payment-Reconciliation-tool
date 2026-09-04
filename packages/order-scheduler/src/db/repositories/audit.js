// Append-only audit trail. NOT seller-scoped in the positional sense: it takes
// an explicit options object because it also records actions that span sellers
// or have none (login, admin pages).
//
// `accessed_pii` is the column that matters for Amazon's data-protection
// review: every decryption of buyer data leaves a row here.
import { query } from '../pool.js';
import { childLogger } from '../../lib/logger.js';

const log = childLogger('audit');

export async function record(
  { userId = null, sellerId = null, action, entityType = null, entityId = null,
    changes = null, accessedPii = false, ipAddress = null },
  client,
) {
  try {
    const { rows } = await query(
      `INSERT INTO audit_logs (user_id, seller_id, action, entity_type, entity_id,
                               changes, accessed_pii, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, created_at`,
      [userId, sellerId, action, entityType, entityId,
       changes ? JSON.stringify(changes) : null, accessedPii, ipAddress],
      client,
    );
    return rows[0];
  } catch (error) {
    // An audit failure must never break the operation being audited, but it is
    // never silent either.
    log.error({ err: error, action, entityType, entityId }, 'failed to write audit log');
    return null;
  }
}

export async function list({ sellerId = null, userId = null, accessedPii = null, limit = 100, offset = 0 } = {}, client) {
  const params = [];
  const where = [];
  if (sellerId) {
    params.push(sellerId);
    where.push(`a.seller_id = $${params.length}`);
  }
  if (userId) {
    params.push(userId);
    where.push(`a.user_id = $${params.length}`);
  }
  if (accessedPii !== null) {
    params.push(accessedPii);
    where.push(`a.accessed_pii = $${params.length}`);
  }
  params.push(Math.min(limit, 500), offset);

  const { rows } = await query(
    `SELECT a.id, a.user_id, a.seller_id, a.action, a.entity_type, a.entity_id,
            a.changes, a.accessed_pii, a.ip_address, a.created_at,
            u.email AS user_email, t.company_name AS seller_name
       FROM audit_logs a
       LEFT JOIN public.users u   ON u.id = a.user_id
       LEFT JOIN public.tenants t ON t.id = a.seller_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client,
  );
  return rows;
}
