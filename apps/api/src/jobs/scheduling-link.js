// Makes a tenant's EXISTING Amazon connection serve the order scheduler, so
// nobody has to authorize Amazon twice.
//
// The standalone scheduling tool ran its own OAuth flow: a seller clicked
// "Connect Amazon" there and granted consent to the same SP-API application
// they had already granted consent to here. That is a second consent screen,
// a second refresh token, and a second thing to re-authorize every time a
// role changes - for the same application, the same seller, and the same
// marketplace. There is no reason for it to exist.
//
// So the connection flows one way: reconciliation owns the authorization (it
// is the side that already has the OAuth callback, the backfill, and the
// re-authorize button), and this module mirrors the resulting refresh token
// into scheduling.marketplace_account_credentials whenever it changes. A
// seller who re-authorizes to pick up the Tax Invoicing role gets a new
// refresh token, and the scheduler starts using it on the next request
// without anyone touching the scheduling side at all.
//
// Deliberately NOT the other direction, and not a shared row: the two sides
// encrypt differently (reconciliation stores one AES-GCM string, scheduling
// stores ciphertext/iv/tag in separate bytea columns with a key_version for
// rotation), and collapsing them would mean rewriting one side's storage
// format for no gain beyond removing this file.
import crypto from 'node:crypto';
import { withTenant } from '@recon/db';
import {
  encryptJson,
  marketplaceAccountsRepo,
  marketplaceAccountCredentialsRepo,
  marketplaceAccountSyncStateRepo,
  marketplacesRepo,
  withSchedulingTenant,
} from '@recon/order-scheduler';
import { decryptSecret } from '../config/crypto.js';

const AMAZON = 'AMAZON';

/**
 * A stable, non-reversible marker for "which reconciliation token is this
 * scheduling account currently mirroring".
 *
 * It exists so the common case - a page load for a tenant whose connection
 * has not changed - does no cryptography and no write at all. Comparing the
 * stored marker against a fresh one answers "has the seller re-authorized
 * since we last copied their token?" without ever decrypting anything.
 *
 * It hashes reconciliation's CIPHERTEXT, never the refresh token itself.
 * Hashing the plaintext would put a stable fingerprint of a live credential
 * in a jsonb column that ordinary account queries select, which is precisely
 * the kind of thing that ends up in a log line. The ciphertext already
 * changes on every re-authorization (new token, new IV), so it answers the
 * question just as well.
 */
function connectionFingerprint(refreshTokenEncrypted) {
  return crypto.createHash('sha256').update(String(refreshTokenEncrypted)).digest('hex').slice(0, 32);
}

/** Reconciliation's Amazon connection for this tenant, or null if never connected. */
async function reconciliationSeller(tenantId) {
  const { rows } = await withTenant(tenantId, client =>
    client.query(
      `select amazon_seller_id, marketplace_id, refresh_token_encrypted, connected_at
         from sellers where tenant_id = $1 order by connected_at desc limit 1`,
      [tenantId],
    ),
  );
  return rows[0] ?? null;
}

/**
 * Ensures this tenant has an AUTHORIZED scheduling Amazon account carrying
 * the same refresh token reconciliation holds, and returns it.
 *
 * Returns `{ linked: false, reason }` rather than throwing when the tenant
 * has no Amazon connection yet - "you have not connected Amazon" is a normal
 * state for a new tenant and the UI needs to render it, not a 500.
 *
 * Safe to call on every scheduling request: when nothing has changed it is
 * one indexed SELECT and no write.
 */
export async function ensureAmazonSchedulingAccount(tenantId) {
  const seller = await reconciliationSeller(tenantId);
  if (!seller?.refresh_token_encrypted) {
    return { linked: false, reason: 'no-amazon-connection', account: null };
  }

  const fingerprint = connectionFingerprint(seller.refresh_token_encrypted);

  return withSchedulingTenant(tenantId, async () => {
    const marketplace = await marketplacesRepo.findByCode(AMAZON);
    if (!marketplace) {
      // Migration 025 seeds this row. Its absence means the migration has not
      // been applied, which is worth saying out loud rather than failing later
      // with a null dereference three calls deeper.
      throw Object.assign(
        new Error('The scheduling schema is not initialised (no AMAZON marketplace row). Run `npm run db:migrate`.'),
        { statusCode: 503 },
      );
    }

    let account = await marketplaceAccountsRepo.findBySellerAndMarketplace(tenantId, marketplace.id);
    if (!account) {
      account = await marketplaceAccountsRepo.create(tenantId, {
        marketplaceId: marketplace.id,
        region: regionForMarketplace(seller.marketplace_id),
        displayName: 'Amazon',
        metadata: {},
      });
    }

    const alreadyCurrent =
      account.status === 'AUTHORIZED' &&
      account.metadata?.reconciliationTokenFingerprint === fingerprint &&
      account.metadata?.amazonMarketplaceId === seller.marketplace_id;

    if (alreadyCurrent) return { linked: true, reason: 'already-current', account };

    // Only now is anything decrypted, and only into a local that goes out of
    // scope immediately.
    const refreshToken = decryptSecret(seller.refresh_token_encrypted);
    const encrypted = encryptJson({ refreshToken });
    await marketplaceAccountCredentialsRepo.upsert(account.id, {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      keyVersion: encrypted.keyVersion,
    });

    const linked = await marketplaceAccountsRepo.markAuthorized(tenantId, account.id, {
      externalAccountId: seller.amazon_seller_id,
      // markAuthorized merges with `metadata || $4`, so these three keys are
      // added without disturbing anything else already on the row.
      metadata: {
        amazonMarketplaceId: seller.marketplace_id,
        reconciliationTokenFingerprint: fingerprint,
        linkedFrom: 'reconciliation',
      },
    });
    await marketplaceAccountSyncStateRepo.ensure(account.id);

    return { linked: true, reason: account.status === 'AUTHORIZED' ? 'token-refreshed' : 'linked', account: linked };
  });
}

/**
 * SP-API region for an Amazon marketplace id. Amazon.in is what this platform
 * actually serves; the rest are here because `region` is a NOT NULL column and
 * a tenant on another marketplace should get the right host rather than a
 * plausible-looking wrong one.
 */
function regionForMarketplace(amazonMarketplaceId) {
  const regions = {
    A21TJRUUN4KGV: 'eu-west-1', // Amazon.in
    A1F83G8C2ARO7P: 'eu-west-1', // Amazon.co.uk
    A1PA6795UKMFR9: 'eu-west-1', // Amazon.de
    A2VIGQ35RCS4UG: 'eu-west-1', // Amazon.ae
    ATVPDKIKX0DER: 'us-east-1', // Amazon.com
  };
  return regions[amazonMarketplaceId] ?? 'eu-west-1';
}
