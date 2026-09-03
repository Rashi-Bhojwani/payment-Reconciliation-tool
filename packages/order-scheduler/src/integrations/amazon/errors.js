// Amazon-specific error taxonomy. Kept inside this integration (not
// src/lib/errors.js) because a future marketplace may have a different
// shape of throttle/auth/validation errors — only AmazonAdapter and its
// submodules should ever construct these.
import { AppError } from '../../lib/errors.js';

export class SpApiThrottleError extends AppError {
  constructor(message, { retryAfterMs } = {}) {
    super(message, { status: 503, code: 'SPAPI_THROTTLE', expose: false });
    this.retryable = true;
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

export class SpApiAuthError extends AppError {
  constructor(message, options = {}) {
    super(message, { status: 401, code: 'SPAPI_AUTH', expose: false, ...options });
    this.retryable = false;
  }
}

export class SpApiValidationError extends AppError {
  constructor(message, details) {
    super(message, { status: 502, code: 'SPAPI_VALIDATION', expose: false, details });
    this.retryable = false;
  }
}

/**
 * Amazon rejected the request itself — a 4xx other than 401/403 (auth) or
 * 429 (throttle): a bad MarketplaceId, malformed params, an unsupported
 * operation for this account, etc. Not transient (never retried), and not
 * this application's own caller's fault — whoever clicked "Force sync" sent
 * this app a perfectly fine request; it's this app's *call to Amazon* that
 * failed. status stays 502 (an upstream failure, not "your input to this
 * app was bad") rather than mirroring Amazon's raw 4xx, which would
 * misleadingly render as if the human's own request here were invalid.
 */
export class SpApiRequestError extends AppError {
  constructor(message, options = {}) {
    super(message, { status: 502, code: 'SPAPI_REQUEST', expose: false, ...options });
    this.retryable = false;
  }
}

export class SpApiServerError extends AppError {
  constructor(message, options = {}) {
    super(message, { status: 502, code: 'SPAPI_SERVER', expose: false, ...options });
    this.retryable = true;
  }
}
