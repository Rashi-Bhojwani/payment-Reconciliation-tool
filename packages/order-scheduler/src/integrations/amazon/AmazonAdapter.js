// The first real marketplace integration. Every method here is the only
// place in the application that knows an "order" is an Amazon order — the
// generic services (marketplaceConnectionService, orderSyncService,
// schedulingService) only ever see the shapes this class returns.
//
// Credential handling contract: callers (the generic services) decrypt
// marketplace_account_credentials via src/lib/crypto.js and attach the
// plaintext as `marketplaceAccount.credentials.refreshToken` before calling
// any authenticated method here. This adapter never reads the credentials
// table itself and never decrypts — that keeps decryption in one place
// (audited, rule-following) regardless of which adapter is in use.
import { MarketplaceAdapter } from '../marketplace/MarketplaceAdapter.js';
import { config } from '../../config.js';
import { generateStateToken, verifyStateTokenSignature } from '../../lib/stateToken.js';
import { SpApiAuthError, SpApiValidationError } from './errors.js';
import { exchangeAuthorizationCode } from './auth/lwa.js';
import * as ordersClient from './orders/client.js';
import * as easyShip from './scheduling/easyShip.js';
import { childLogger } from '../../lib/logger.js';

const log = childLogger('amazon:adapter');
const STATE_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class AmazonAdapter extends MarketplaceAdapter {
  static code = 'AMAZON';
  static displayName = 'Amazon';
  static capabilities = {
    supportsOrderSync: true,
    supportsSingleScheduling: true,
    // Easy Ship books one package at a time — true to the real API, not a
    // gap in this implementation.
    supportsBulkScheduling: false,
    supportsShipmentTracking: true,
    supportsCancellation: false,
    supportsReturns: false,
  };

  // --- connection lifecycle ------------------------------------------------

  async authorize(marketplaceAccount, { redirectUri } = {}) {
    if (!config.spapi.configured) {
      throw new SpApiAuthError('LWA_CLIENT_ID / LWA_CLIENT_SECRET are not configured');
    }
    const stateToken = generateStateToken();
    const expiresAt = new Date(Date.now() + STATE_TOKEN_TTL_MS);
    const params = new URLSearchParams({
      application_id: config.spapi.appId,
      state: stateToken,
      redirect_uri: redirectUri ?? config.spapi.redirectUri,
    });
    if (config.spapi.draftApp) params.set('version', 'beta');

    const url = `https://sellercentral.amazon.in/apps/authorize/consent?${params.toString()}`;
    return { url, stateToken, expiresAt };
  }

  /**
   * `request` carries the raw callback query params. Signature verification
   * happens here (fast, no DB); single-use/expiry consumption happens in
   * marketplaceConnectionService via marketplaceConnectionRequests.consume()
   * — this method never touches the database.
   */
  async handleCallback(request) {
    const { spapi_oauth_code: code, state, selling_partner_id: sellingPartnerId } = request.query ?? {};
    if (!code || !state) {
      throw new SpApiValidationError('Amazon callback missing spapi_oauth_code or state');
    }
    if (!verifyStateTokenSignature(state)) {
      throw new SpApiAuthError('Amazon callback state token failed signature verification');
    }
    const { refreshToken } = await exchangeAuthorizationCode(code);
    log.info({ sellingPartnerId }, 'exchanged Amazon authorization code');
    return {
      stateToken: state,
      externalAccountId: sellingPartnerId ?? null,
      credentials: { refreshToken },
      metadata: {},
    };
  }

  async refreshAuthentication(marketplaceAccount) {
    // getAccessToken() is already cached + single-flighted; calling it here
    // just warms the cache ahead of a burst of order-sync calls.
    const { getAccessToken } = await import('./auth/lwa.js');
    await getAccessToken(marketplaceAccount.credentials.refreshToken);
  }

  // --- orders ----------------------------------------------------------------

  async getOrders(marketplaceAccount, query = {}) {
    const amazonMarketplaceId = marketplaceAccount.metadata?.amazonMarketplaceId;
    const { orders, nextToken } = await ordersClient.searchOrders(
      marketplaceAccount,
      marketplaceAccount.credentials.refreshToken,
      amazonMarketplaceId,
      query,
    );
    // v2026-01-01's search results already carry full item data inline
    // (confirmed against a live response) — normalizeSearchOrder folds it
    // in directly, no separate getOrderItems() round trip needed here.
    // orderSyncService still makes one getOrder() call per order afterwards
    // for the fields search never carries (status, ship-by dates — see
    // normalizeGetOrder below), but that response also carries its own
    // items inline, so no getOrderItems call happens anywhere anymore.
    return { orders: orders.map(normalizeSearchOrder), nextCursor: nextToken };
  }

  async getOrder(marketplaceAccount, externalOrderId) {
    const order = await ordersClient.getOrder(
      marketplaceAccount,
      marketplaceAccount.credentials.refreshToken,
      externalOrderId,
    );
    return normalizeGetOrder(order);
  }

  // updateOrder: not overridden. Amazon exposes no generic "update order"
  // call for sellers — order fields change only via scheduling/shipment
  // actions, so the base class's NotImplementedError stands as-is.

  // --- scheduling --------------------------------------------------------

  async scheduleOrder(marketplaceAccount, order, packageInfo) {
    const amazonMarketplaceId = marketplaceAccount.metadata?.amazonMarketplaceId;
    const refreshToken = marketplaceAccount.credentials.refreshToken;
    const packageDetails = toEasyShipPackageDetails(packageInfo);

    const slots = await easyShip.listHandoverSlots(
      marketplaceAccount, refreshToken,
      { amazonOrderId: order.external_order_id, packageDetails },
      { amazonMarketplaceId },
    );
    const slotId = slots?.slotList?.[0]?.slotId;
    if (!slotId) {
      throw new SpApiValidationError('Amazon returned no available Easy Ship handover slots');
    }

    const result = await easyShip.createScheduledPackage(
      marketplaceAccount, refreshToken,
      { amazonOrderId: order.external_order_id, packageDetails, slotId, idempotencyKey: order.idempotencyKey },
      { amazonMarketplaceId },
    );

    return {
      externalShipmentId: result?.packageId ?? null,
      trackingId: result?.trackingId ?? null,
      carrierName: 'Amazon Easy Ship',
      pickupStart: slots?.slotList?.[0]?.slotStartTime ?? null,
      pickupEnd: slots?.slotList?.[0]?.slotEndTime ?? null,
      labelUrl: result?.labelUrl ?? null,
      invoiceUrl: result?.invoiceUrl ?? null,
    };
  }

  async getShipmentStatus(marketplaceAccount, externalShipmentId) {
    const amazonMarketplaceId = marketplaceAccount.metadata?.amazonMarketplaceId;
    return easyShip.getLabel(
      marketplaceAccount, marketplaceAccount.credentials.refreshToken,
      { amazonOrderId: externalShipmentId }, { amazonMarketplaceId },
    );
  }
}

