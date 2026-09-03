// The reconciliation safety net: for every AUTHORIZED marketplace account,
// pull orders updated since the last successful sync. This is what worker.js
// runs on a schedule; it exists as its own module (not inline in the pg-boss
// handler) so it's testable without pg-boss in the loop.
import * as marketplaceAccountsRepo from '../db/repositories/marketplaceAccounts.js';
import * as marketplaceAccountSyncStateRepo from '../db/repositories/marketplaceAccountSyncState.js';
import * as orderSyncService from '../services/orderSyncService.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('reconcile-accounts');

/**
 * Syncs every authorized account, one at a time. A failure on one account is
 * logged and does not stop the sweep — one seller's throttled or revoked
 * connection must never block every other seller's sync.
 */
export async function reconcileAccounts() {
  const accounts = await marketplaceAccountsRepo.listAllAuthorized();
  const results = [];

  for (const account of accounts) {
    try {
      const syncState = await marketplaceAccountSyncStateRepo.get(account.id);
      const since = syncState?.last_synced_at ? new Date(syncState.last_synced_at) : undefined;
      const outcome = await orderSyncService.syncAccount(account.seller_id, account, account.marketplace_code, { since });
      results.push({ marketplaceAccountId: account.id, ok: true, synced: outcome.synced });
    } catch (error) {
      log.error(
        { err: error, marketplaceAccountId: account.id, sellerId: account.seller_id },
        'reconciliation failed for one account',
      );
      results.push({ marketplaceAccountId: account.id, ok: false, reason: error.message });
    }
  }

  log.info(
    { accounts: accounts.length, succeeded: results.filter((r) => r.ok).length },
    'reconciliation sweep complete',
  );
  return results;
}
