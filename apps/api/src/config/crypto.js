import crypto from 'node:crypto';
import { secrets } from './secrets.js';

const key = crypto.createHash('sha256').update(secrets.tokenEncryptionKey).digest();

/** @param {string} value */
export function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

/** @param {string} value */
export function decryptSecret(value) {
  const [ivB64, tagB64, encryptedB64] = value.split('.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (error) {
    // Node's raw AES-GCM error ("Unsupported state or unable to authenticate
    // data") only ever means the key used to decrypt differs from the key
    // used to encrypt. In practice that means SESSION_SECRET was unset (so a
    // fresh random key was minted on every process start — see secrets.js)
    // or was changed after this value was stored. Surface the fix, not the
    // OpenSSL internals, since this is the #1 cause of every-sync-fails.
    throw new Error(
      `Stored credential could not be decrypted — SESSION_SECRET is different from when it was saved `
      + `(commonly because SESSION_SECRET is unset/"HEHE" and a new random key was generated on this restart). `
      + `Set a stable SESSION_SECRET in .env and reconnect the Amazon account. Original error: ${error instanceof Error ? error.message : error}`
    );
  }
}