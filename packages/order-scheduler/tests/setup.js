// Loaded via `node --test --import ./packages/order-scheduler/tests/setup.js`,
// so these are set before any src/ module - and therefore src/config.js -
// is imported.
//
// The standalone tool's version of this file also pointed DATABASE_URL at a
// throwaway database, because most of its suite talked to Postgres. The tests
// kept here are the ones that don't: pure logic, with the network stubbed.
// They need exactly two things from the environment.
//
// LOG_LEVEL, because lib/logger.js is a real pino instance writing to stdout
// and an unsilenced debug stream drowns the TAP output.
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'silent';
// A fixed 32-byte key so crypto round-trips are reproducible, and so a
// developer with a real ENCRYPTION_KEY exported in their shell doesn't run
// these against their production key.
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.ENCRYPTION_KEY_VERSION = '1';

// NODE_ENV is deliberately NOT set to 'test'. config.js reads it only to pick
// a default log level and to set isProduction, both of which are already
// pinned above, and apps/api/src/config/secrets.js (which config.js imports)
// runs dotenv - leaving NODE_ENV alone keeps that behaviour identical to a
// normal `npm run check`.
