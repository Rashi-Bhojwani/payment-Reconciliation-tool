// The contract every marketplace integration implements. This is the ONLY
// file the generic services (OrderSyncService, SchedulingService,
// SellerService) and the registry are allowed to know about — never a
// concrete adapter. See APP_ARCHITECTURE.md §7 and §21 (the core rule this
// class exists to enforce): CORE → GENERIC SERVICE → MarketplaceAdapter →
// marketplace API, never CORE → a specific marketplace's API directly.
//
// Plain JS has no interfaces, so this is a base class: every method throws
// NotImplementedError by default. A concrete adapter overrides only the
// methods its marketplace and this application's integration actually
// support, and MUST set its `capabilities` flag to false for anything it
// doesn't override — see MarketplaceCapabilities.js.
import { NotImplementedError } from '../../lib/errors.js';
import { assertValidCapabilities, NO_CAPABILITIES } from './MarketplaceCapabilities.js';

export class MarketplaceAdapter {
  /** Matches a row in the `marketplaces` table, e.g. 'AMAZON'. Set by subclasses. */
  static code = null;

  /** Human-readable name for the UI, e.g. 'Amazon'. Set by subclasses. */
  static displayName = null;

  constructor() {
    if (new.target === MarketplaceAdapter) {
      throw new Error('MarketplaceAdapter is abstract — extend it, never instantiate it directly');
    }
    if (!new.target.code) {
      throw new Error(`${new.target.name} must set a static \`code\``);
    }
    // Validated once per adapter construction rather than per call — cheap,
    // and catches a capabilities/method mismatch the moment the adapter is
    // registered rather than deep inside a scheduling run.
    assertValidCapabilities(new.target.code, new.target.capabilities ?? NO_CAPABILITIES);
  }

  get capabilities() {
    return this.constructor.capabilities ?? NO_CAPABILITIES;
  }

  #notImplemented(method) {
    return new NotImplementedError(
      `${this.constructor.code} does not support ${method}() in this application`,
    );
  }

  // --- connection lifecycle ------------------------------------------------

  /**
   * Build whatever the seller needs to grant us access — an OAuth consent
   * URL for Amazon, potentially something else for a future marketplace.
   * @param {object} marketplaceAccount - the PENDING account row
   * @param {object} params - adapter-specific extras (e.g. redirect URI)
   * @returns {Promise<{ url: string, stateToken: string, expiresAt: Date }>}
   */
  async authorize(marketplaceAccount, params) {
    throw this.#notImplemented('authorize');
  }

  /**
   * Handle the marketplace's redirect back to us. Verifies whatever state
   * token authorize() issued, exchanges any code for credentials, and
   * returns what the account row and its credentials should be updated to.
   * @returns {Promise<{ externalAccountId: string, credentials: object, metadata?: object }>}
   */
  async handleCallback(request) {
    throw this.#notImplemented('handleCallback');
  }

  /** Refresh whatever access token this marketplace's API calls need. */
  async refreshAuthentication(marketplaceAccount) {
    throw this.#notImplemented('refreshAuthentication');
  }

  // --- orders ----------------------------------------------------------------

  /**
   * Fetch orders for this account. Pagination, rate limiting and retry are
   * entirely this method's responsibility — the caller just iterates results.
   * @returns {Promise<{ orders: object[], nextCursor: string|null }>}
   */
  async getOrders(marketplaceAccount, query) {
    throw this.#notImplemented('getOrders');
  }

  async getOrder(marketplaceAccount, externalOrderId) {
    throw this.#notImplemented('getOrder');
  }

  async updateOrder(marketplaceAccount, externalOrderId, patch) {
    throw this.#notImplemented('updateOrder');
  }

  // --- scheduling --------------------------------------------------------

  /** Schedule one order's shipment. Required if capabilities.supportsSingleScheduling. */
  async scheduleOrder(marketplaceAccount, order, packageInfo) {
    throw this.#notImplemented('scheduleOrder');
  }

  /** Schedule many orders in one call. Required if capabilities.supportsBulkScheduling. */
  async scheduleOrdersBulk(marketplaceAccount, orders) {
    throw this.#notImplemented('scheduleOrdersBulk');
  }

  async getShipmentStatus(marketplaceAccount, externalShipmentId) {
    throw this.#notImplemented('getShipmentStatus');
  }

  // --- future capabilities, interface-only everywhere today ----------------

  async getInventory(marketplaceAccount) {
    throw this.#notImplemented('getInventory');
  }

  async cancelOrder(marketplaceAccount, externalOrderId) {
    throw this.#notImplemented('cancelOrder');
  }
}

export default MarketplaceAdapter;
