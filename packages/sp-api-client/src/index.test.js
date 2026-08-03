import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReportRange, SpApiClient, throttleRetryDelayMs } from './index.js';

test('caps a future exclusive report end before the current time', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  assert.deepEqual(
    normalizeReportRange({ start: '2026-07-01T00:00:00.000Z', end: '2026-07-28T00:00:00.000Z' }, now),
    { start: '2026-07-01T00:00:00.000Z', end: '2026-07-27T11:58:00.000Z' }
  );
});

test('preserves an already historical report range', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  const range = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };
  assert.deepEqual(normalizeReportRange(range, now), range);
});

test('rejects a range with no data available before the safe boundary', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  assert.throws(
    () => normalizeReportRange({ start: '2026-07-27T12:00:00.000Z', end: '2026-07-28T00:00:00.000Z' }, now),
    /must start before Amazon's latest available data time/
  );
});

test('a throttled report-document download waits for Amazon\'s own window to reopen', () => {
  // The live failure: six retries inside a bucket that opens once per 45s.
  const documentPath = '/reports/2021-06-30/documents/amzn1.spdoc.1.4.eu.T3PY2XYI69WPGH.1118';
  const waits = [0, 1, 2, 3, 4, 5].map(attempt => throttleRetryDelayMs({ method: 'GET', path: documentPath, attempt }));
  assert.ok(waits.every(wait => wait >= 45_000), `every retry must clear the 45s window, got ${waits.join(', ')}`);
  assert.deepEqual(waits.slice(0, 3), [45_000, 45_000, 45_000], 'no longer 2s, 4s, 8s');
});

test('Amazon asking for longer than the bucket interval wins', () => {
  const wait = throttleRetryDelayMs({ method: 'GET', path: '/reports/2021-06-30/documents/doc', attempt: 0, retryAfterSeconds: 90 });
  assert.equal(wait, 90_000);
});

test('a retry never waits longer than the cap, however Amazon answers', () => {
  assert.equal(throttleRetryDelayMs({ method: 'GET', path: '/reports/2021-06-30/documents/doc', attempt: 0, retryAfterSeconds: 3600 }), 120_000);
  assert.equal(throttleRetryDelayMs({ method: 'GET', path: '/orders/v0/orders', attempt: 20 }), 120_000);
});

test('a fast bucket still backs off exponentially rather than at its floor', () => {
  // Orders paces at 2200ms; the exponential must take over once it exceeds
  // that, or a genuinely overloaded endpoint gets hammered at a fixed rate.
  const waits = [0, 1, 2, 3].map(attempt => throttleRetryDelayMs({ method: 'GET', path: '/orders/v0/orders', attempt }));
  assert.deepEqual(waits, [2200, 4000, 8000, 16_000]);
});

function settlementClient({ documents, failAt }) {
  const client = new SpApiClient('refresh-token', { clientId: 'id', clientSecret: 'secret' });
  client.request = async () => ({
    ok: true,
    json: async () => ({ reports: documents.map((id, index) => ({ reportId: `r${index}`, reportDocumentId: id, dataStartTime: '2026-07-01T00:00:00Z', dataEndTime: '2026-07-25T00:00:00Z' })) })
  });
  const downloaded = [];
  client.downloadReportDocument = async id => {
    if (id === failAt) throw new Error(`SP-API request failed after retries: GET /reports/2021-06-30/documents/${id}`);
    downloaded.push(id);
    return { content: `header\n${id}-row` };
  };
  return { client, downloaded };
}
const SETTLEMENT_RANGE = { start: '2026-07-01T00:00:00Z', end: '2026-07-25T00:00:00Z' };
const TENANT = '2c10fe2c-dfcd-4a34-9bd2-6638e4be2c55';

test('a throttled document keeps every document already downloaded in that run', async () => {
  // Each document costs a 45s slot of Amazon's quota. Failing the whole run
  // on document 3 used to discard documents 1 and 2 as well, so a backlog
  // could never converge.
  const { client, downloaded } = settlementClient({ documents: ['doc-a', 'doc-b', 'doc-c', 'doc-d'], failAt: 'doc-c' });
  const report = await client.fetchReport('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', TENANT, SETTLEMENT_RANGE);

  assert.deepEqual(downloaded, ['doc-a', 'doc-b']);
  assert.equal(report.reportsMerged, 2);
  assert.equal(report.reportsOutstanding, 2, 'doc-c and doc-d are still to fetch');
  assert.equal(report.reportsTruncated, true);
  assert.deepEqual(report.documentIds, ['doc-a', 'doc-b'], 'only imported documents may be recorded as processed');
  assert.match(report.content, /doc-a-row/);
  assert.match(report.content, /doc-b-row/);
});

test('a run where nothing downloaded still surfaces the real failure', async () => {
  const { client } = settlementClient({ documents: ['doc-a', 'doc-b'], failAt: 'doc-a' });
  await assert.rejects(
    client.fetchReport('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', TENANT, SETTLEMENT_RANGE),
    /SP-API request failed after retries/,
    'an empty run must not be reported as a partial success'
  );
});

