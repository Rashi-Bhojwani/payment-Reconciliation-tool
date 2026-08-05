import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Amazon's redirect after a seller grants permission is a plain top-level
// browser navigation, so whatever this endpoint answers with IS what the
// seller sees. Two ways it used to fail them:
//
//   1. It was registered for POST only. Amazon sends a GET, which reached the
//      handler solely because the not-found handler forwarded it. The single
//      most important request in the product depended on a 404 path.
//   2. Anything that threw after the state check - an unreachable database, a
//      missing tenant - escaped to the JSON error handler, so the seller was
//      left staring at a blank page with a JSON blob and no way back.
//
// The server boots for real here because both failures were in the wiring, not
// in a function: a unit test of the handler would have passed while the route
// was still POST-only.
//
// These assignments are deliberately at module scope, and this file
// deliberately has no static import of @recon/db or ./server.js. ESM hoists
// static imports above all module code, so importing either one at the top
// would build the connection pool from the developer's real .env - and this
// test boots a server that runs schema checks and seeds an admin row. Pointing
// DATABASE_URL at a closed port first means the worst case is a refused
// connection, which is exactly the failure this test wants to provoke anyway.
const jwtSecret = 'oauth-callback-test-secret-value-0123456789';
const frontend = 'http://frontend.test';
process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/none';
process.env.JWT_SECRET = jwtSecret;
process.env.FRONTEND_ORIGIN = frontend;
process.env.SP_API_REDIRECT_URI = 'https://api.test/oauth/callback';
process.env.PORT = '0';
// Fail fast instead of queueing: the point is that the request always answers.
process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS = '1000';

let base = '';
let server;

test.before(async () => {
  assert.match(process.env.DATABASE_URL, /127\.0\.0\.1:1/, 'refusing to run against a real database');
  server = await import('./server.js');
  const address = server.app.server.address();
  base = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  // The nightly cron timer and the listening socket would otherwise keep this
  // process alive long after the assertions are done.
  server?.scheduler?.stop?.();
  await server?.app?.close?.();
});

const signState = tenantId => {
  const body = Buffer.from(JSON.stringify({ tenantId, userId: tenantId, nonce: 'n', createdAt: Date.now() })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', jwtSecret).update(body).digest('base64url')}`;
};
const call = (method, path, body) => fetch(`${base}${path}`, {
  method,
  redirect: 'manual',
  ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
});

test('Amazon\'s GET redirect reaches the callback on both registered URLs', async () => {
  for (const path of ['/oauth/callback', '/api/auth/amazon/callback']) {
    const res = await call('GET', `${path}?state=not-a-real-state&spapi_oauth_code=abc`);
    assert.equal(res.status, 302, `${path} must redirect the browser, not render an error`);
    assert.match(res.headers.get('location'), new RegExp(`^${frontend}/login\\?amazon=error`), 'an unusable state sends the seller to log in again');
  }
});

test('the POST form of the callback still works', async () => {
  const res = await call('POST', '/oauth/callback', { state: 'not-a-real-state' });
  assert.equal(res.status, 302);
});

test('a failure after the state check still lands the seller on their dashboard', async () => {
  // Valid state, unreachable database: this is the shape of every "the tab just
  // kept spinning" report. It must answer, quickly, with a redirect that names
  // the reason instead of throwing into the JSON error handler.
  const tenantId = '11111111-2222-3333-4444-555555555555';
  const started = Date.now();
  const res = await call('GET', `/oauth/callback?state=${signState(tenantId)}&spapi_oauth_code=abc&selling_partner_id=A1TEST`);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin + location.pathname, `${frontend}/seller`);
  assert.equal(location.searchParams.get('tenantId'), tenantId);
  assert.equal(location.searchParams.get('amazon'), 'error');
  assert.ok(location.searchParams.get('message'), 'the seller is told what went wrong');
  assert.ok(Date.now() - started < 10_000, 'it answers rather than hanging');
});

test('an unrelated missing route is still a plain 404', async () => {
  const res = await call('GET', '/definitely-not-a-route');
  assert.equal(res.status, 404);
});
