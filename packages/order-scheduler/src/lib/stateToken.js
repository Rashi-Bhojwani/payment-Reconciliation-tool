// Signed, single-use OAuth state tokens — generic, so every marketplace
// adapter's authorize() uses the same construction rather than each
// reinventing it. Single-use and expiry are enforced by the DB round-trip
// in marketplaceConnectionRequests.consume(); the signature here lets a
// clearly-tampered token be rejected before that DB hit.
import crypto from 'node:crypto';
import { config } from '../config.js';

function hmac(value) {
  return crypto.createHmac('sha256', config.session.secret).update(value).digest('base64url');
}

/** A fresh, unguessable, signed token. */
export function generateStateToken() {
  const random = crypto.randomBytes(32).toString('base64url');
  return `${random}.${hmac(random)}`;
}

/** True if the token's signature matches — does NOT check single-use/expiry. */
export function verifyStateTokenSignature(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [random, signature] = token.split('.');
  if (!random || !signature) return false;
  const expected = hmac(random);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
