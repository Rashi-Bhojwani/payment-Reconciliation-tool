import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptJson, decryptJson } from '../src/lib/crypto.js';
import { CryptoError } from '../src/lib/errors.js';

test('encryptJson/decryptJson round-trips a value', () => {
  const value = { refreshToken: 'Atzr|super-secret-value', nested: { a: [1, 2, 3] } };
  const encrypted = encryptJson(value);
  assert.ok(Buffer.isBuffer(encrypted.ciphertext));
  assert.ok(Buffer.isBuffer(encrypted.iv));
  assert.ok(Buffer.isBuffer(encrypted.authTag));
  assert.equal(encrypted.iv.length, 12);

  const decrypted = decryptJson(encrypted);
  assert.deepEqual(decrypted, value);
});

test('ciphertext never contains the plaintext', () => {
  const secret = 'plainly-recognisable-refresh-token-xyz';
  const { ciphertext } = encryptJson({ refreshToken: secret });
  assert.ok(!ciphertext.toString('utf8').includes(secret));
  assert.ok(!ciphertext.toString('base64').includes(Buffer.from(secret).toString('base64')));
});

test('two encryptions of the same value produce different ciphertext (random IV)', () => {
  const a = encryptJson({ x: 1 });
  const b = encryptJson({ x: 1 });
  assert.notDeepEqual(a.iv, b.iv);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
});

test('a flipped auth tag byte is rejected, not silently decrypted', () => {
  const encrypted = encryptJson({ secret: true });
  const tampered = Buffer.from(encrypted.authTag);
  tampered[0] ^= 0xff;
  assert.throws(
    () => decryptJson({ ...encrypted, authTag: tampered }),
    CryptoError,
  );
});

test('a wrong key_version is rejected before attempting to decrypt', () => {
  const encrypted = encryptJson({ secret: true });
  assert.throws(() => decryptJson({ ...encrypted, keyVersion: 999 }), CryptoError);
});
