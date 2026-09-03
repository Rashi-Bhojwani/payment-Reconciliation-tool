// The unattended half of order scheduling.
//
// In the standalone tool this was a pg-boss worker in a second process. That
// process is gone: this platform already runs a node-cron scheduler in the API
// process for the nightly reconciliation sync, and adding a job queue, a
// second dyno and a second set of failure modes to run one sweep an hour
// would be a lot of moving parts for something a cron line does.
//
// The sweep exists because a marketplace notification can be missed - a
// dropped webhook, a restart during a deploy, an account whose circuit
// breaker was open when the notification arrived. Pulling everything updated
// since each account's last successful cursor makes those recoverable without
// anyone noticing they happened.
import cron from 'node-cron';
import { pool } from '@recon/db';
import { reconcileTenantAccounts } from '@recon/order-scheduler';
import { ensureAmazonSchedulingAccount } from './scheduling-link.js';

// Hourly, at :20. Deliberately not on the hour: the reconciliation nightly
// job runs at 02:00 and there is no reason for both to hit Amazon in the same
// minute. Order sync is incremental (it asks only for orders updated since
// the last cursor), so hourly is cheap - it is a handful of calls per
// connected account, not a re-fetch.
const SCHEDULE = '20 * * * *';

/**
 * One sweep over every active tenant.
 *
 * Tenants come from `public.tenants`, which is the only table that can answer
 * "who is there" - scheduling's own tables are all behind row-level security
 * and would report an empty database to an unbound query. Each tenant is then
 * handled inside its own scope; see reconcileAccounts.js.
 */
export async function runSchedulingSweep({ log = console } = {}) {
  const { rows } = await pool.query("select id from tenants where status = 'active'");
  const summary = { tenants: 0, accounts: 0, failures: 0 };

  for (const { id: tenantId } of rows) {
    try {
      // Picks up a re-authorization since the last sweep: a tenant who
      // reconnected Amazon has a new refresh token on the reconciliation
      // side, and this is what copies it across before the sync tries to use
      // the old one.
      const link = await ensureAmazonSchedulingAccount(tenantId);
      if (!link.linked) continue;

      summary.tenants += 1;
      const results = await reconcileTenantAccounts(tenantId);
      summary.accounts += results.length;
      summary.failures += results.filter(r => !r.ok).length;
    } catch (error) {
      // One tenant's failure must never stop the sweep, and must never
      // surface as an unhandled rejection that could take the cron - and with
      // it the API process - down.
      summary.failures += 1;
      log.error?.(`Scheduling sweep failed for tenant ${tenantId}:`, error instanceof Error ? error.message : error);
    }
  }

  return summary;
}

/**
 * Returns the scheduled task so a caller can stop it. Without that handle the
 * cron timer keeps the event loop alive forever - right for a server, wrong
 * for anything that boots the server and then wants to exit.
 */
export function startSchedulingScheduler({ log = console } = {}) {
  return cron.schedule(SCHEDULE, () => {
    runSchedulingSweep({ log }).catch(error =>
      log.error?.('Scheduling sweep run failed:', error instanceof Error ? error.message : error),
    );
  });
}
