import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/lib/circuitBreaker.js';
import { CircuitOpenError } from '../src/lib/errors.js';

test('stays closed and passes calls through while they succeed', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 1000 });
  for (let i = 0; i < 10; i += 1) {
    assert.equal(await breaker.execute('acct-1', async () => 'ok'), 'ok');
  }
  assert.equal(breaker.getState('acct-1'), 'CLOSED');
});

test('opens after reaching the failure threshold, then rejects without calling fn', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 10_000 });
  let calls = 0;
  const fail = async () => {
    calls += 1;
    throw new Error('boom');
  };

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(breaker.execute('acct-1', fail));
  }
  assert.equal(breaker.getState('acct-1'), 'OPEN');
  assert.equal(calls, 3);

  // The circuit is open: a 4th call must be rejected WITHOUT invoking fn.
  await assert.rejects(breaker.execute('acct-1', fail), CircuitOpenError);
  assert.equal(calls, 3, 'fn must not be called while the circuit is open');
});

test('a different key is unaffected by another key\'s open circuit', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 10_000 });
  await assert.rejects(breaker.execute('seller-a', async () => { throw new Error('boom'); }));
  assert.equal(breaker.getState('seller-a'), 'OPEN');
  assert.equal(await breaker.execute('seller-b', async () => 'ok'), 'ok');
});

test('half-opens after openDurationMs and closes again on a successful probe', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 30 });
  await assert.rejects(breaker.execute('acct-1', async () => { throw new Error('boom'); }));
  assert.equal(breaker.getState('acct-1'), 'OPEN');

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await breaker.execute('acct-1', async () => 'recovered'), 'recovered');
  assert.equal(breaker.getState('acct-1'), 'CLOSED');
});

test('a failed probe during half-open re-opens the circuit', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 30 });
  await assert.rejects(breaker.execute('acct-1', async () => { throw new Error('boom'); }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(breaker.execute('acct-1', async () => { throw new Error('still broken'); }));
  assert.equal(breaker.getState('acct-1'), 'OPEN');
});

test('CircuitOpenError reports a retryAfterMs the caller can wait on', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 5000 });
  await assert.rejects(breaker.execute('acct-1', async () => { throw new Error('boom'); }));
  try {
    await breaker.execute('acct-1', async () => 'unreachable');
    assert.fail('expected CircuitOpenError');
  } catch (error) {
    assert.ok(error instanceof CircuitOpenError);
    assert.ok(error.retryAfterMs > 0 && error.retryAfterMs <= 5000);
  }
});
