// Login with Amazon: refresh-token → access-token exchange, plus the
// authorization-code → refresh-token exchange used once at connect time.
// Access tokens are cached in memory (well under their real ~1h lifetime)
// and single-flighted so concurrent calls for the same account never fire
// two refreshes at once.
import axios from 'axios';
import crypto from 'node:crypto';
import { config } from '../../../config.js';
import { childLogger } from '../../../lib/logger.js';
import { SpApiAuthError } from '../errors.js';

const log = childLogger('amazon:lwa');
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

// Cache well under Amazon's real token lifetime (~3600s) so a call never
// races an expiry mid-flight.
const ACCESS_TOKEN_TTL_MS = 55 * 60 * 1000;

const accessTokenCache = new Map(); // cacheKey -> { accessToken, expiresAt }
const inFlight = new Map(); // cacheKey -> Promise<string> (single-flight)

function cacheKeyFor(refreshToken) {
  // Never log or key by the raw token — hash it.
  return crypto.createHash('sha256').update(refreshToken).digest('hex');
}

async function requestToken(body) {
  try {
    const { data } = await axios.post(LWA_TOKEN_URL, new URLSearchParams(body).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15_000,
    });
    return data;
  } catch (error) {
    const status = error.response?.status;
    const amazonError = error.response?.data?.error_description || error.response?.data?.error;
    // Never include the request body (it carries the refresh token / auth code).
    throw new SpApiAuthError(`LWA token request failed${status ? ` (${status})` : ''}: ${amazonError ?? error.message}`, {
      cause: error,
    });
  }
}

/** One-time exchange of the `spapi_oauth_code` from the OAuth callback. */
export async function exchangeAuthorizationCode(code) {
  const data = await requestToken({
    grant_type: 'authorization_code',
    code,
    client_id: config.spapi.clientId,
    client_secret: config.spapi.clientSecret,
  });
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

/** Cached, single-flighted refresh-token → access-token exchange. */
export async function getAccessToken(refreshToken) {
  const key = cacheKeyFor(refreshToken);
  const cached = accessTokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const data = await requestToken({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.spapi.clientId,
        client_secret: config.spapi.clientSecret,
      });
      accessTokenCache.set(key, { accessToken: data.access_token, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
      return data.access_token;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/**
 * Grantless token for the Notifications API destination (SQS subscription
 * management) — no seller refresh token involved, scoped to our own app.
 */
const grantlessCache = new Map(); // scope -> { accessToken, expiresAt }
export async function getGrantlessToken(scope) {
  const cached = grantlessCache.get(scope);
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  const data = await requestToken({
    grant_type: 'client_credentials',
    scope,
    client_id: config.spapi.clientId,
    client_secret: config.spapi.clientSecret,
  });
  grantlessCache.set(scope, { accessToken: data.access_token, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
  return data.access_token;
}

/** Test/internal use only — clears caches between test runs. */
export function _resetCaches() {
  accessTokenCache.clear();
  inFlight.clear();
  grantlessCache.clear();
}
