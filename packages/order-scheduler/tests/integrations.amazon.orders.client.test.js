// Nothing previously asserted on the actual outgoing query param names for
// searchOrders — every test mocked axios.request's *response*, never
// inspected the *request*. That's exactly how CreatedAfter/LastUpdatedAfter
// (PascalCase) shipped and broke every real sync: SP-API's live 400 named
// the params it wanted in camelCase ("One and only one of createdAfter or
// lastUpdatedAfter must be provided"). This file closes that gap.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { searchOrders } from '../src/integrations/amazon/orders/client.js';
import { _resetCaches } from '../src/integrations/amazon/auth/lwa.js';

test.beforeEach(() => {
  _resetCaches();
});

function mockEmptySearchResponse(t) {
  let capturedConfig;
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async (config) => {
    capturedConfig = config;
    // Confirmed real shape — no payload wrapper (see schemas.js).
    return { status: 200, headers: {}, data: { orders: [], pagination: {} } };
  });
  return () => capturedConfig;
}

test('createdAfter is sent as camelCase, not PascalCase', async (t) => {
  const getConfig = mockEmptySearchResponse(t);

  await searchOrders(
    { id: 'acct-orders-1', region: 'eu-west-1' },
    'refresh-token-value',
    'A21TJRUUN4KGV',
    { createdAfter: '2026-08-01T00:00:00.000Z' },
  );

  const params = getConfig().params;
  assert.equal(params.createdAfter, '2026-08-01T00:00:00.000Z');
  assert.equal(params.CreatedAfter, undefined, 'must not send the old, rejected PascalCase param name');
  assert.equal(params.lastUpdatedAfter, undefined);
});

test('lastUpdatedAfter is sent as camelCase, not PascalCase', async (t) => {
  const getConfig = mockEmptySearchResponse(t);

  await searchOrders(
    { id: 'acct-orders-2', region: 'eu-west-1' },
    'refresh-token-value',
    'A21TJRUUN4KGV',
    { lastUpdatedAfter: '2026-08-01T00:00:00.000Z' },
  );

  const params = getConfig().params;
  assert.equal(params.lastUpdatedAfter, '2026-08-01T00:00:00.000Z');
  assert.equal(params.LastUpdatedAfter, undefined, 'must not send the old, rejected PascalCase param name');
  assert.equal(params.createdAfter, undefined);
});

test('MarketplaceIds stays PascalCase (confirmed working); nextToken is camelCase (inferred from the response mirroring it back as pagination.nextToken)', async (t) => {
  const getConfig = mockEmptySearchResponse(t);

  await searchOrders(
    { id: 'acct-orders-3', region: 'eu-west-1' },
    'refresh-token-value',
    'A21TJRUUN4KGV',
    { createdAfter: '2026-08-01T00:00:00.000Z', nextToken: 'cursor-abc' },
  );

  const params = getConfig().params;
  assert.equal(params.MarketplaceIds, 'A21TJRUUN4KGV');
  assert.equal(params.nextToken, 'cursor-abc');
  assert.equal(params.NextToken, undefined, 'must not send the old, unconfirmed PascalCase param name');
});

test('exactly one of createdAfter/lastUpdatedAfter is still required — both or neither throws before any request', async (t) => {
  let requestCalled = false;
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => {
    requestCalled = true;
    return { status: 200, headers: {}, data: { orders: [], pagination: {} } };
  });

  await assert.rejects(
    searchOrders({ id: 'acct-orders-4', region: 'eu-west-1' }, 'refresh-token-value', 'A21TJRUUN4KGV', {}),
  );
  assert.equal(requestCalled, false, 'the local guard must fail fast, before ever calling SP-API');

  await assert.rejects(
    searchOrders(
      { id: 'acct-orders-4', region: 'eu-west-1' },
      'refresh-token-value',
      'A21TJRUUN4KGV',
      { createdAfter: '2026-08-01T00:00:00.000Z', lastUpdatedAfter: '2026-08-01T00:00:00.000Z' },
    ),
  );
  assert.equal(requestCalled, false, 'providing both must also fail fast, not send a malformed request');
});

test('parses a real (trimmed) live response shape correctly — no payload wrapper, orders/pagination at the top level', async (t) => {
  // Trimmed from an actual production response captured while diagnosing
  // the original bug — the shape that broke the old PascalCase/payload
  // -wrapper schema.
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => ({
    status: 200,
    headers: {},
    data: {
      pagination: { nextToken: 'cursor-xyz' },
      orders: [
        {
          orderId: '403-9973834-1219522',
          createdTime: '2026-08-04T08:47:59.480Z',
          lastUpdatedTime: '2026-08-09T19:00:32.078Z',
          programs: ['AMAZON_EASY_SHIP'],
          salesChannel: { marketplaceId: 'A21TJRUUN4KGV', marketplaceName: 'Amazon.in', channelName: 'AMAZON' },
          orderItems: [
            {
              orderItemId: '66101250590922',
              quantityOrdered: 1,
              product: {
                asin: 'B0H7XHVR2F',
                sellerSku: 'SG-SPMB-64',
                title: 'Solar Panel Mounting Bracket',
                price: { unitPrice: { amount: '2029.0', currencyCode: 'INR' } },
              },
            },
          ],
        },
      ],
      createdBefore: '2026-09-02T07:18:19.746Z',
    },
  }));

  const { orders, nextToken } = await searchOrders(
    { id: 'acct-orders-5', region: 'eu-west-1' },
    'refresh-token-value',
    'A21TJRUUN4KGV',
    { createdAfter: '2026-08-01T00:00:00.000Z' },
  );

  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderId, '403-9973834-1219522');
  assert.equal(orders[0].orderItems[0].product.asin, 'B0H7XHVR2F');
  assert.equal(nextToken, 'cursor-xyz');
});
