// The reconciliation safety net: for every AUTHORIZED marketplace account,
// pull orders updated since the last successful sync. This is what the
// platform's nightly cron runs; it exists as its own module (not inline in
// the scheduler) so it's testable without a cron in the loop.
//
// The standalone tool did this in one pass over every account in the
// database. It cannot anymore, and the reason is worth stating plainly:
// scheduling.marketplace_accounts is behind FORCE row-level security now, so
// "select every account" on a connection with no tenant bound returns an
// empty list — not an error, an empty list — and the sweep would report a
// tidy "0 accounts, 0 failures" every night while syncing nothing at all.
// So the sweep is per-tenant by construction: the caller supplies the tenant
// ids, and each tenant's accounts are read and synced inside that tenant's
// own scope.
import { withSchedulingTenant } from '../db/pool.js';
import * as marketplaceAccountsRepo from '../db/repositories/marketplaceAccounts.js';
import * as marketplaceAccountSyncStateRepo from '../db/repositories/marketplaceAccountSyncState.js';
import * as orderSyncService from '../services/orderSyncService.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('reconcile-accounts');

/**
 * Syncs every authorized account for one tenant, one at a time. A failure on
 * one account is logged and does not stop the rest — one revoked or throttled
 * connection must never block the tenant's other accounts.
 */
export async function reconcileTenantAccounts(tenantId) {
  const accounts = await withSchedulingTenant(tenantId, () =>
    marketplaceAccountsRepo.listAuthorizedBySeller(tenantId),
  );
  const results = [];

  for (const account of accounts) {
    try {
      // One scope per account rather than one around the whole loop: a sync
      // holds its connection for as long as it runs (minutes, on a large
      // account), and a tenant with several accounts would otherwise hold one
      // connection for the sum of all of them.
      const outcome = await withSchedulingTenant(tenantId, async () => {
        const syncState = await marketplaceAccountSyncStateRepo.get(account.id);
        const since = syncState?.last_synced_at ? new Date(syncState.last_synced_at) : undefined;
        return orderSyncService.syncAccount(tenantId, account, account.marketplace_code, { since });
      });
      results.push({ marketplaceAccountId: account.id, ok: true, synced: outcome.synced });
    } catch (error) {
      log.error(
        { err: error, marketplaceAccountId: account.id, sellerId: tenantId },
        'reconciliation failed for one account',
      );
      results.push({ marketplaceAccountId: account.id, ok: false, reason: error.message });
    }
  }

  return results;
}

/**
 * Sweeps a list of tenants. `tenantIds` comes from the platform (active
 * tenants), because `public.tenants` is the one table that legitimately
 * answers "who is there" and this package has no business reading it itself.
 */
export async function reconcileAccounts(tenantIds = []) {
  const results = [];
  for (const tenantId of tenantIds) {
    try {
      results.push(...(await reconcileTenantAccounts(tenantId)));
    } catch (error) {
      log.error({ err: error, sellerId: tenantId }, 'reconciliation failed for one tenant');
      results.push({ sellerId: tenantId, ok: false, reason: error.message });
    }
  }

  log.info(
    { tenants: tenantIds.length, accounts: results.length, succeeded: results.filter((r) => r.ok).length },
    'reconciliation sweep complete',
  );
  return results;
}
