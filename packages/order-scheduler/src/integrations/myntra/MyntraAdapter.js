// Interface-only — see FlipkartAdapter.js for the full explanation, it
// applies identically here.
//
// Called out explicitly in APP_ARCHITECTURE.md as the marketplace most
// likely to need real bulk scheduling once implemented (per the product
// brief). That is a reason to implement it carefully when the time comes,
// not a reason to fake `supportsBulkScheduling: true` now — a capability
// flag with no working method behind it is worse than an honest false.
import { MarketplaceAdapter } from '../marketplace/MarketplaceAdapter.js';
import { NO_CAPABILITIES } from '../marketplace/MarketplaceCapabilities.js';

export class MyntraAdapter extends MarketplaceAdapter {
  static code = 'MYNTRA';
  static displayName = 'Myntra';
  static capabilities = NO_CAPABILITIES;
}

export default MyntraAdapter;
