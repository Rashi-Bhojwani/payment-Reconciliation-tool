// Generic per-key circuit breaker: in-memory, three states (CLOSED → OPEN →
// HALF_OPEN → CLOSED), keyed by whatever string the caller chooses (an
// adapter keys it per marketplace account, so one seller's outage never
// throttles another's calls).
//
// Deliberately in-memory, not persisted, matching the rate limiter — a
// process restart just starts CLOSED again, which is the safe default.
import { CircuitOpenError } from './errors.js';
import { childLogger } from './logger.js';

const log = childLogger('circuit-breaker');

const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class Circuit {
  constructor({ failureThreshold, openDurationMs }) {
    this.failureThreshold = failureThreshold;
    this.openDurationMs = openDurationMs;
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.openedAt = null;
  }

  canAttempt() {
    if (this.state === STATE.CLOSED) return true;
    if (this.state === STATE.OPEN) {
      if (Date.now() - this.openedAt >= this.openDurationMs) {
        this.state = STATE.HALF_OPEN;
        return true;
      }
      return false;
    }
    return true; // HALF_OPEN: allow exactly one probing attempt through
  }

  retryAfterMs() {
    if (this.state !== STATE.OPEN) return 0;
    return Math.max(0, this.openDurationMs - (Date.now() - this.openedAt));
  }

  onSuccess() {
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.openedAt = null;
  }

  onFailure() {
    this.failureCount += 1;
    if (this.state === STATE.HALF_OPEN || this.failureCount >= this.failureThreshold) {
      this.state = STATE.OPEN;
      this.openedAt = Date.now();
    }
  }
}

export class CircuitBreaker {
  #circuits = new Map();
  #failureThreshold;
  #openDurationMs;

  constructor({ failureThreshold = 5, openDurationMs = 60_000 } = {}) {
    this.#failureThreshold = failureThreshold;
    this.#openDurationMs = openDurationMs;
  }

  #circuitFor(key) {
    let circuit = this.#circuits.get(key);
    if (!circuit) {
      circuit = new Circuit({ failureThreshold: this.#failureThreshold, openDurationMs: this.#openDurationMs });
      this.#circuits.set(key, circuit);
    }
    return circuit;
  }

  /** Runs `fn()` if the circuit for `key` allows it; throws CircuitOpenError otherwise. */
  async execute(key, fn) {
    const circuit = this.#circuitFor(key);
    if (!circuit.canAttempt()) {
      throw new CircuitOpenError(`Circuit open for ${key}`, { retryAfterMs: circuit.retryAfterMs() });
    }
    try {
      const result = await fn();
      circuit.onSuccess();
      return result;
    } catch (error) {
      circuit.onFailure();
      if (circuit.state === STATE.OPEN) {
        log.warn({ key, failureCount: circuit.failureCount }, 'circuit opened');
      }
      throw error;
    }
  }

  getState(key) {
    return this.#circuits.get(key)?.state ?? STATE.CLOSED;
  }

  reset(key) {
    this.#circuits.delete(key);
  }
}
