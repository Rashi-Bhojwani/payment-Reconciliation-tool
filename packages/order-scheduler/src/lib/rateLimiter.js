// Generic in-memory token bucket, keyed by whatever string the caller
// chooses (an adapter keys it `${marketplaceAccountId}:${operation}`, so
// each seller's Amazon rate limit is tracked independently of every other
// seller's, and independently of each other Amazon API operation).
//
// Marketplace-agnostic on purpose: the documented numbers for a specific
// operation (Amazon's searchOrders 0.0056 req/sec, burst 20) are seeded by
// the caller, not hard-coded here. A different marketplace with different
// limits reuses this same bucket implementation.
class TokenBucket {
  constructor({ ratePerSecond, burst }) {
    this.ratePerSecond = ratePerSecond;
    this.capacity = burst;
    this.tokens = burst;
    this.lastRefillMs = Date.now();
  }

  #refill() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.lastRefillMs = now;
  }

  /** Milliseconds until at least one token is available, 0 if available now. */
  msUntilNextToken() {
    this.#refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000);
  }

  take() {
    this.#refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Adjust rate/burst at runtime — e.g. from Amazon's x-amzn-RateLimit-Limit header. */
  updateRate({ ratePerSecond, burst }) {
    this.#refill();
    if (typeof ratePerSecond === 'number' && ratePerSecond > 0) this.ratePerSecond = ratePerSecond;
    if (typeof burst === 'number' && burst > 0) {
      this.capacity = burst;
      this.tokens = Math.min(this.tokens, burst);
    }
  }
}

export class RateLimiter {
  #buckets = new Map();
  #defaults;

  /** @param {Record<string, {ratePerSecond: number, burst: number}>} defaults - seeded per operation key */
  constructor(defaults = {}) {
    this.#defaults = defaults;
  }

  #bucketFor(key, operation) {
    const bucketKey = `${key}:${operation}`;
    let bucket = this.#buckets.get(bucketKey);
    if (!bucket) {
      const seed = this.#defaults[operation] ?? { ratePerSecond: 1, burst: 1 };
      bucket = new TokenBucket(seed);
      this.#buckets.set(bucketKey, bucket);
    }
    return bucket;
  }

  /**
   * Waits (if necessary) then runs `fn()` under one token for `key:operation`.
   * This is the serialisation point: concurrent callers for the same key
   * queue behind each other rather than bursting past the limit.
   */
  async schedule(key, operation, fn) {
    const bucket = this.#bucketFor(key, operation);
    // Loop rather than a single wait: a token can be taken by a concurrent
    // caller between the wait and the take, so re-check.
    for (;;) {
      if (bucket.take()) return fn();
      await sleep(bucket.msUntilNextToken());
    }
  }

  /** Called after a response carries Amazon's (or another marketplace's) live rate headers. */
  updateRate(key, operation, rate) {
    this.#bucketFor(key, operation).updateRate(rate);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