// --- normalization: SP-API shape → unified order model input ----------------

/**
 * searchOrders' confirmed real shape (see orders/schemas.js's
 * SearchOrderSchema) — a different, narrower set of available fields than
 * normalizeGetOrder() below (which backs getOrder — see its own doc
 * comment). Notably absent from a list result entirely: order status,
 * ship-by/delivery-by dates, order total, buyer name/email, shipping
 * address — left null here rather than guessed at; normalizeGetOrder()
 * fills those back in from the per-order detail call orderSyncService makes
 * for exactly this reason.
 */
function normalizeSearchOrder(raw) {
  return {
    externalOrderId: raw.orderId,
    orderDate: raw.createdTime,
    lastUpdatedDate: raw.lastUpdatedTime,
    marketplaceStatus: null,
    fulfillmentChannel: null,
    shipServiceLevel: null,
    isPrime: false,
    isBusinessOrder: (raw.programs ?? []).includes('AMAZON_BUSINESS'),
    earliestShipDate: null,
    shipByDate: null,
    deliveryByDate: null,
    orderTotalAmount: null,
    orderTotalCurrency: null,
    buyerName: null,
    buyerEmail: null,
    shippingAddress: null,
    items: (raw.orderItems ?? []).map(normalizeSearchOrderItem),
    rawResponse: raw,
  };
}

