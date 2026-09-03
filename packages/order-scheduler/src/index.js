// The surface apps/api is allowed to use. Everything else under src/ is this
// package's own business - routes import from here, never from a repository
// path directly, so the boundary stays somewhere a reader can see it.
export { config as schedulerConfig } from './config.js';
export {
  pool as schedulingPool,
  query as schedulingQuery,
  withTransaction as withSchedulingTransaction,
  withSchedulingTenant,
  currentSchedulingTenant,
  closePool as closeSchedulingPool,
} from './db/pool.js';

export * as ordersRepo from './db/repositories/orders.js';
export * as orderItemsRepo from './db/repositories/orderItems.js';
export * as packagesRepo from './db/repositories/packages.js';
export * as shipmentsRepo from './db/repositories/shipments.js';
export * as marketplacesRepo from './db/repositories/marketplaces.js';
export * as marketplaceAccountsRepo from './db/repositories/marketplaceAccounts.js';
export * as marketplaceAccountCredentialsRepo from './db/repositories/marketplaceAccountCredentials.js';
export * as marketplaceAccountSyncStateRepo from './db/repositories/marketplaceAccountSyncState.js';
export * as auditRepo from './db/repositories/audit.js';

export * as schedulingService from './services/schedulingService.js';
export * as orderSyncService from './services/orderSyncService.js';
export * as marketplaceConnectionService from './services/marketplaceConnectionService.js';

export { reconcileAccounts, reconcileTenantAccounts } from './jobs/reconcileAccounts.js';

export { encryptJson, decryptJson } from './lib/crypto.js';
export { getAdapter, getCapabilities, listRegisteredCodes } from './integrations/marketplace/registry.js';
export { marketplaceInfo, MARKETPLACES as AMAZON_MARKETPLACES } from './integrations/amazon/endpoints.js';
export {
  AppError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  InvalidStateError,
  NotImplementedError,
  CryptoError,
} from './lib/errors.js';
