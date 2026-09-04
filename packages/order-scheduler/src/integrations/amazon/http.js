// The one place every SP-API call goes through: rate-limit gate → retry with
// exponential backoff + full jitter on 429/500/503 → per-account circuit
// breaker. Callers never call axios directly against SP-API.
import axios from 'axios';
import { RateLimiter } from '../../lib/rateLimiter.js';
import { CircuitBreaker } from '../../lib/circuitBreaker.js';
import { withRetry } from '../../lib/retry.js';
import { childLogger } from '../../lib/logger.js';
import { getAccessToken } from './auth/lwa.js';
import { SpApiThrottleError, SpApiAuthError, SpApiServerError, SpApiRequestError } from './errors.js';

const log = childLogger('amazon:http');

// Documented defaults (req/sec, burst). Seeded here, adjusted at runtime from
// the x-amzn-RateLimit-Limit response header.
const RATE_LIMIT_DEFAULTS = {
  searchOrders: { ratePerSecond: 0.0056, burst: 20 },
  getOrder: { ratePerSecond: 0.5, burst: 30 },
  getOrderItems: { ratePerSecond: 0.5, burst: 30 },
  easyShipListSlots: { ratePerSecond: 1, burst: 10 },
  easyShipSchedule: { ratePerSecond: 1, burst: 10 },
};

const rateLimiter = new RateLimiter(RATE_LIMIT_DEFAULTS);
const circuitBreaker = new CircuitBreaker({ failureThreshold: 5, openDurationMs: 60_000 });

/**
 * @param {object} params
 * @param {string} params.accountKey - typically marketplaceAccount.id; scopes rate limit + circuit breaker
 * @param {string} params.operation - one of the keys in RATE_LIMIT_DEFAULTS, used for logging + limiter bucket
 * @param {string} params.method
 * @param {string} params.url - full URL (host + path)
 * @param {string} params.refreshToken - decrypted seller refresh token
 * @param {object} [params.params] - query params
 * @param {object} [params.data] - request body
 */
export async function spApiRequest({ accountKey, operation, method, url, refreshToken, params, data }) {
  return circuitBreaker.execute(accountKey, () =>
    rateLimiter.schedule(accountKey, operation, () =>
      withRetry(
        async () => {
          const accessToken = await getAccessToken(refreshToken);
          try {
            const response = await axios.request({
              method,
              url,
              params,
              data,
              timeout: 20_000,
              headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
              validateStatus: () => true, // handle status codes ourselves below
            });

            applyRateLimitHeader(accountKey, operation, response.headers);

            if (response.status === 429) {
              throw new SpApiThrottleError('SP-API throttled the request', {
                retryAfterMs: retryAfterHeaderMs(response.headers),
              });
            }
            if (response.status === 401 || response.status === 403) {
              throw new SpApiAuthError(`SP-API rejected credentials (${response.status})`);
            }
            if (response.status >= 500) {
              throw new SpApiServerError(`SP-API server error (${response.status})`);
            }
            if (response.status >= 400) {
              // 4xx other than 401/403/429 — Amazon rejected the request
              // itself (bad MarketplaceId, malformed params, ...): not
              // transient, so never retried (SpApiRequestError sets
              // retryable: false), and reported as an upstream failure
              // (status 502) rather than mirroring Amazon's raw 4xx, which
              // would misleadingly render on this app's own error page as
              // if the human's request *to this app* were invalid. Amazon's
              // actual reason goes into the message (visible in the server
              // log — see errorHandler.js) since "SP-API request failed
              // (400)" alone gives nothing to act on.
              const detail = extractSpApiErrorDetail(response.data);
              throw new SpApiRequestError(
                `SP-API rejected the request (${response.status})${detail ? `: ${detail}` : ''}`,
                { details: { amazonStatus: response.status, responseBody: response.data } },
              );
            }
            return response.data;
          } catch (error) {
            if (error.retryable !== undefined) throw error; // already one of ours
            // Network-level failure (timeout, DNS, connection reset) — retryable.
            const err = new SpApiServerError(`SP-API request failed: ${error.message}`, { cause: error });
            throw err;
          }
        },
        {
          maxAttempts: 5,
          baseDelayMs: 500,
          maxDelayMs: 20_000,
          isRetryable: (error) => Boolean(error?.retryable),
          retryAfterMs: (error) => error?.retryAfterMs ?? null,
          label: `${operation} (${accountKey})`,
        },
      ),
    ),
  );
}

/**
 * SP-API's documented 4xx error shape is `{ errors: [{ code, message,
 * details }] }`. Best-effort: some endpoints or edge cases (a proxy's own
 * error page, an empty body) won't match it, so this never throws — it just
 * returns null when there's nothing usable to report.
 */
function extractSpApiErrorDetail(data) {
  const first = Array.isArray(data?.errors) ? data.errors[0] : undefined;
  if (!first) return null;
  const parts = [first.code, first.message].filter(Boolean);
  return parts.length ? parts.join(': ') : null;
}

function applyRateLimitHeader(accountKey, operation, headers) {
  const limitHeader = headers?.['x-amzn-ratelimit-limit'];
  if (!limitHeader) return;
  const ratePerSecond = Number.parseFloat(limitHeader);
  if (Number.isFinite(ratePerSecond) && ratePerSecond > 0) {
    rateLimiter.updateRate(accountKey, operation, { ratePerSecond });
    log.debug({ accountKey, operation, ratePerSecond }, 'adjusted rate limit from response header');
  }
}

function retryAfterHeaderMs(headers) {
  const value = headers?.['retry-after'];
  if (!value) return null;
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** Test/internal use only. */
export function _circuitBreakerFor(accountKey) {
  return circuitBreaker.getState(accountKey);
}
