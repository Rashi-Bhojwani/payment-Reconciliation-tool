// The marketplace lookup table. NOT seller-scoped — a marketplace (AMAZON,
// FLIPKART, ...) is global reference data, not owned by any seller.
//
// Capabilities (supportsBulkScheduling etc.) are deliberately NOT columns
// here — they live on each adapter's static `capabilities` object in
// src/integrations/. See db/migrations/003_marketplace_accounts.sql for why:
// one source of truth, so DB and adapter code cannot drift apart on what a
// marketplace can actually do.
import { query } from '../pool.js';

const COLUMNS = 'id, code, name, is_active, created_at';

export async function listAll(client) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM marketplaces ORDER BY name`, [], client);
  return rows;
}

export async function listActive(client) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM marketplaces WHERE is_active ORDER BY name`,
    [],
    client,
  );
  return rows;
}

export async function findByCode(code, client) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM marketplaces WHERE code = $1`, [code], client);
  return rows[0] ?? null;
}

export async function findById(id, client) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM marketplaces WHERE id = $1`, [id], client);
  return rows[0] ?? null;
}