function normalizeSearchOrderItem(raw) {
  return {
    externalItemId: raw.orderItemId,
    externalProductId: raw.product?.asin ?? null,
    sku: raw.product?.sellerSku ?? null,
    title: raw.product?.title ?? null,
    quantityOrdered: raw.quantityOrdered,
    quantityShipped: raw.quantityShipped ?? 0,
    unitPrice: raw.product?.price?.unitPrice?.amount ?? null,
    currency: raw.product?.price?.unitPrice?.currencyCode ?? null,
  };
}

/**
 * getOrder's confirmed real shape (see orders/schemas.js's GetOrderSchema)
 * — captured from multiple live rawResponse dumps once the schema mismatch
 * that was hiding them got fixed. Same camelCase family as
 * normalizeSearchOrder above, with the fields search never carries filled
 * in for real: fulfillment.fulfillmentStatus is the actual order status
 * (confirmed values: "SHIPPED", "CANCELLED" — not the PascalCase
 * "OrderStatus" a prior, unverified version of this function guessed at),
 * shipByDate/deliveryByDate come from the *latest* end of each window (the
 * deadline, which is what this app's shipByUrgency banding needs), and
 * recipient.deliveryAddress carries only geographic fields — no name, phone
 * or street line ever appeared in a live sample, so buyerName/shippingAddress
 * stay null here rather than populated from a shape that was never actually
 * seen (full buyer PII needs a Restricted Data Token this app doesn't fetch
 * — see APP_ARCHITECTURE.md's Merchant Fulfillment API discussion).
 */
function normalizeGetOrder(raw) {
  return {
    externalOrderId: raw.orderId,
    orderDate: raw.createdTime,
    lastUpdatedDate: raw.lastUpdatedTime,
    marketplaceStatus: raw.fulfillment?.fulfillmentStatus ?? null,
    fulfillmentChannel: raw.fulfillment?.fulfilledBy ?? null,
    shipServiceLevel: raw.fulfillment?.fulfillmentServiceLevel ?? null,
    isPrime: false,
    isBusinessOrder: (raw.programs ?? []).includes('AMAZON_BUSINESS'),
    earliestShipDate: raw.fulfillment?.shipByWindow?.earliestDateTime ?? null,
    shipByDate: raw.fulfillment?.shipByWindow?.latestDateTime ?? null,
    deliveryByDate: raw.fulfillment?.deliverByWindow?.latestDateTime ?? null,
    orderTotalAmount: null,
    orderTotalCurrency: null,
    buyerName: null,
    buyerEmail: null,
    shippingAddress: null,
    items: (raw.orderItems ?? []).map(normalizeGetOrderItem),
    rawResponse: raw,
  };
}

function normalizeGetOrderItem(raw) {
  return {
    externalItemId: raw.orderItemId,
    externalProductId: raw.product?.asin ?? null,
    sku: raw.product?.sellerSku ?? null,
    title: raw.product?.title ?? null,
    quantityOrdered: raw.quantityOrdered,
    quantityShipped: raw.fulfillment?.quantityFulfilled ?? 0,
    unitPrice: raw.product?.price?.unitPrice?.amount ?? null,
    currency: raw.product?.price?.unitPrice?.currencyCode ?? null,
  };
}

function toEasyShipPackageDetails(packageInfo) {
  return {
    weight: { value: Number(packageInfo.weightGrams), unit: 'g' },
    dimensions: {
      length: Number(packageInfo.lengthCm),
      width: Number(packageInfo.widthCm),
      height: Number(packageInfo.heightCm),
      unit: 'cm',
    },
    packagingType: packageInfo.packageType,
  };
}

export default AmazonAdapter;
