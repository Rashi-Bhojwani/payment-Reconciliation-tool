// The generic connection flow described in APP_ARCHITECTURE.md §8: create a
// pending account, build a consent URL through whichever adapter the
// registry hands back, and complete the callback the same way regardless of
// marketplace. This is the ONLY place that orchestrates
// marketplace_connection_requests + marketplace_accounts +
// marketplace_account_credentials together — routes call this, never the
// repositories directly for this flow.
import { withTransaction } from '../db/pool.js';
import { getAdapter } from '../integrations/marketplace/registry.js';
import { encryptJson, decryptJson } from '../lib/crypto.js';
import { InvalidStateError, NotFoundError } from '../lib/errors.js';
import { childLogger } from '../lib/logger.js';
import * as marketplacesRepo from '../db/repositories/marketplaces.js';
import * as marketplaceAccountsRepo from '../db/repositories/marketplaceAccounts.js';
import * as credentialsRepo from '../db/repositories/marketplaceAccountCredentials.js';
import * as connectionRequestsRepo from '../db/repositories/marketplaceConnectionRequests.js';
import * as syncStateRepo from '../db/repositories/marketplaceAccountSyncState.js';

const log = childLogger('marketplace-connection');

/**
 * Start connecting a seller to a marketplace: creates (or reuses) a PENDING
 * marketplace_accounts row, asks the adapter for a consent URL, and stores
 * the single-use state token. Re-authorising an already-connected account
 * reuses its existing row rather than creating a duplicate.
 */
export async function startConnection(sellerId, marketplaceCode, { region }) {
  const marketplace = await marketplacesRepo.findByCode(marketplaceCode);
  if (!marketplace) throw new NotFoundError(`Unknown marketplace "${marketplaceCode}"`);

  const adapter = getAdapter(marketplaceCode);

  return withTransaction(async (client) => {
    let account = await marketplaceAccountsRepo.findBySellerAndMarketplace(sellerId, marketplace.id, client);
    if (!account) {
      account = await marketplaceAccountsRepo.create(sellerId, { marketplaceId: marketplace.id, region }, client);
    }

    // No redirectUri passed here: each adapter's own registered OAuth
    // callback path is that integration's own concern (it's what's on file
    // with the marketplace, sometimes overridden per-deployment — see
    // config.spapi.callbackPath), not something this generic service should
    // guess a pattern for on every adapter's behalf.
    const { url, stateToken, expiresAt } = await adapter.authorize(account, {});

    await connectionRequestsRepo.create(
      sellerId,
      { marketplaceId: marketplace.id, marketplaceAccountId: account.id, stateToken, expiresAt },
      client,
    );

    log.info({ sellerId, marketplaceCode, marketplaceAccountId: account.id }, 'started marketplace connection');
    return { account, url, expiresAt };
  });
}

/**
 * Complete a connection: consume the state token (single-use, atomic),
 * let the adapter exchange whatever code it received for credentials,
 * encrypt and store them, mark the account AUTHORIZED.
 *
 * `request` is passed straight through to the adapter — only the adapter
 * knows the shape of its own callback payload.
 */
export async function completeConnection(marketplaceCode, request) {
  const adapter = getAdapter(marketplaceCode);
  const { stateToken, externalAccountId, credentials, metadata } = await adapter.handleCallback(request);

  return withTransaction(async (client) => {
    const consumed = await connectionRequestsRepo.consume(stateToken, client);
    if (!consumed) {
      throw new InvalidStateError('This authorisation link has already been used or has expired');
    }
    if (!consumed.marketplace_account_id) {
      throw new InvalidStateError('No pending marketplace account for this authorisation request');
    }

    const encrypted = encryptJson(credentials);
    await credentialsRepo.upsert(
      consumed.marketplace_account_id,
      { ciphertext: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion },
      client,
    );

    const account = await marketplaceAccountsRepo.markAuthorized(
      consumed.seller_id,
      consumed.marketplace_account_id,
      { externalAccountId, metadata },
      client,
    );
    await syncStateRepo.ensure(consumed.marketplace_account_id, client);

    log.info(
      { sellerId: consumed.seller_id, marketplaceAccountId: consumed.marketplace_account_id, marketplaceCode },
      'marketplace account authorised',
    );
    return account;
  });
}

/** Decrypts an account's credentials and returns a fresh object shaped for an adapter call. */
export async function loadAdapterAccount(marketplaceAccount, marketplaceCode) {
  const secrets = await credentialsRepo.findSecretsByAccount(marketplaceAccount.id);
  if (!secrets) throw new InvalidStateError(`No credentials stored for account ${marketplaceAccount.id}`);
  const credentials = decryptJson({
    ciphertext: secrets.ciphertext, iv: secrets.iv, authTag: secrets.auth_tag, keyVersion: secrets.key_version,
  });
  return { ...marketplaceAccount, credentials };
}

/** A 401 from the marketplace means it pulled our access — halt this account's jobs. */
export async function markRevoked(marketplaceAccountId, reason) {
  await marketplaceAccountsRepo.markRevoked(marketplaceAccountId);
  await credentialsRepo.markError(marketplaceAccountId, reason);
  log.warn({ marketplaceAccountId, reason }, 'marketplace account revoked');
}