test('a fully successful run reports nothing outstanding', async () => {
  const { client, downloaded } = settlementClient({ documents: ['doc-a', 'doc-b'], failAt: null });
  const report = await client.fetchReport('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', TENANT, SETTLEMENT_RANGE);
  assert.deepEqual(downloaded, ['doc-a', 'doc-b']);
  assert.equal(report.reportsTruncated, false);
  assert.equal(report.reportsOutstanding, 0);
});

test('documents already stored are not counted as outstanding', async () => {
  const { client, downloaded } = settlementClient({ documents: ['doc-a', 'doc-b', 'doc-c'], failAt: null });
  const report = await client.fetchReport('GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2', TENANT, SETTLEMENT_RANGE, undefined, { skipDocumentIds: new Set(['doc-a', 'doc-b']) });
  assert.deepEqual(downloaded, ['doc-c']);
  assert.equal(report.reportsOutstanding, 0, 'reportsAvailable - reportsMerged would wrongly say 2');
  assert.equal(report.reportsTruncated, false);
});

function createReportClient(status, body) {
  const client = new SpApiClient('refresh-token', { clientId: 'id', clientSecret: 'secret' });
  client.request = async (path, init) => init?.method === 'POST' && path === '/reports/2021-06-30/reports'
    ? { ok: false, status, text: async () => body }
    : { ok: true, json: async () => ({}) };
  return client;
}

test('a 403 on create report repeats what Amazon actually said', async () => {
  // The body names the problem; it was being read past and discarded, leaving
  // the seller with a bare "Create report failed: 403".
  const client = createReportClient(403, JSON.stringify({ errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] }));
  await assert.rejects(
    client.fetchReport('GET_SALES_AND_TRAFFIC_REPORT', TENANT, SETTLEMENT_RANGE),
    error => {
      assert.match(error.message, /Create report failed: 403/);
      assert.match(error.message, /Unauthorized: Access to requested resource is denied\./);
      return true;
    }
  );
});

test('a 403 names the application role the report type needs, and the re-authorization', async () => {
  const client = createReportClient(403, '');
  await assert.rejects(
    client.fetchReport('GET_GST_MTR_B2B_CUSTOM', TENANT, SETTLEMENT_RANGE),
    error => {
      assert.match(error.message, /"Tax Invoicing" role/);
      assert.match(error.message, /Developer Central, not in Seller Central/);
      assert.match(error.message, /re-authorize/);
      return true;
    }
  );
});

test('a non-403 failure is not blamed on a missing role', async () => {
  const client = createReportClient(503, JSON.stringify({ errors: [{ code: 'ServiceUnavailable', message: 'Try again later.' }] }));
  await assert.rejects(
    client.fetchReport('GET_SALES_AND_TRAFFIC_REPORT', TENANT, SETTLEMENT_RANGE),
    error => {
      assert.match(error.message, /Try again later\./);
      assert.doesNotMatch(error.message, /role/);
      return true;
    }
  );
});

test('an unreadable error body never masks the status', async () => {
  const client = new SpApiClient('refresh-token', { clientId: 'id', clientSecret: 'secret' });
  client.request = async (path, init) => init?.method === 'POST' && path === '/reports/2021-06-30/reports'
    ? { ok: false, status: 403, text: async () => { throw new Error('stream already consumed'); } }
    : { ok: true, json: async () => ({}) };
  await assert.rejects(client.fetchReport('GET_SALES_AND_TRAFFIC_REPORT', TENANT, SETTLEMENT_RANGE), /Create report failed: 403/);
});

test('a failed token exchange says which kind of failure it was', async () => {
  // Verified against the live LWA endpoint: a valid application presented with
  // a seller token minted for a different application answers 400
  // unauthorized_client, while the same application with a wrong secret
  // answers 401 invalid_client. Those need opposite fixes, and the bare status
  // code told them apart not at all.
  const original = globalThis.fetch;
  const reply = (status, body) => { globalThis.fetch = async () => ({ ok: false, status, text: async () => JSON.stringify(body) }); };
  try {
    reply(400, { error: 'unauthorized_client', error_description: 'Not authorized for requested operation' });
    await assert.rejects(new SpApiClient('token', { clientId: 'id', clientSecret: 'secret' }).getAccessToken(), error => {
      assert.match(error.message, /LWA token exchange failed: 400/);
      assert.match(error.message, /unauthorized_client: Not authorized for requested operation/);
      assert.match(error.message, /not issued to this SP-API application/);
      assert.match(error.message, /must connect the account again/);
      return true;
    });

    reply(401, { error: 'invalid_client', error_description: 'Client authentication failed' });
    await assert.rejects(new SpApiClient('token', { clientId: 'id', clientSecret: 'nope' }).getAccessToken(), error => {
      assert.match(error.message, /client id and secret do not match/);
      assert.doesNotMatch(error.message, /revoked its authorization/, 'a credential problem must not be reported as a seller problem');
      return true;
    });

    reply(400, { error: 'some_new_code_amazon_added' });
    await assert.rejects(new SpApiClient('token', { clientId: 'id', clientSecret: 's' }).getAccessToken(), /some_new_code_amazon_added/);
  } finally {
    globalThis.fetch = original;
  }
});
