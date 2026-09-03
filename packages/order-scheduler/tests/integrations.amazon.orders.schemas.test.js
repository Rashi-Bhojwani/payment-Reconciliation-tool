// parseOrThrow's raw-response detail was previously dropped entirely on a
// shape mismatch — a real sync failure ("Unexpected SP-API response shape")
// left nothing in the server log to say WHAT Amazon actually sent, only
// which Zod path was missing/wrong. Locks in that the raw response is now
// attached (server-log-only — SpApiValidationError's expose:false already
// keeps it out of any browser response, same as every SP-API error class).
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseOrThrow, SearchOrdersResponseSchema, GetOrderResponseSchema } from '../src/integrations/amazon/orders/schemas.js';
import { SpApiValidationError } from '../src/integrations/amazon/errors.js';

test('valid data (the confirmed real shape) parses through unchanged', () => {
  const data = { orders: [], pagination: {} };
  const result = parseOrThrow(SearchOrdersResponseSchema, data, 'searchOrders');
  assert.deepEqual(result.orders, []);
});

test('a shape mismatch throws SpApiValidationError with the raw response attached, not just the Zod issue path', () => {
  // The OLD (wrong) assumed shape: a `payload` wrapper, PascalCase fields.
  // This is exactly what broke in production before the real shape was
  // confirmed — kept here as the negative case precisely because it's the
  // real historical bug, not a hypothetical one.
  const unexpectedShape = { payload: { Orders: [], NextToken: null } };

  let error;
  try {
    parseOrThrow(SearchOrdersResponseSchema, unexpectedShape, 'searchOrders');
    assert.fail('expected parseOrThrow to throw');
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof SpApiValidationError);
  assert.equal(error.expose, false, 'never shown to the browser — server log only');
  assert.deepEqual(
    error.details.rawResponse,
    unexpectedShape,
    'the actual response Amazon sent must be in the log — a Zod issue path alone ("payload: Required") does not say whether payload moved, was renamed, or is missing entirely',
  );
  assert.ok(error.details.issues.some((i) => i.path === 'orders'), 'the old shape has no top-level `orders` field');
});

test('a real (trimmed) live order — inline items, no status/ship-by/PII fields — parses without those required', () => {
  // Confirms the schema doesn't demand fields the real API simply doesn't
  // send in a list result (order status, ship-by dates, buyer info) — those
  // are legitimately absent, not a parsing bug.
  const data = {
    orders: [
      {
        orderId: '402-5701434-8490727',
        createdTime: '2026-08-04T08:54:55.956Z',
        lastUpdatedTime: '2026-08-12T06:28:59.326Z',
        programs: ['AMAZON_EASY_SHIP'],
        salesChannel: { marketplaceId: 'A21TJRUUN4KGV', marketplaceName: 'Amazon.in', channelName: 'AMAZON' },
        orderItems: [
          {
            orderItemId: '66101273845482',
            quantityOrdered: 1,
            product: { asin: 'B0H7XF1DVL', sellerSku: 'SG-SPMB-12', title: 'Mounting Bracket' },
          },
        ],
      },
    ],
    pagination: { nextToken: 'abc' },
    createdBefore: '2026-09-02T07:18:19.746Z',
  };
  const result = parseOrThrow(SearchOrdersResponseSchema, data, 'searchOrders');
  assert.equal(result.orders[0].orderId, '402-5701434-8490727');
  assert.equal(result.orders[0].orderItems[0].orderItemId, '66101273845482');
});

test('getOrder: a real live response — no payload wrapper, real fulfillmentStatus, orderItems inline — parses correctly', () => {
  // Captured verbatim (trimmed) from a production rawResponse dump —
  // exactly what surfaced the "Unexpected SP-API response shape (getOrder)"
  // failures this schema replaces: the app was still assuming a v0-style
  // `{ payload: { AmazonOrderId, ..., OrderStatus } }` shape that Amazon
  // never actually sends for this API version.
  const data = {
    order: {
      orderId: '405-1519618-4541149',
      recipient: {
        deliveryAddress: {
          stateOrRegion: 'KERALA', city: 'malappuram', countryCode: 'IN',
          addressType: 'RESIDENTIAL', postalCode: '679323',
        },
      },
      createdTime: '2026-08-09T16:13:49.295Z',
      lastUpdatedTime: '2026-08-17T11:32:37.315Z',
      programs: ['AMAZON_EASY_SHIP'],
      fulfillment: {
        shipByWindow: { latestDateTime: '2026-08-11T18:29:59Z', earliestDateTime: '2026-08-10T18:30:00Z' },
        fulfilledBy: 'MERCHANT',
        deliverByWindow: { latestDateTime: '2026-08-22T18:29:59Z', earliestDateTime: '2026-08-21T18:30:00Z' },
        fulfillmentStatus: 'SHIPPED',
        fulfillmentServiceLevel: 'STANDARD',
      },
      salesChannel: { marketplaceId: 'A21TJRUUN4KGV', marketplaceName: 'Amazon.in', channelName: 'AMAZON' },
      orderItems: [
        {
          product: {
            condition: { conditionSubtype: 'NEW', conditionType: 'NEW' },
            price: { unitPrice: { amount: '2029.0', currencyCode: 'INR' } },
            asin: 'B0H7XHVR2F', sellerSku: 'SG-SPMB-64', title: 'Solar Panel Mounting Bracket',
          },
          orderItemId: '66283916851282',
          quantityOrdered: 1,
          fulfillment: { quantityUnfulfilled: 0, quantityFulfilled: 1 },
        },
      ],
    },
  };
  const result = parseOrThrow(GetOrderResponseSchema, data, 'getOrder');
  assert.equal(result.order.orderId, '405-1519618-4541149');
  assert.equal(result.order.fulfillment.fulfillmentStatus, 'SHIPPED');
  assert.equal(result.order.orderItems[0].orderItemId, '66283916851282');
});

test('getOrder: the old (wrong) v0-shaped guess no longer parses — the real bug this schema fixed', () => {
  const oldGuessedShape = {
    payload: { AmazonOrderId: '402-6538125-4261120', PurchaseDate: '2026-08-04T13:34:33.433Z', OrderStatus: 'Shipped' },
  };
  assert.throws(() => parseOrThrow(GetOrderResponseSchema, oldGuessedShape, 'getOrder'), SpApiValidationError);
});

test('an unrelated schema/data pairing still reports the raw response too (not specific to Orders)', () => {
  const schema = z.object({ requiredField: z.string() });
  let error;
  try {
    parseOrThrow(schema, { somethingElse: true }, 'anyContext');
    assert.fail('expected parseOrThrow to throw');
  } catch (caught) {
    error = caught;
  }
  assert.deepEqual(error.details.rawResponse, { somethingElse: true });
});
