// Staff accounts. NOT seller-scoped (see repositories/README.md) — users are
// global to the company, so these functions take no sellerId.
import bcrypt from 'bcrypt';
import { query } from '../pool.js';
import { ConflictError } from '../../lib/errors.js';

const BCRYPT_ROUNDS = 12;

// password_hash is never selected into the app except by verifyPassword.
const PUBLIC_COLUMNS = 'id, email, name, role, created_at';

export async function findById(id, client) {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id], client);
  return rows[0] ?? null;
}

export async function findByEmail(email, client) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
    [email],
    client,
  );
  return rows[0] ?? null;
}

export async function listAll(client) {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY email`, [], client);
  return rows;
}

/**
 * Returns the user on a correct password, else null.
 * Runs a dummy hash comparison for unknown emails so response timing does not
 * reveal which addresses have accounts.
 */
export async function verifyPassword(email, plaintext) {
  const { rows } = await query(
    `SELECT id, email, name, role, created_at, password_hash
       FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  const user = rows[0];
  if (!user) {
    await bcrypt.compare(plaintext, '$2b$12$' + 'x'.repeat(53));
    return null;
  }
  const ok = await bcrypt.compare(plaintext, user.password_hash);
  if (!ok) return null;
  delete user.password_hash;
  return user;
}

export async function create({ email, name, role = 'operator', password }, client) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const { rows } = await query(
      `INSERT INTO users (email, name, role, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PUBLIC_COLUMNS}`,
      [email.toLowerCase(), name ?? null, role, passwordHash],
      client,
    );
    return rows[0];
  } catch (error) {
    if (error.code === '23505') throw new ConflictError('That email address is already registered');
    throw error;
  }
}

/** Idempotent create — used by the seeder so `npm run seed` can be re-run. */
export async function upsertByEmail({ email, name, role, password }, client) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const { rows } = await query(
    `INSERT INTO users (email, name, role, password_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash
     RETURNING ${PUBLIC_COLUMNS}`,
    [email.toLowerCase(), name ?? null, role, passwordHash],
    client,
  );
  return rows[0];
}

export async function setPassword(userId, plaintext, client) {
  const passwordHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash], client);
}
