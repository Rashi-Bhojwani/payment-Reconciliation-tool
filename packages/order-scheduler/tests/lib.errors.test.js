import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  InvalidStateError,
  PiiBoundaryError,
  CryptoError,
} from '../src/lib/errors.js';

test('error classes carry status, code and expose flags', () => {
  const validation = new ValidationError('bad input', { field: 'weight' });
  assert.equal(validation.status, 400);
  assert.equal(validation.code, 'VALIDATION_ERROR');
  assert.equal(validation.expose, true);
  assert.deepEqual(validation.details, { field: 'weight' });

  assert.equal(new NotFoundError().status, 404);
  assert.equal(new ForbiddenError().status, 403);
  assert.equal(new InvalidStateError('nope').status, 422);
});

test('internal errors are never exposed to responses', () => {
  // These carry information an operator may see but a browser must not.
  assert.equal(new CryptoError('key version 2 not configured').expose, false);
  assert.equal(new PiiBoundaryError('buyerName reached the AI boundary').expose, false);
  assert.equal(new AppError('boom').expose, false);
});

test('errors keep their class name and preserve the cause chain', () => {
  const root = new Error('socket hang up');
  const wrapped = new CryptoError('decrypt failed', { cause: root });
  assert.equal(wrapped.name, 'CryptoError');
  assert.equal(wrapped.cause, root);
  assert.ok(wrapped instanceof AppError);
  assert.ok(wrapped instanceof Error);
});
