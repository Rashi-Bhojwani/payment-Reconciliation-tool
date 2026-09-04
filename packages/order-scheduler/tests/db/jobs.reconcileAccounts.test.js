// The background reconciliation sweep. Proves it processes every authorized
// account and that one account's failure never stops the sweep from reaching
// the rest — the whole point of a safety-net job is that one seller's bad
// connection can't silently take every other seller down with it.
//
// The sweep's shape changed in the merge and the reason is worth stating: it
// used to be one pass over every account in the database. Under FORCE
// row-level security that query returns an EMPTY LIST on a connection with no
// tenant bound — not an error — so the old sweep would have reported a tidy
// "0 accounts, 0 failures" every night while syncing nothing at all. It takes
// tenant ids now and works one tenant at a time. The last test here is the
// one that would have caught that.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { resetDatabase, closeDatabase } from '../helpers/db.js';
import { createTenant, createMarketplaceAccount, asTenant } from '../helpers/fixtures.js';
import { encryptJson } from '../../src/lib/crypto.js';
import * as credentialsRepo from '../../src/db/repositories/marketplaceAccountCredentials.js';
import * as marketplaceAccountSyncStateRepo from '../../src/db/repositories/marketplaceAccountSyncState.js';
import { reconcileAccounts } from '../../src/jobs/reconcileAccounts.js';
import { _resetCaches } from '../../src/integrations/amazon/auth/lwa.js';

test.before(resetDatabase);
test.after(closeDatabase);
test.beforeEach(() => _resetCaches());

async function buildAuthorizedAccount(tag) {
  const seller = await createTenant(`reconcile-${tag}`);
  const account = await createMarketplaceAccount(seller.id, { externalAccountId: `EXT-RC-${tag}` });
  const encrypted = encryptJson({ refreshToken: `refresh-${tag}` });
  await asTenant(seller.id, async () => {
    await credentialsRepo.upsert(account.id, {
      ciphertext: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion,
    });
  });
  return { seller, account };
}

test('reconciles every authorized account and records success', async (t) => {
  const a = await buildAuthorizedAccount('a');
  const b = await buildAuthorizedAccount('b');

  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => ({
    status: 200, headers: {}, data: { orders: [], pagination: {} },
  }));

  const results = await reconcileAccounts([a.seller.id, b.seller.id]);
  const resultA = results.find((r) => r.marketplaceAccountId === a.account.id);
  const resultB = results.find((r) => r.marketplaceAccountId === b.account.id);
  assert.equal(resultA.ok, true, JSON.stringify(results));
  assert.equal(resultB.ok, true, JSON.stringify(results));

  const syncStateA = await asTenant(a.seller.id, () => marketplaceAccountSyncStateRepo.get(a.account.id));
  assert.ok(syncStateA.last_synced_at, 'a successful sweep must record last_synced_at');
});

test('a failing account does not stop the sweep from reaching the rest', async (t) => {
  const broken = await buildAuthorizedAccount('broken');
  const healthy = await buildAuthorizedAccount('healthy');

  // The broken account's refresh token fails LWA's own exchange (simulating a
  // revoked/invalid credential — LWA returns 400 invalid_grant, which axios's
  // default behaviour surfaces as a rejected promise); the healthy account's
  // token exchange succeeds.
  t.mock.method(axios, 'post', async (url, body) => {
    const params = new URLSearchParams(body);
    if (params.get('refresh_token') === 'refresh-broken') {
      const error = new Error('Request failed with status code 400');
      error.response = { status: 400, data: { error: 'invalid_grant', error_description: 'Refresh token revoked' } };
      throw error;
    }
    return { data: { access_token: 'tok', expires_in: 3600 } };
  });
  t.mock.method(axios, 'request', async () => ({
    status: 200, headers: {}, data: { orders: [], pagination: {} },
  }));

  const results = await reconcileAccounts([broken.seller.id, healthy.seller.id]);
  const resultBroken = results.find((r) => r.marketplaceAccountId === broken.account.id);
  const resultHealthy = results.find((r) => r.marketplaceAccountId === healthy.account.id);

  assert.equal(resultBroken.ok, false);
  assert.equal(resultHealthy.ok, true, 'the healthy account must still sync despite the broken one failing');

  const syncStateHealthy = await asTenant(healthy.seller.id, () => marketplaceAccountSyncStateRepo.get(healthy.account.id));
  assert.ok(syncStateHealthy.last_synced_at);
});

test('the sweep only ever touches the tenants it was given', async (t) => {
  const included = await buildAuthorizedAccount('included');
  const excluded = await buildAuthorizedAccount('excluded');

  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => ({ status: 200, headers: {}, data: { orders: [], pagination: {} } }));

  const results = await reconcileAccounts([included.seller.id]);
  assert.equal(results.length, 1, 'a tenant not in the list must not be swept');
  assert.equal(results[0].marketplaceAccountId, included.account.id);

  const untouched = await asTenant(excluded.seller.id, () => marketplaceAccountSyncStateRepo.get(excluded.account.id));
  assert.equal(untouched?.last_synced_at ?? null, null, 'the excluded tenant\'s account must not have been synced');
});

test('an empty tenant list is a no-op, not a silent sweep of everything', async (t) => {
  // The failure mode this rules out is the one the merge introduced: if the
  // sweep ever went back to "select every account", it would find these two
  // and this would come back non-empty.
  await buildAuthorizedAccount('empty-a');
  await buildAuthorizedAccount('empty-b');
  t.mock.method(axios, 'request', async () => { throw new Error('the sweep must not reach the network with no tenants'); });

  const results = await reconcileAccounts([]);
  assert.deepEqual(results, []);
});
