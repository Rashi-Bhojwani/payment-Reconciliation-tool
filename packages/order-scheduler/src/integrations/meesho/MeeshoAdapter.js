// Interface-only — see FlipkartAdapter.js for the full explanation, it
// applies identically here.
import { MarketplaceAdapter } from '../marketplace/MarketplaceAdapter.js';
import { NO_CAPABILITIES } from '../marketplace/MarketplaceCapabilities.js';

export class MeeshoAdapter extends MarketplaceAdapter {
  static code = 'MEESHO';
  static displayName = 'Meesho';
  static capabilities = NO_CAPABILITIES;
}

export default MeeshoAdapter;
