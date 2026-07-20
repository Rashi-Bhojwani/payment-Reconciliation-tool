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

const SP_API_RATE_LIMITS = Object.freeze([
  { pattern: /^\/orders\//, intervalMs: 1200 },
  { pattern: /^\/reports\//, intervalMs: 2500 },
  { pattern: /^\/finances\//, intervalMs: 2500 },
  { pattern: /^\/fba\/inventory\//, intervalMs: 2500 },
  { pattern: /^\/tokens\//, intervalMs: 2500 },
  { pattern: /^\/products\/fees\//, intervalMs: 1200 }
]);
const DEFAULT_SP_API_INTERVAL_MS = 1500;
const rateLimitState = new Map();

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
  const nextAvailableAt = rateLimitState.get(key) ?? now;
  const waitMs = Math.max(0, nextAvailableAt - now);
  rateLimitState.set(key, now + waitMs + intervalMs);
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
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await waitForSpApiSlot(path);
      const res = await fetch(`${this.cfg.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-amz-access-token': accessToken, ...(init.headers ?? {}) }
      });
      const rateLimit = Number(res.headers.get('x-amzn-RateLimit-Limit') ?? '1');
      if (![429, 503].includes(res.status)) return res;
      await new Promise(resolve => setTimeout(resolve, Math.min(30_000, (1000 / Math.max(rateLimit, 0.1)) * 2 ** attempt)));
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
    const parsedRange = DateRangeSchema.parse(range);
    const parsedTenant = z.string().uuid().parse(tenantId);
    const createReportBody = { reportType: parsedReportType, marketplaceIds: [marketplaceId], dataStartTime: parsedRange.start, dataEndTime: parsedRange.end };
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
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const poll = await this.request(`/reports/2021-06-30/reports/${reportId}`);
      if (!poll.ok) throw new Error(`Poll report failed: ${poll.status}`);
      const body = z.object({ processingStatus: z.string(), reportDocumentId: z.string().optional() }).parse(await poll.json());
      if (body.processingStatus === 'DONE' && body.reportDocumentId) {
        reportDocumentId = body.reportDocumentId;
        break;
      }
      if (['CANCELLED', 'FATAL'].includes(body.processingStatus)) throw new Error(`Report ${reportId} ${body.processingStatus}`);
      await new Promise(resolve => setTimeout(resolve, 30_000));
    }
    if (!reportDocumentId) throw new Error(`Report ${reportId} timed out for tenant ${parsedTenant}`);

    const documentToken = GST_REPORTS.has(parsedReportType) ? await this.restrictedDataToken(reportDocumentId) : undefined;
    const document = await this.request(`/reports/2021-06-30/documents/${reportDocumentId}`, {}, documentToken);
    if (!document.ok) throw new Error(`Document lookup failed: ${document.status}`);
    const { url, compressionAlgorithm } = z.object({ url: z.string().url(), compressionAlgorithm: z.string().optional() }).parse(await document.json());
    const download = await fetch(url);
    if (!download.ok) throw new Error(`Document download failed: ${download.status}`);
    const buffer = Buffer.from(await download.arrayBuffer());
    let content = buffer.toString('utf8');
    if (compressionAlgorithm === 'GZIP') {
      try { content = gunzipSync(buffer).toString('utf8'); } catch { content = buffer.toString('utf8'); }
    }
    return { reportId, reportDocumentId, content, compressionAlgorithm };
  }

  /** @param {string} sellerSku @param {unknown} body */
  async estimateListingFees(sellerSku, body) {
    const sku = z.string().min(1).parse(sellerSku);
    const res = await this.request(`/products/fees/v0/listings/${encodeURIComponent(sku)}/feesEstimate`, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Fees estimate failed: ${res.status}`);
    return res.json();
  }

  /** @param {string} createdAfter @param {string} [marketplaceId] */
  async listOrders(createdAfter, marketplaceId = INDIA_MARKETPLACE_ID) {
    const date = z.string().datetime().parse(createdAfter);
    const res = await this.request(`/orders/v0/orders?MarketplaceIds=${marketplaceId}&CreatedAfter=${encodeURIComponent(date)}`);
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


  /** @param {string} [marketplaceId] */
  async listInventorySummaries(marketplaceId = INDIA_MARKETPLACE_ID) {
    const res = await this.request(`/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${encodeURIComponent(marketplaceId)}&marketplaceIds=${encodeURIComponent(marketplaceId)}`);
    if (!res.ok) throw new Error(`Inventory summaries failed: ${res.status}`);
    return res.json();
  }

  /** @param {string} postedAfter */
  async listFinanceTransactions(postedAfter) {
    const date = z.string().datetime().parse(postedAfter);
    const res = await this.request(`/finances/2024-06-19/transactions?postedAfter=${encodeURIComponent(date)}`);
    if (!res.ok) throw new Error(`Finance transactions failed: ${res.status}`);
    return res.json();
  }
}
