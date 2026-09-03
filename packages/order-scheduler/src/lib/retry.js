// Generic exponential backoff with full jitter. Marketplace-agnostic —
// every adapter's HTTP layer wraps its calls with this rather than each
// reimplementing its own backoff math.
import { childLogger } from './logger.js';

const log = childLogger('retry');

/**
 * @param {() => Promise<T>} fn
 * @param {object} options
 * @param {number} [options.maxAttempts=5]
 * @param {number} [options.baseDelayMs=500]
 * @param {number} [options.maxDelayMs=30000]
 * @param {(error: unknown) => boolean} [options.isRetryable] - default: error.retryable === true
 * @param {(error: unknown) => number|null} [options.retryAfterMs] - honour a server-specified delay (e.g. Retry-After)
 * @param {string} [options.label] - for logging
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const {
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    isRetryable = (error) => Boolean(error?.retryable),
    retryAfterMs = () => null,
    label = 'operation',
  } = options;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt || !isRetryable(error)) throw error;

      const serverDelay = retryAfterMs(error);
      const delay = serverDelay ?? fullJitterBackoff(attempt, baseDelayMs, maxDelayMs);
      log.warn(
        { label, attempt, maxAttempts, delayMs: delay, err: { message: error?.message, code: error?.code } },
        'retrying after failure',
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Full jitter: a random delay between 0 and the exponential cap — avoids a retry storm. */
export function fullJitterBackoff(attempt, baseDelayMs, maxDelayMs) {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * cap);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
