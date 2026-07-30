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

const SP_API_RATE_LIMITS = Object.freeze([
  { pattern: /^\/orders\//, intervalMs: 2200 },
  { pattern: /^\/reports\//, intervalMs: 5000 },
  { pattern: /^\/finances\//, intervalMs: 5000 },
  { pattern: /^\/fba\/inventory\//, intervalMs: 5000 },
  { pattern: /^\/tokens\//, intervalMs: 5000 },
  { pattern: /^\/products\/fees\//, intervalMs: 2200 },
  { pattern: /^\/catalog\//, intervalMs: 2200 }
]);
const DEFAULT_SP_API_INTERVAL_MS = 3000;
const rateLimitState = new Map();
let globalNextAvailableAt = Date.now();

/** @param {string} path */
function rateLimitBucket(path) {
  const limit = SP_API_RATE_LIMITS.find(item => item.pattern.test(path));
  const family = path.split('/').filter(Boolean)[0] ?? 'default';
  return { key: family, intervalMs: limit?.intervalMs ?? DEFAULT_SP_API_INTERVAL_MS };
}

/** @param {string} path */
async function waitForSpApiSlot(path) {
  const { key, intervalMs } = rateLimitBucket(path);
  const now = Date.now();
  const nextAvailableAt = Math.max(rateLimitState.get(key) ?? now, globalNextAvailableAt);
  const waitMs = Math.max(0, nextAvailableAt - now);
  const reservedAt = now + waitMs + intervalMs;
  rateLimitState.set(key, reservedAt);
  globalNextAvailableAt = now + waitMs + 750;
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
}

export class SpApiClient {
  /** @param {string} refreshToken @param {{ clientId?: string, clientSecret?: string }} [cfg] */
  constructor(refreshToken, cfg = {}) {
    this.refreshToken = z.string().min(1).parse(refreshToken);
    this.cfg = { clientId: cfg.clientId ?? process.env.LWA_CLIENT_ID, clientSecret: cfg.clientSecret ?? process.env.LWA_CLIENT_SECRET, baseUrl: cfg.baseUrl ?? SP_API_BASE_URL };
    this.cachedToken = null;
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
    let accessToken = token ?? (await this.getAccessToken()).accessToken;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await waitForSpApiSlot(path);
      const res = await fetch(`${this.cfg.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-amz-access-token': accessToken, ...(init.headers ?? {}) }
      });
      const rateLimit = Number(res.headers.get('x-amzn-RateLimit-Limit') ?? '0.5');
      if (![429, 503].includes(res.status)) return res;
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (1000 / Math.max(rateLimit, 0.05)) * 2 ** attempt;
      await new Promise(resolve => setTimeout(resolve, Math.min(120_000, backoffMs)));
      accessToken = token ?? (await this.getAccessToken()).accessToken;
    }
    throw new Error(`SP-API request failed after retries: ${path}`);
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

  /** @param {string} reportType @param {string} tenantId @param {{ start: string, end: string }} range @param {string} [marketplaceId] */
  async fetchReport(reportType, tenantId, range, marketplaceId = INDIA_MARKETPLACE_ID) {
    const parsedReportType = z.enum(REPORT_TYPES).parse(reportType);
    const parsedRange = normalizeReportRange(range);
    const parsedTenant = z.string().uuid().parse(tenantId);
    if (parsedReportType === 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2') {
      // Settlement reports are generated by Amazon on a schedule and cannot
      // reliably be created on demand. Select the latest completed report
      // covering the requested period instead of calling createReport.
      const createdSince = new Date(new Date(parsedRange.start).getTime() - 45 * 864e5).toISOString();
      const listPath = `/reports/2021-06-30/reports?reportTypes=${encodeURIComponent(parsedReportType)}&processingStatuses=DONE&marketplaceIds=${encodeURIComponent(marketplaceId)}&createdSince=${encodeURIComponent(createdSince)}&pageSize=100`;
      const list = await this.request(listPath);
      if (!list.ok) throw new Error(`List settlement reports failed: ${list.status}`);
      const reports = z.object({ reports: z.array(z.object({ reportId: z.string(), reportDocumentId: z.string().optional(), dataStartTime: z.string().optional(), dataEndTime: z.string().optional(), createdTime: z.string().optional() })).default([]) }).parse(await list.json()).reports;
      const requestedStart = new Date(parsedRange.start).getTime();
      const requestedEnd = new Date(parsedRange.end).getTime();
      const matchingReports = reports
        .filter(item => item.reportDocumentId && (!item.dataEndTime || new Date(item.dataEndTime).getTime() >= requestedStart) && (!item.dataStartTime || new Date(item.dataStartTime).getTime() <= requestedEnd))
        .sort((a, b) => new Date(b.dataEndTime ?? b.createdTime ?? 0).getTime() - new Date(a.dataEndTime ?? a.createdTime ?? 0).getTime())
        .slice(0, 10);
      if (!matchingReports.length) throw new Error('No completed Amazon settlement report is available for this date range yet');
      const documents = [];
      for (const report of matchingReports) documents.push(await this.downloadReportDocument(report.reportDocumentId));
      const content = documents.map((document, index) => index === 0 ? document.content : document.content.split(/\r?\n/).slice(1).join('\n')).join('\n');
      return { reportId: matchingReports[0].reportId, reportDocumentId: matchingReports[0].reportDocumentId, content, compressionAlgorithm: 'MERGED_SETTLEMENT_REPORTS', reportsMerged: matchingReports.length };
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
    const download = await fetch(url);
    if (!download.ok) throw new Error(`Document download failed: ${download.status}`);
    const buffer = Buffer.from(await download.arrayBuffer());
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
