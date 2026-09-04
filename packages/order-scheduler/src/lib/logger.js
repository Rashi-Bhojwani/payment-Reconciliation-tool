// pino with redaction configured up front. Nothing in this app should ever be
// able to log a refresh token, an access token, a session cookie, a password,
// or buyer PII — the redact paths below are the enforcement point.
import pino from 'pino';
import { config } from '../config.js';

// Wildcards cover the same field appearing at any nesting depth, which is what
// happens when an axios error serialises a whole request/response tree.
const redactPaths = [
  // --- credentials -------------------------------------------------------
  'password',
  '*.password',
  '*.password_hash',
  '*.passwordHash',
  'refresh_token',
  '*.refresh_token',
  '*.refreshToken',
  'access_token',
  '*.access_token',
  '*.accessToken',
  'client_secret',
  '*.client_secret',
  '*.clientSecret',
  'spapi_oauth_code',
  '*.spapi_oauth_code',
  'state_token',
  '*.stateToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-amz-access-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-amz-access-token"]',
  'config.headers.authorization',
  'config.headers["x-amz-access-token"]',
  'response.config.headers.authorization',
  'response.config.headers["x-amz-access-token"]',
  // --- buyer PII ---------------------------------------------------------
  'BuyerInfo',
  '*.BuyerInfo',
  'ShippingAddress',
  '*.ShippingAddress',
  'buyerName',
  '*.buyerName',
  'buyerEmail',
  '*.buyerEmail',
  'buyerPhone',
  '*.buyerPhone',
  'shippingAddress',
  '*.shippingAddress',
  'AddressLine1',
  '*.AddressLine1',
  'AddressLine2',
  '*.AddressLine2',
  'Phone',
  '*.Phone',
];

export const logger = pino({
  level: config.logLevel,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: 'order-scheduler', env: config.env },
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: config.isProduction
    ? undefined
    : { target: 'pino/file', options: { destination: 1 } }, // plain JSON to stdout, no extra dep
});

/** Child logger tagged with a subsystem name, e.g. childLogger('spapi:orders'). */
export function childLogger(component, bindings = {}) {
  return logger.child({ component, ...bindings });
}

export default logger;
