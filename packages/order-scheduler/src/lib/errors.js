// Typed errors. Never throw a bare string — the error handler and the job
// retry policies both branch on `error.code` / `instanceof`.
//
// `expose` marks an error whose message is safe to render to a browser.
// Anything else renders a generic message (rule: no secrets or PII in
// responses or error pages).

export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', expose = false, cause, details } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.expose = expose;
    if (details !== undefined) this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Bad user input on a form or query string. */
export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', expose: true, details });
  }
}

/** Not logged in. */
export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { status: 401, code: 'AUTHENTICATION_REQUIRED', expose: true });
  }
}

/**
 * Logged in but not permitted. Note: for seller-scoped resources we deliberately
 * throw NotFoundError instead (rule R1 — never leak that a seller exists).
 */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that') {
    super(message, { status: 403, code: 'FORBIDDEN', expose: true });
  }
}

/** Resource missing — also the deliberate answer to "seller you cannot access". */
export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, { status: 404, code: 'NOT_FOUND', expose: true });
  }
}

/** A write lost a race, or a unique constraint rejected a duplicate. */
export class ConflictError extends AppError {
  constructor(message, details) {
    super(message, { status: 409, code: 'CONFLICT', expose: true, details });
  }
}

/** The system refuses this transition (e.g. scheduling an unapproved package). */
export class InvalidStateError extends AppError {
  constructor(message, details) {
    super(message, { status: 422, code: 'INVALID_STATE', expose: true, details });
  }
}

/** Encrypt/decrypt failure, missing key, wrong key version. */
export class CryptoError extends AppError {
  constructor(message, options = {}) {
    super(message, { status: 500, code: 'CRYPTO_ERROR', expose: false, ...options });
  }
}

/** Rule R2: a PII-shaped key reached the AI boundary. Always a bug, never retried. */
export class PiiBoundaryError extends AppError {
  constructor(message, details) {
    super(message, { status: 500, code: 'PII_BOUNDARY_VIOLATION', expose: false, details });
  }
}

/** A downstream call opened the per-seller circuit breaker. */
export class CircuitOpenError extends AppError {
  constructor(message, { retryAfterMs } = {}) {
    super(message, { status: 503, code: 'CIRCUIT_OPEN', expose: false });
    this.retryAfterMs = retryAfterMs;
  }
}

/** A provider (fulfillment, AI) has no implementation for this mode yet. */
export class NotImplementedError extends AppError {
  constructor(message) {
    super(message, { status: 501, code: 'NOT_IMPLEMENTED', expose: true });
  }
}

/** True when a job should be retried rather than dead-lettered. */
export function isRetryable(error) {
  return Boolean(error?.retryable);
}
