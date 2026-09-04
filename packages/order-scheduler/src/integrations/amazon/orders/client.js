// Orders API v2026-01-01 only — v0 is deprecated and removed 2027-03-27, so
// no v0 code exists here. `getOrder` returns complete order+item data in one
// request; `includedData` is used to request only what's needed.
//
// createdAfter and lastUpdatedAfter are mutually exclusive per call — the
// caller picks exactly one. searchOrders cannot fetch by specific order ids;
// use getOrder per id for that (rule from the SP-API research this app is
// built against).
import { hostForRegion } from '../endpoints.js';
import { spApiRequest } from '../http.js';
import { GetOrderResponseSchema, SearchOrdersResponseSchema, parseOrThrow } from './schemas.js';

const ORDERS_API_VERSION = '2026-01-01';

function baseUrl(region, { sandbox = false } = {}) {
  return `https://${hostForRegion(region, { sandbox })}/orders/${ORDERS_API_VERSION}`;
}

/**
 * @param {object} account - { id, region } — id scopes the rate limiter/circuit breaker
 * @param {string} refreshToken - decrypted
 * @param {string} amazonMarketplaceId
 * @param {object} options - { createdAfter } XOR { lastUpdatedAfter }, nextToken, sandbox
 */
export async function searchOrders(account, refreshToken, amazonMarketplaceId, options = {}) {
  const { createdAfter, lastUpdatedAfter, nextToken, sandbox } = options;
  if (Boolean(createdAfter) === Boolean(lastUpdatedAfter)) {
    throw new Error('searchOrders requires exactly one of createdAfter or lastUpdatedAfter');
  }
  const data = await spApiRequest({
    accountKey: account.id,
    operation: 'searchOrders',
    method: 'GET',
    url: `${baseUrl(account.region, { sandbox })}/orders`,
    refreshToken,
    params: {
      MarketplaceIds: amazonMarketplaceId,
      // Confirmed against a live SP-API 400 (InvalidInput): the v2026-01-01
      // Orders API rejected PascalCase CreatedAfter/LastUpdatedAfter and its
      // own error text named the params it wanted in camelCase — "One and
      // only one of createdAfter or lastUpdatedAfter must be provided."
      // Unlike v0's fully-PascalCase query params (MarketplaceIds included),
      // this version mixes conventions: MarketplaceIds/NextToken untouched
      // since nothing has evidenced those are wrong too.
      ...(createdAfter ? { createdAfter } : { lastUpdatedAfter }),
      // Not directly confirmed the way createdAfter/lastUpdatedAfter and
      // MarketplaceIds are (no live sample of a page-2 request yet) — but
      // the response mirrors this exact value back as pagination.nextToken
      // (camelCase, same as the date filters), so camelCase is the better
      // bet than the old PascalCase NextToken. If a real 400 says
      // otherwise, that error will name the param it wants, same as before.
      ...(nextToken ? { nextToken } : {}),
    },
  });
  const parsed = parseOrThrow(SearchOrdersResponseSchema, data, 'searchOrders');
  // Confirmed against a live response: no payload wrapper, orders/pagination
  // at the top level, the cursor nested under pagination.nextToken (not a
  // top-level NextToken) — see schemas.js's SearchOrdersResponseSchema.
  return { orders: parsed.orders, nextToken: parsed.pagination?.nextToken ?? null };
}

/**
 * Complete order data in one request. `includedData` defaults to the fields
 * this application actually uses — less data requested is better performance,
 * per the SP-API guidance this integration follows.
 *
 * No separate getOrderItems call: confirmed against multiple live responses,
 * this endpoint's own orderItems array already carries full item data (same
 * as searchOrders) — a prior version of this function made a second request
 * per order to fetch items that were already here, doubling the SP-API
 * calls (and therefore rate-limit/circuit-breaker pressure) of every sync.
 */
export async function getOrder(account, refreshToken, amazonOrderId, options = {}) {
  const includedData = options.includedData ?? ['BUYER', 'RECIPIENT', 'FULFILLMENT'];
  const data = await spApiRequest({
    accountKey: account.id,
    operation: 'getOrder',
    method: 'GET',
    url: `${baseUrl(account.region, { sandbox: options.sandbox })}/orders/${amazonOrderId}`,
    refreshToken,
    params: { includedData: includedData.join(',') },
  });
  const parsed = parseOrThrow(GetOrderResponseSchema, data, 'getOrder');
  // Confirmed against a live response: no payload wrapper, the order sits
  // at the top level under `order` — see schemas.js's GetOrderSchema.
  return parsed.order;
}
