// AES-256-GCM encrypt/decrypt for marketplace credentials and order PII.
// Key comes from env (ENCRYPTION_KEY, base64, 32 bytes — validated by
// config.js at boot). Ciphertext, IV and auth tag are always returned/stored
// separately (never concatenated into one blob) so a caller can never
// "forget" to check the auth tag.
//
// PRODUCTION UPGRADE PATH: replace this env-var key with AWS KMS envelope
// encryption (generate a data key per record, encrypt the data key with a
// KMS CMK). The `key_version` column on every encrypted table exists so a
// future key rotation — including a cutover to KMS — doesn't require
// rewriting already-encrypted rows in one migration; decrypt reads the
// version, encrypt always writes the current one.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { CryptoError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV, the GCM-recommended size

function currentKey() {
  if (!config.crypto.key) {
    throw new CryptoError('ENCRYPTION_KEY is not configured');
  }
  return Buffer.from(config.crypto.key, 'base64');
}

/**
 * Encrypts a JSON-serialisable value.
 * @returns {{ ciphertext: Buffer, iv: Buffer, authTag: Buffer, keyVersion: number }}
 */
export function encryptJson(value) {
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, currentKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: config.crypto.keyVersion };
}

/**
 * Decrypts back to the original value. Throws CryptoError (never leaks the
 * plaintext or the key in the error) on a bad tag, wrong key version, or any
 * other failure.
 */
export function decryptJson({ ciphertext, iv, authTag, keyVersion }) {
  if (keyVersion !== config.crypto.keyVersion) {
    // A real rotation would look up the right historical key by version
    // instead of failing outright — not needed until there is more than one
    // key in play. Documented here so the failure mode is legible, not silent.
    throw new CryptoError(`No key configured for key_version ${keyVersion}`);
  }
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, currentKey(), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (error) {
    throw new CryptoError('Failed to decrypt value', { cause: error });
  }
}

/** Convenience for the common case of encrypting a single plain string. */
export function encryptString(value) {
  return encryptJson(value);
}

export function decryptString(fields) {
  return decryptJson(fields);
}
