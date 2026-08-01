import { gunzipSync } from 'node:zlib';
import { z } from 'zod';

export const SP_API_BASE_URL = 'https://sellingpartnerapi-eu.amazon.com';
export const INDIA_MARKETPLACE_ID = 'A21TJRUUN4KGV';
export const MARKETPLACES = Object.freeze({
  A21TJRUUN4KGV: { country: 'India', region: 'IN', endpoint: 'https://sellingpartnerapi-eu.amazon.com', sellerCentralHost: 'sellercentral.amazon.in' },
  ATVPDKIKX0DER: { country: 'United States', region: 'NA', endpoint: 'https://sellingpartnerapi-na.amazon.com', sellerCentralHost: 'sellercentral.amazon.com' },
  A1F83G8C2ARO7P: { country: 'United Kingdom', region: 'EU', endpoint: 'https://sellingpartnerapi-eu.amazon.com', sellerCentralHost: 'sellercentral.amazon.co.uk' }
});
export function getSpApiEndpoint(marketplaceId = INDIA_MARKETPLACE_ID) { return MARKETPLACES[marketplaceId]?.endpoint ?? SP_API_BASE_URL; }
export const REPORT_TYPES = Object.freeze([
  'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
  'GET_GST_MTR_B2B_CUSTOM',
  'GET_GST_MTR_B2C_CUSTOM',
  'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
  'GET_FBA_REIMBURSEMENTS_DATA',
  'GET_SALES_AND_TRAFFIC_REPORT',
  'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'
]);

const GST_REPORTS = new Set(['GET_GST_MTR_B2B_CUSTOM', 'GET_GST_MTR_B2C_CUSTOM']);
const DateRangeSchema = z.object({ start: z.string().datetime(), end: z.string().datetime() });
const REPORT_DATA_LAG_MS = 2 * 60 * 1000;
const REPORT_POLL_INTERVAL_MS = 15_000;
const REPORT_POLL_ATTEMPTS = 20;
const SETTLEMENT_REPORT_LIST_MAX_PAGES = 20;
// Bounds a single sync call's wall-clock time (Amazon's real ~45s/document
// limit on this operation, minus the 10-document burst allowance, means this
// is roughly 10 minutes worst case for one request) rather than how much
// data is fetchable overall - reportsTruncated + the skip-already-processed
// logic above mean nothing past this cap is lost, only deferred to the next
// sync, which will pick up exactly where this one left off.
const SETTLEMENT_REPORT_DOWNLOAD_CAP = 20;
const REPORT_DOCUMENT_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const SP_API_MAX_ATTEMPTS = 6;
const DOCUMENT_DOWNLOAD_MAX_ATTEMPTS = 4;

/**
 * Amazon rejects report requests whose dataEndTime is in the future. The web
 * app deliberately sends an exclusive end date (the day after the selected
 * date), so a range ending today would otherwise send tomorrow at midnight.
 * Keep the requested start, but cap the exclusive end at Amazon's safe API
 * boundary and retain a valid interval for same-day reports.
 *
 * @param {{ start: string, end: string }} range
 * @param {number} [now]
 */
