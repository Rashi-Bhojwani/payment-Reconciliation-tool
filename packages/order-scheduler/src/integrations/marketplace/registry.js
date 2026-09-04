// The only file in the application allowed to import a concrete adapter.
// Every generic service asks THIS module for an adapter by code — never
// `import AmazonAdapter from '...'` anywhere else. That single rule is what
// makes "add Flipkart" a change to two files (its own adapter, and the one
// new line here) instead of a search-and-replace across the app.
import { AmazonAdapter } from '../amazon/AmazonAdapter.js';
import { FlipkartAdapter } from '../flipkart/FlipkartAdapter.js';
import { MyntraAdapter } from '../myntra/MyntraAdapter.js';
import { MeeshoAdapter } from '../meesho/MeeshoAdapter.js';
import { NotFoundError } from '../../lib/errors.js';

// One instance per adapter class — adapters are stateless (no per-account
// data cached across calls), so a shared singleton is safe and avoids
// re-validating capabilities on every lookup.
const ADAPTERS = new Map(
  [AmazonAdapter, FlipkartAdapter, MyntraAdapter, MeeshoAdapter].map((Adapter) => [
    Adapter.code,
    new Adapter(),
  ]),
);

/** @returns {import('./MarketplaceAdapter.js').MarketplaceAdapter} */
export function getAdapter(marketplaceCode) {
  const adapter = ADAPTERS.get(marketplaceCode);
  if (!adapter) {
    throw new NotFoundError(`No adapter registered for marketplace "${marketplaceCode}"`);
  }
  return adapter;
}

export function getCapabilities(marketplaceCode) {
  return getAdapter(marketplaceCode).capabilities;
}

/** Every registered marketplace code, for the "add marketplace account" form. */
export function listRegisteredCodes() {
  return [...ADAPTERS.keys()];
}
