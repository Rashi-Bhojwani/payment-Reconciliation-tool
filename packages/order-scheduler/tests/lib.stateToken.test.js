import test from 'node:test';
import assert from 'node:assert/strict';
import { generateStateToken, verifyStateTokenSignature } from '../src/lib/stateToken.js';

test('a freshly generated token verifies', () => {
  const token = generateStateToken();
  assert.equal(verifyStateTokenSignature(token), true);
});

test('tokens are unique', () => {
  const a = generateStateToken();
  const b = generateStateToken();
  assert.notEqual(a, b);
});

test('a tampered payload fails verification', () => {
  const token = generateStateToken();
  const [random, signature] = token.split('.');
  const tampered = `${random}x.${signature}`;
  assert.equal(verifyStateTokenSignature(tampered), false);
});

test('a tampered signature fails verification', () => {
  const token = generateStateToken();
  const [random, signature] = token.split('.');
  const flipped = signature.slice(0, -1) + (signature.at(-1) === 'A' ? 'B' : 'A');
  assert.equal(verifyStateTokenSignature(`${random}.${flipped}`), false);
});

test('garbage input is rejected without throwing', () => {
  assert.equal(verifyStateTokenSignature('not-a-real-token'), false);
  assert.equal(verifyStateTokenSignature(''), false);
  assert.equal(verifyStateTokenSignature(null), false);
  assert.equal(verifyStateTokenSignature(undefined), false);
  assert.equal(verifyStateTokenSignature(12345), false);
});
