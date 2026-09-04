// Interface-only. No Flipkart API call exists anywhere in this file or
// module — every method is the inherited NotImplementedError stub from
// MarketplaceAdapter. This exists so the registry, the dashboard's
// "Marketplaces" list, and the "add marketplace account" form can treat
// Flipkart as a real, selectable option without pretending it works.
//
// To actually implement Flipkart: override the methods this integration
// needs (start with authorize/handleCallback and getOrders), flip the
// matching capability flags to true, and add auth/orders/scheduling
// submodules the same way src/integrations/amazon/ is organized. Nothing
// outside this directory needs to change — see APP_ARCHITECTURE.md §18.
import { MarketplaceAdapter } from '../marketplace/MarketplaceAdapter.js';
import { NO_CAPABILITIES } from '../marketplace/MarketplaceCapabilities.js';

export class FlipkartAdapter extends MarketplaceAdapter {
  static code = 'FLIPKART';
  static displayName = 'Flipkart';
  static capabilities = NO_CAPABILITIES;
}

export default FlipkartAdapter;
