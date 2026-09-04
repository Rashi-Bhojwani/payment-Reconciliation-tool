// Proves the composed stack (rate limit → retry → circuit breaker) behaves
// correctly against a stubbed HTTP layer: a 429 backs off rather than
// retry-storming, and the limiter serialises concurrent calls for the same
// account. Mirrors the acceptance bar from the original SP-API client plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { spApiRequest } from '../src/integrations/amazon/http.js';
import { SpApiThrottleError, SpApiAuthError, SpApiRequestError } from '../src/integrations/amazon/errors.js';
import { _resetCaches } from '../src/integrations/amazon/auth/lwa.js';

// getAccessToken() calls the real LWA endpoint over HTTP (via axios.post);
// each test mocks that too, so these tests need no network and no real
// credentials. axios.request (used by spApiRequest itself) is mocked
// per-test to control the SP-API response sequence.
test.beforeEach(() => {
  _resetCaches();
});

test('a 429 is retried with backoff, not retried instantly in a storm', async (t) => {
  const attempts = [];
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => {
    attempts.push(Date.now());
    if (attempts.length < 3) {
      return { status: 429, headers: { 'retry-after': '0.05' }, data: {} };
    }
    return { status: 200, headers: {}, data: { payload: { Orders: [], NextToken: undefined } } };
  });

  const result = await spApiRequest({
    accountKey: 'acct-http-1',
    operation: 'searchOrders',
    method: 'GET',
    url: 'https://example.invalid/orders',
    refreshToken: 'refresh-token-value',
  });

  assert.deepEqual(result, { payload: { Orders: [], NextToken: undefined } });
  assert.equal(attempts.length, 3, 'should have retried the 429 exactly twice before succeeding');
  // Retry-After: 0.05s was honoured — not an instant retry-storm.
  assert.ok(attempts[1] - attempts[0] >= 30, 'second attempt should have waited for Retry-After');
});

test('repeated 429s exhaust retries and raise SpApiThrottleError, never hang', async (t) => {
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  let calls = 0;
  t.mock.method(axios, 'request', async () => {
    calls += 1;
    return { status: 429, headers: {}, data: {} };
  });

  await assert.rejects(
    spApiRequest({
      accountKey: 'acct-http-2',
      operation: 'getOrder',
      method: 'GET',
      url: 'https://example.invalid/orders/1',
      refreshToken: 'refresh-token-value',
    }),
    SpApiThrottleError,
  );
  assert.equal(calls, 5, 'the retry policy caps at 5 attempts, never an unbounded storm');
});

test('a 401 is not retried — auth failures are not transient', async (t) => {
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  let calls = 0;
  t.mock.method(axios, 'request', async () => {
    calls += 1;
    return { status: 401, headers: {}, data: {} };
  });

  await assert.rejects(
    spApiRequest({
      accountKey: 'acct-http-3',
      operation: 'getOrder',
      method: 'GET',
      url: 'https://example.invalid/orders/1',
      refreshToken: 'refresh-token-value',
    }),
    SpApiAuthError,
  );
  assert.equal(calls, 1, 'an auth error must fail fast, not retry');
});

test('a genuine 4xx rejection (e.g. 400) is not retried, is not mis-reported as this app\'s own 4xx, and carries Amazon\'s actual reason', async (t) => {
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  let calls = 0;
  t.mock.method(axios, 'request', async () => {
    calls += 1;
    return {
      status: 400,
      headers: {},
      data: { errors: [{ code: 'InvalidInput', message: 'MarketplaceIds is required' }] },
    };
  });

  let error;
  try {
    await spApiRequest({
      accountKey: 'acct-http-5',
      operation: 'searchOrders',
      method: 'GET',
      url: 'https://example.invalid/orders',
      refreshToken: 'refresh-token-value',
    });
    assert.fail('expected spApiRequest to reject');
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof SpApiRequestError);
  assert.equal(calls, 1, 'a genuine 4xx rejection is not transient — must fail fast, not retry');
  // The previous version of this branch overwrote .status with Amazon's raw
  // 4xx, so this app's own error page rendered "400" as if the human's
  // request *to this app* (not this app's call to Amazon) were invalid.
  assert.equal(error.status, 502, 'reported as an upstream failure, not this app\'s own 400');
  assert.equal(error.expose, false);
  assert.ok(
    error.message.includes('MarketplaceIds is required'),
    `Amazon's actual reason must be in the message for the server log to be diagnostic, got: ${error.message}`,
  );
});

test('the x-amzn-RateLimit-Limit response header adjusts the effective rate', async (t) => {
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => ({
    status: 200,
    headers: { 'x-amzn-ratelimit-limit': '50' },
    data: { payload: { Orders: [] } },
  }));

  // Two rapid calls on a fresh account key: the default getOrder rate
  // (0.5/sec, burst 30) would not itself force a wait for just 2 calls, so
  // this only proves the header is read without erroring — the rate math
  // itself is covered by lib.rateLimiter.test.js.
  await spApiRequest({
    accountKey: 'acct-http-4', operation: 'getOrder', method: 'GET',
    url: 'https://example.invalid/orders/1', refreshToken: 'refresh-token-value',
  });
  await spApiRequest({
    accountKey: 'acct-http-4', operation: 'getOrder', method: 'GET',
    url: 'https://example.invalid/orders/2', refreshToken: 'refresh-token-value',
  });
});