export function normalizeReportRange(range, now = Date.now()) {
  const parsed = DateRangeSchema.parse(range);
  const start = new Date(parsed.start);
  const requestedEnd = new Date(parsed.end);
  const safeEnd = new Date(now - REPORT_DATA_LAG_MS);
  const end = new Date(Math.min(requestedEnd.getTime(), safeEnd.getTime()));
  if (start.getTime() >= end.getTime()) {
    throw new Error('Report date range must start before Amazon\'s latest available data time');
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

// Amazon enforces a *separate* steady-state rate limit per specific
// operation, not per API family - lumping every /reports/* call into one
// bucket (as this used to do) means bulk report-document downloads fire far
// faster than Amazon actually allows for that specific operation, run out
// their retry budget, and throw "SP-API request failed after retries" even
// though report *creation* and *polling* (much more generous limits) still
// have room to spare in the same shared bucket. These intervals are Amazon's
// published steady-state rates (ms = 1000 / requests-per-second) for the
// Reports API v2021-06-30 operations this client actually calls; other
// families keep their previous conservative pacing.
// burst = how many requests Amazon actually lets through back-to-back before
// the steady-state interval applies (a real token bucket, matching Amazon's
// documented model) - without it, every single request pays the full
// steady-state interval even at the very start of a sync, which is far more
// conservative than Amazon's actual quota and makes bulk operations (a
// settlement history with many documents) needlessly slow.
const SP_API_OPERATION_LIMITS = Object.freeze([
  { key: 'reports:create', method: 'POST', pattern: /^\/reports\/2021-06-30\/reports$/, intervalMs: 60_000, burst: 15 },
  { key: 'reports:list', method: 'GET', pattern: /^\/reports\/2021-06-30\/reports(\?|$)/, intervalMs: 45_000, burst: 10 },
  { key: 'reports:poll', method: 'GET', pattern: /^\/reports\/2021-06-30\/reports\/[^/]+$/, intervalMs: 500, burst: 15 },
  { key: 'reports:document', method: 'GET', pattern: /^\/reports\/2021-06-30\/documents\//, intervalMs: 45_000, burst: 10 },
  { key: 'orders', pattern: /^\/orders\//, intervalMs: 2200, burst: 1 },
  { key: 'finances', pattern: /^\/finances\//, intervalMs: 5000, burst: 1 },
  { key: 'fba', pattern: /^\/fba\/inventory\//, intervalMs: 5000, burst: 1 },
  { key: 'tokens', pattern: /^\/tokens\//, intervalMs: 5000, burst: 1 },
  { key: 'products', pattern: /^\/products\/fees\//, intervalMs: 2200, burst: 1 },
  { key: 'catalog', pattern: /^\/catalog\//, intervalMs: 2200, burst: 1 }
]);
const DEFAULT_SP_API_INTERVAL_MS = 3000;

/** @param {string} method @param {string} path */
function rateLimitBucket(method, path) {
  const pathname = path.split('?')[0];
  const match = SP_API_OPERATION_LIMITS.find(item => (!item.method || item.method === method) && item.pattern.test(pathname));
  return { key: match?.key ?? (pathname.split('/').filter(Boolean)[0] ?? 'default'), intervalMs: match?.intervalMs ?? DEFAULT_SP_API_INTERVAL_MS, burst: match?.burst ?? 1 };
}

export class SpApiClient {
  /** @param {string} refreshToken @param {{ clientId?: string, clientSecret?: string, baseUrl?: string, label?: string }} [cfg] */
  constructor(refreshToken, cfg = {}) {
    this.refreshToken = z.string().min(1).parse(refreshToken);
    this.cfg = { clientId: cfg.clientId ?? process.env.LWA_CLIENT_ID, clientSecret: cfg.clientSecret ?? process.env.LWA_CLIENT_SECRET, baseUrl: cfg.baseUrl ?? SP_API_BASE_URL };
    this.cachedToken = null;
    this.label = cfg.label ?? 'sp-api';
    // Rate-limit pacing is per-seller-account in Amazon's real quota model -
    // this must live on the instance (one instance per seller/sync), not at
    // module scope, or two different sellers syncing at the same time would
    // needlessly throttle each other against a shared, imaginary quota.
    this.rateLimitState = new Map();
    this.nextGlobalSlotAt = Date.now();
  }

  /**
   * Token-bucket pacing per operation: a bucket starts full (burst tokens
   * available immediately, matching Amazon's real quota model) and refills
   * at the steady-state rate. Only once burst capacity is exhausted does a
   * request actually wait the full steady-state interval. Without this, a
   * bulk operation (downloading many settlement documents) would pay the
   * full interval on every single request from the first one, which is far
   * more conservative than what Amazon actually allows.
   * @param {string} method @param {string} path
   */
  async waitForSlot(method, path) {
    const { key, intervalMs, burst } = rateLimitBucket(method, path);
    const now = Date.now();
    let bucket = this.rateLimitState.get(key);
    if (!bucket) { bucket = { tokens: burst, lastRefillAt: now }; this.rateLimitState.set(key, bucket); }
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.lastRefillAt) / intervalMs);
    bucket.lastRefillAt = now;
    const bucketWaitMs = bucket.tokens < 1 ? (1 - bucket.tokens) * intervalMs : 0;
    bucket.tokens = Math.max(0, bucket.tokens - 1);
    const waitMs = Math.max(bucketWaitMs, this.nextGlobalSlotAt - now, 0);
    this.nextGlobalSlotAt = now + waitMs + 200;
    if (waitMs > 500) console.log(`[${this.label}] pacing ${method} ${path} - waiting ${Math.round(waitMs)}ms (bucket "${key}", ${intervalMs}ms/request, burst ${burst})`);
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  async getAccessToken() {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60_000) return this.cachedToken;
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: this.cfg.clientId ?? '', client_secret: this.cfg.clientSecret ?? '' })
    });
    if (!res.ok) throw new Error(`LWA token exchange failed: ${res.status}`);
    const body = z.object({ access_token: z.string().min(1), expires_in: z.number().default(3600) }).parse(await res.json());
    this.cachedToken = { accessToken: body.access_token, expiresIn: body.expires_in, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.cachedToken;
  }

  /** @param {string} path @param {RequestInit} [init] @param {string} [token] */
  async request(path, init = {}, token) {
    const method = init.method ?? 'GET';
    let accessToken = token ?? (await this.getAccessToken()).accessToken;
    const attemptLog = [];
    for (let attempt = 0; attempt < SP_API_MAX_ATTEMPTS; attempt += 1) {
      await this.waitForSlot(method, path);
      const res = await fetch(`${this.cfg.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-amz-access-token': accessToken, ...(init.headers ?? {}) }
      });
      const rateLimit = Number(res.headers.get('x-amzn-RateLimit-Limit') ?? '0.5');
      if (![429, 503].includes(res.status)) {
        if (attempt > 0) console.log(`[${this.label}] ${method} ${path} succeeded (${res.status}) on attempt ${attempt + 1}/${SP_API_MAX_ATTEMPTS} after: ${attemptLog.join(', ')}`);
        return res;
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (1000 / Math.max(rateLimit, 0.05)) * 2 ** attempt;
      const waitMs = Math.min(120_000, backoffMs);
      attemptLog.push(`${res.status} (waited ${Math.round(waitMs)}ms)`);
      console.warn(`[${this.label}] ${method} ${path} -> ${res.status}, retry ${attempt + 1}/${SP_API_MAX_ATTEMPTS} in ${Math.round(waitMs)}ms`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      accessToken = token ?? (await this.getAccessToken()).accessToken;
    }
    console.error(`[${this.label}] ${method} ${path} gave up after ${SP_API_MAX_ATTEMPTS} attempts: ${attemptLog.join(', ')}`);
    throw new Error(`SP-API request failed after retries: ${method} ${path} (${attemptLog.join(', ')})`);
  }

  /** @param {string} documentId */
  async restrictedDataToken(documentId) {
    const id = z.string().min(1).parse(documentId);
    const path = `/reports/2021-06-30/documents/${id}`;
    const res = await this.request('/tokens/2021-03-01/restrictedDataToken', {
      method: 'POST',
      body: JSON.stringify({ restrictedResources: [{ method: 'GET', path, dataElements: ['taxInvoiceDataAccess'] }] })
    });
    if (!res.ok) throw new Error(`RDT request failed: ${res.status}`);
    return z.object({ restrictedDataToken: z.string().min(1) }).parse(await res.json()).restrictedDataToken;
  }

  /** @param {string} reportType @param {string} tenantId @param {{ start: string, end: string }} range @param {string} [marketplaceId] @param {{ skipDocumentIds?: Set<string> }} [options] */
  async fetchReport(reportType, tenantId, range, marketplaceId = INDIA_MARKETPLACE_ID, options = {}) {
    const parsedReportType = z.enum(REPORT_TYPES).parse(reportType);
    const parsedRange = normalizeReportRange(range);
    const parsedTenant = z.string().uuid().parse(tenantId);
    if (parsedReportType === 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2') {
      // Settlement reports are generated by Amazon on a schedule and cannot
      // reliably be created on demand. Select every completed report
      // covering the requested period instead of calling createReport.
      const createdSince = new Date(new Date(parsedRange.start).getTime() - 45 * 864e5).toISOString();
      const ReportListResponseSchema = z.object({
        reports: z.array(z.object({ reportId: z.string(), reportDocumentId: z.string().optional(), dataStartTime: z.string().optional(), dataEndTime: z.string().optional(), createdTime: z.string().optional() })).default([]),
        nextToken: z.string().optional()
      });
      // getReports paginates at up to 100 rows per page. A high-volume or
      // long-history seller can easily have more settlement report documents
      // than a single page within the createdSince window, so a single
      // unpaginated call silently truncates older (but still date-relevant)
      // reports for exactly the accounts that most need them.
      const reports = [];
      let nextToken;
      for (let page = 0; page < SETTLEMENT_REPORT_LIST_MAX_PAGES; page += 1) {
        const listPath = nextToken
          ? `/reports/2021-06-30/reports?nextToken=${encodeURIComponent(nextToken)}`
          : `/reports/2021-06-30/reports?reportTypes=${encodeURIComponent(parsedReportType)}&processingStatuses=DONE&marketplaceIds=${encodeURIComponent(marketplaceId)}&createdSince=${encodeURIComponent(createdSince)}&pageSize=100`;
        const list = await this.request(listPath);
        if (!list.ok) throw new Error(`List settlement reports failed: ${list.status}`);
        const body = ReportListResponseSchema.parse(await list.json());
        reports.push(...body.reports);
        nextToken = body.nextToken;
        if (!nextToken) break;
      }
      const requestedStart = new Date(parsedRange.start).getTime();
      const requestedEnd = new Date(parsedRange.end).getTime();
      const matchingReports = reports
        .filter(item => item.reportDocumentId && (!item.dataEndTime || new Date(item.dataEndTime).getTime() >= requestedStart) && (!item.dataStartTime || new Date(item.dataStartTime).getTime() <= requestedEnd))
        .sort((a, b) => new Date(b.dataEndTime ?? b.createdTime ?? 0).getTime() - new Date(a.dataEndTime ?? a.createdTime ?? 0).getTime());
      if (!matchingReports.length) throw new Error('No completed Amazon settlement report is available for this date range yet');
      // A settlement report document is immutable once generated - Amazon
      // never revises one after the fact - so a document this tenant has
      // already downloaded and successfully saved has nothing new to offer.
      // Re-downloading it anyway was the actual cause of settlement syncs
      // taking 10+ minutes and re-fetching the same historical documents on
      // every single sync: with a 45s/request real Amazon limit on this
      // operation, a long-history account's full backlog could never
      // finish within one request before this existed.
      const skipDocumentIds = options.skipDocumentIds ?? new Set();
      const newReports = matchingReports.filter(item => !skipDocumentIds.has(item.reportDocumentId));
      if (!newReports.length) {
        return {
          reportId: matchingReports[0].reportId,
          reportDocumentId: matchingReports[0].reportDocumentId,
          content: '',
          compressionAlgorithm: 'MERGED_SETTLEMENT_REPORTS',
          reportsMerged: 0,
          reportsAvailable: matchingReports.length,
          reportsTruncated: false,
          documentIds: [],
          allAlreadyProcessed: true
        };
      }
      // Every remaining report genuinely overlaps the requested range, is
      // real seller data, and has never been fetched before - there is no
      // principled amount of it to discard. This safety cap only guards
      // against a pathologically large first-time backlog in a single
      // request; anything past it is picked up by the *next* sync instead
      // (nothing here is skipped forever - only already-processed).
      const boundedReports = newReports.slice(0, SETTLEMENT_REPORT_DOWNLOAD_CAP);
      const documents = [];
      for (const report of boundedReports) documents.push(await this.downloadReportDocument(report.reportDocumentId));
      const content = documents.map((document, index) => index === 0 ? document.content : document.content.split(/\r?\n/).slice(1).join('\n')).join('\n');
      return {
        reportId: boundedReports[0].reportId,
        reportDocumentId: boundedReports[0].reportDocumentId,
        content,
        compressionAlgorithm: 'MERGED_SETTLEMENT_REPORTS',
        reportsMerged: boundedReports.length,
        reportsAvailable: matchingReports.length,
        reportsTruncated: newReports.length > boundedReports.length,
        documentIds: boundedReports.map(item => item.reportDocumentId)
      };
    }
    const reportOptions = parsedReportType === 'GET_SALES_AND_TRAFFIC_REPORT'
      ? { dateGranularity: 'DAY', asinGranularity: 'CHILD' }
      : undefined;
    const createReportBody = {
      reportType: parsedReportType,
      marketplaceIds: [marketplaceId],
      dataStartTime: parsedRange.start,
      dataEndTime: parsedRange.end,
      ...(reportOptions ? { reportOptions } : {})
    };
    let create = await this.request('/reports/2021-06-30/reports', {
      method: 'POST',
      body: JSON.stringify(createReportBody)
    });
    if (!create.ok && create.status === 400) {
      create = await this.request('/reports/2021-06-30/reports', {
        method: 'POST',
        body: JSON.stringify({ reportType: parsedReportType, marketplaceIds: [marketplaceId] })
      });
    }
    if (!create.ok) throw new Error(`Create report failed: ${create.status}`);
    const { reportId } = z.object({ reportId: z.string().min(1) }).parse(await create.json());

    let reportDocumentId = '';
    for (let attempt = 0; attempt < REPORT_POLL_ATTEMPTS; attempt += 1) {
      const poll = await this.request(`/reports/2021-06-30/reports/${reportId}`);
      if (!poll.ok) throw new Error(`Poll report failed: ${poll.status}`);
      const body = z.object({ processingStatus: z.string(), reportDocumentId: z.string().optional() }).parse(await poll.json());
      if (body.processingStatus === 'DONE' && body.reportDocumentId) {
        reportDocumentId = body.reportDocumentId;
        break;
      }
      if (['CANCELLED', 'FATAL'].includes(body.processingStatus)) throw new Error(`Report ${reportId} ${body.processingStatus}`);
      await new Promise(resolve => setTimeout(resolve, REPORT_POLL_INTERVAL_MS));
    }
    if (!reportDocumentId) throw new Error(`Report ${reportId} timed out for tenant ${parsedTenant}`);

    // GST MTR reports are generated by the Reports API for authorized sellers;
    // several India seller accounts return 403 from Tokens API RDT even when
    // the report document itself is downloadable with the normal LWA token.
    // Try the standard document flow first so B2B/B2C syncs do not fail
    // unnecessarily; fall back to RDT only if Amazon rejects document access.
    let downloaded;
    try {
      downloaded = await this.downloadReportDocument(reportDocumentId);
    } catch (error) {
      if (!GST_REPORTS.has(parsedReportType)) throw error;
      const documentToken = await this.restrictedDataToken(reportDocumentId);
      downloaded = await this.downloadReportDocument(reportDocumentId, documentToken);
    }
    return { reportId, reportDocumentId, ...downloaded };
  }

  async downloadReportDocument(reportDocumentId, token) {
    const document = await this.request(`/reports/2021-06-30/documents/${encodeURIComponent(reportDocumentId)}`, {}, token);
    if (!document.ok) throw new Error(`Document lookup failed: ${document.status}`);
    const { url, compressionAlgorithm } = z.object({ url: z.string().url(), compressionAlgorithm: z.string().optional() }).parse(await document.json());
    // This is a direct S3 download, not an SP-API call, so it isn't covered
    // by the rate limiter/retry logic in request(). A high-volume seller's
    // settlement report can be tens of MB; without a timeout, a stalled
    // connection on a large file hangs the whole sync indefinitely instead
    // of failing cleanly and letting the caller retry.
    //
    // A multi-document settlement sync calls this once per document in a
    // loop, and a single unretried transient network error here (confirmed
    // live: a bare "fetch failed" - a thrown TypeError from a dropped
    // connection, not an HTTP error status at all) aborted the *entire*
    // multi-document sync, discarding every document already successfully
    // downloaded in the same run. A short retry loop, same as the SP-API
    // rate-limit retries elsewhere in this file, absorbs one-off network
    // blips without masking a genuinely broken download.
    let buffer;
    for (let attempt = 0; attempt < DOCUMENT_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
      try {
        const download = await fetch(url, { signal: AbortSignal.timeout(REPORT_DOCUMENT_DOWNLOAD_TIMEOUT_MS) });
        if (!download.ok) throw new Error(`Document download failed: ${download.status}`);
        buffer = Buffer.from(await download.arrayBuffer());
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === DOCUMENT_DOWNLOAD_MAX_ATTEMPTS - 1) {
          console.error(`[${this.label}] document download for ${reportDocumentId} gave up after ${DOCUMENT_DOWNLOAD_MAX_ATTEMPTS} attempts: ${message}`);
          throw error;
        }
        const waitMs = 2000 * 2 ** attempt;
        console.warn(`[${this.label}] document download for ${reportDocumentId} failed (${message}), retry ${attempt + 1}/${DOCUMENT_DOWNLOAD_MAX_ATTEMPTS} in ${waitMs}ms`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
    let content = buffer.toString('utf8');
    if (compressionAlgorithm === 'GZIP') {
      try { content = gunzipSync(buffer).toString('utf8'); } catch { content = buffer.toString('utf8'); }
    }
    return { content, compressionAlgorithm };
  }

  /** @param {string} sellerSku @param {unknown} body */
  async estimateListingFees(sellerSku, body) {
    const sku = z.string().min(1).parse(sellerSku);
    const res = await this.request(`/products/fees/v0/listings/${encodeURIComponent(sku)}/feesEstimate`, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Fees estimate failed: ${res.status}`);
    return res.json();
  }

  /** @param {string} createdAfter @param {string} [marketplaceId] @param {string} [createdBefore] */
  async listOrders(createdAfter, marketplaceId = INDIA_MARKETPLACE_ID, createdBefore) {
    const date = z.string().datetime().parse(createdAfter);
    const before = createdBefore ? z.string().datetime().parse(createdBefore) : null;
    const beforeQuery = before ? `&CreatedBefore=${encodeURIComponent(before)}` : '';
    const res = await this.request(`/orders/v0/orders?MarketplaceIds=${marketplaceId}&CreatedAfter=${encodeURIComponent(date)}${beforeQuery}`);
    if (!res.ok) throw new Error(`List orders failed: ${res.status}`);
    return res.json();
  }

  /** @param {string} nextToken */
  async listOrdersByNextToken(nextToken) {
    const token = z.string().min(1).parse(nextToken);
    const res = await this.request(`/orders/v0/orders?NextToken=${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error(`List orders page failed: ${res.status}`);
    return res.json();
  }

  /** @param {string} orderId */
  async listOrderItems(orderId) {
    const id = z.string().min(1).parse(orderId);
    const res = await this.request(`/orders/v0/orders/${encodeURIComponent(id)}/orderItems`);
    if (!res.ok) throw new Error(`List order items failed: ${res.status}`);
    return res.json();
  }

  /** Fetches Amazon's catalog attributes used for package weight and dimensions. */
  async getCatalogItem(asin, marketplaceId = INDIA_MARKETPLACE_ID) {
    const parsedAsin = z.string().min(1).parse(asin);
    const path = `/catalog/2022-04-01/items/${encodeURIComponent(parsedAsin)}?marketplaceIds=${encodeURIComponent(marketplaceId)}&includedData=attributes,dimensions,productTypes,summaries,classifications`;
    const res = await this.request(path);
    if (!res.ok) throw new Error(`Catalog item lookup failed: ${res.status}`);
    const raw = await res.json();
    const category = raw?.summaries?.[0]?.websiteDisplayGroup ?? raw?.classifications?.[0]?.classifications?.[0]?.displayName ?? raw?.productTypes?.[0]?.productType ?? null;
    const weightNode = raw?.dimensions?.[0]?.package?.weight ?? raw?.dimensions?.[0]?.item?.weight ?? null;
    return { ...raw, category, weightNode, raw };
  }


  /** @param {string} [marketplaceId] */
  async listInventorySummaries(marketplaceId = INDIA_MARKETPLACE_ID) {
    const res = await this.request(`/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${encodeURIComponent(marketplaceId)}&marketplaceIds=${encodeURIComponent(marketplaceId)}`);
    if (!res.ok) throw new Error(`Inventory summaries failed: ${res.status}`);
    return res.json();
  }

  /** @param {string} postedAfter @param {string} [postedBefore] */
  async listFinanceTransactions(postedAfter, postedBefore, nextToken) {
    if (nextToken) {
      const res = await this.request(`/finances/2024-06-19/transactions?nextToken=${encodeURIComponent(z.string().min(1).parse(nextToken))}`);
      if (!res.ok) throw new Error(`Finance transactions page failed: ${res.status}`);
      return res.json();
    }
    const date = z.string().datetime().parse(postedAfter);
    const before = postedBefore ? z.string().datetime().parse(postedBefore) : null;
    const beforeQuery = before ? `&postedBefore=${encodeURIComponent(before)}` : '';
    const res = await this.request(`/finances/2024-06-19/transactions?postedAfter=${encodeURIComponent(date)}${beforeQuery}`);
    if (!res.ok) throw new Error(`Finance transactions failed: ${res.status}`);
    return res.json();
  }
}
