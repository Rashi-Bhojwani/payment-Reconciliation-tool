import { gunzipSync } from 'node:zlib';
import { z } from 'zod';

export const SP_API_BASE_URL = 'https://sellingpartnerapi-eu.amazon.com';
export const INDIA_MARKETPLACE_ID = 'A21TJRUUN4KGV';
export const MARKETPLACES = Object.freeze({
  A21TJRUUN4KGV: { country: 'India', region: 'IN', timeZone: 'Asia/Kolkata', endpoint: 'https://sellingpartnerapi-eu.amazon.com', sellerCentralHost: 'sellercentral.amazon.in' },
  ATVPDKIKX0DER: { country: 'United States', region: 'NA', timeZone: 'America/Los_Angeles', endpoint: 'https://sellingpartnerapi-na.amazon.com', sellerCentralHost: 'sellercentral.amazon.com' },
  A1F83G8C2ARO7P: { country: 'United Kingdom', region: 'EU', timeZone: 'Europe/London', endpoint: 'https://sellingpartnerapi-eu.amazon.com', sellerCentralHost: 'sellercentral.amazon.co.uk' }
});

export function getSpApiEndpoint(marketplaceId = INDIA_MARKETPLACE_ID) {
  return MARKETPLACES[marketplaceId]?.endpoint ?? SP_API_BASE_URL;
}

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
const REPORT_POLL_INTERVAL_MS = Number(process.env.SP_API_REPORT_POLL_INTERVAL_MS ?? 15_000);
const REPORT_POLL_ATTEMPTS = Number(process.env.SP_API_REPORT_POLL_ATTEMPTS ?? 40);
const REQUEST_TIMEOUT_MS = Number(process.env.SP_API_REQUEST_TIMEOUT_MS ?? 30_000);

export class SpApiError extends Error {
  constructor(message, { status, code, details, requestId, path } = {}) {
    super(message);
    this.name = 'SpApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.path = path;
  }
}

/**
 * The UI supplies a half-open interval. Cap it at Amazon's latest safe data
 * boundary while keeping that half-open contract for calculations and coverage.
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

function dateInTimeZone(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const part = name => parts.find(item => item.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Sales & Traffic accepts date components and treats dataEndTime as inclusive.
 * Convert the app's exclusive end to the previous marketplace calendar date.
 */
export function reportRequestRange(reportType, range, marketplaceId = INDIA_MARKETPLACE_ID, now = Date.now()) {
  const normalized = normalizeReportRange(range, now);
  if (reportType !== 'GET_SALES_AND_TRAFFIC_REPORT') return normalized;
  const timeZone = MARKETPLACES[marketplaceId]?.timeZone ?? 'UTC';
  const inclusiveEnd = new Date(new Date(normalized.end).getTime() - 1);
  return {
    start: dateInTimeZone(new Date(normalized.start), timeZone),
    end: dateInTimeZone(inclusiveEnd, timeZone),
    coverageStart: normalized.start,
    coverageEnd: normalized.end
  };
}

export function completedReportCoversRequest(reportType, requestRange, reportedStart, reportedEnd, marketplaceId = INDIA_MARKETPLACE_ID) {
  if (!reportedStart || !reportedEnd) return false;
  if (reportType === 'GET_SALES_AND_TRAFFIC_REPORT' || GST_REPORTS.has(reportType)) {
    const timeZone = MARKETPLACES[marketplaceId]?.timeZone ?? 'UTC';
    const requestStart = requestRange.coverageStart ?? requestRange.start;
    const requestEnd = requestRange.coverageEnd ?? requestRange.end;
    const requestedStartDate = !Number.isNaN(new Date(requestStart).getTime())
      ? dateInTimeZone(new Date(requestStart), timeZone)
      : String(requestRange.start).slice(0, 10);
    const requestedEndDate = !Number.isNaN(new Date(requestEnd).getTime())
      ? dateInTimeZone(new Date(new Date(requestEnd).getTime() - 1), timeZone)
      : String(requestRange.end).slice(0, 10);
    return (
      String(reportedStart).slice(0, 10) <= String(requestRange.start).slice(0, 10)
      && String(reportedEnd).slice(0, 10) >= String(requestRange.end).slice(0, 10)
    ) || (
      String(reportedStart).slice(0, 10) <= requestedStartDate
      && String(reportedEnd).slice(0, 10) >= requestedEndDate
    );
  }
  const actualStart = new Date(reportedStart).getTime();
  const actualEnd = new Date(reportedEnd).getTime();
  return Number.isFinite(actualStart)
    && Number.isFinite(actualEnd)
    && actualStart <= new Date(requestRange.start).getTime()
    && actualEnd >= new Date(requestRange.end).getTime();
}

const SP_API_RATE_LIMITS = Object.freeze([
  { pattern: /^\/orders\//, intervalMs: 2_200 },
  { pattern: /^\/reports\//, intervalMs: 5_000 },
  { pattern: /^\/finances\//, intervalMs: 5_000 },
  { pattern: /^\/fba\/inventory\//, intervalMs: 5_000 },
  { pattern: /^\/tokens\//, intervalMs: 5_000 },
  { pattern: /^\/products\/fees\//, intervalMs: 2_200 },
  { pattern: /^\/catalog\//, intervalMs: 2_200 }
]);
const DEFAULT_SP_API_INTERVAL_MS = 3_000;
const rateLimitState = new Map();
let globalNextAvailableAt = Date.now();

function rateLimitBucket(path) {
  const limit = SP_API_RATE_LIMITS.find(item => item.pattern.test(path));
  const family = path.split('/').filter(Boolean)[0] ?? 'default';
  return { key: family, intervalMs: limit?.intervalMs ?? DEFAULT_SP_API_INTERVAL_MS };
}

async function waitForSpApiSlot(path) {
  const { key, intervalMs } = rateLimitBucket(path);
  const now = Date.now();
  const nextAvailableAt = Math.max(rateLimitState.get(key) ?? now, globalNextAvailableAt);
  const waitMs = Math.max(0, nextAvailableAt - now);
  rateLimitState.set(key, now + waitMs + intervalMs);
  globalNextAvailableAt = now + waitMs + 750;
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
}

function queryPath(path, values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value == null || value === '') continue;
    query.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

async function responseError(response, path) {
  const requestId = response.headers.get('x-amzn-requestid') ?? response.headers.get('x-amz-request-id');
  const raw = await response.text().catch(() => '');
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { message: raw }; }
  const first = body?.errors?.[0] ?? body?.error ?? body;
  return new SpApiError(
    first?.message ?? `SP-API request failed with HTTP ${response.status}`,
    {
      status: response.status,
      code: first?.code,
      details: first?.details ?? body,
      requestId,
      path
    }
  );
}

function responsePayload(body) {
  return body?.payload ?? body;
}

export class SpApiClient {
  constructor(refreshToken, cfg = {}) {
    this.refreshToken = z.string().min(1).parse(refreshToken);
    const clientId = cfg.clientId ?? process.env.LWA_CLIENT_ID;
    const clientSecret = cfg.clientSecret ?? process.env.LWA_CLIENT_SECRET;
    if (!clientId || !clientSecret || clientId === 'HEHE' || clientSecret === 'HEHE') {
      throw new SpApiError('LWA_CLIENT_ID and LWA_CLIENT_SECRET are not configured', { code: 'SP_API_CONFIGURATION' });
    }
    this.cfg = {
      clientId,
      clientSecret,
      baseUrl: cfg.baseUrl ?? SP_API_BASE_URL
    };
    this.cachedToken = null;
  }

  async getAccessToken() {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60_000) return this.cachedToken;
    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.cfg.clientId ?? '',
        client_secret: this.cfg.clientSecret ?? ''
      })
    });
    if (!response.ok) throw await responseError(response, '/auth/o2/token');
    const body = z.object({
      access_token: z.string().min(1),
      expires_in: z.number().default(3600)
    }).parse(await response.json());
    this.cachedToken = {
      accessToken: body.access_token,
      expiresIn: body.expires_in,
      expiresAt: Date.now() + body.expires_in * 1000
    };
    return this.cachedToken;
  }

  async request(path, init = {}, restrictedToken) {
    let accessToken = restrictedToken ?? (await this.getAccessToken()).accessToken;
    let lastResponse;
    let lastNetworkError;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await waitForSpApiSlot(path);
      let response;
      try {
        response = await fetch(`${this.cfg.baseUrl}${path}`, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
            'x-amz-access-token': accessToken,
            ...(init.headers ?? {})
          }
        });
      } catch (error) {
        lastNetworkError = error;
        if (attempt === 5) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** attempt)));
        continue;
      }
      lastResponse = response;

      if (response.status === 401 && !restrictedToken && attempt === 0) {
        this.cachedToken = null;
        accessToken = (await this.getAccessToken()).accessToken;
        continue;
      }
      if (![429, 500, 502, 503, 504].includes(response.status)) return response;

      const rateLimit = Number(response.headers.get('x-amzn-RateLimit-Limit') ?? '0.5');
      const retryAfter = Number(response.headers.get('retry-after'));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : (1_000 / Math.max(rateLimit, 0.05)) * 2 ** attempt;
      await new Promise(resolve => setTimeout(resolve, Math.min(60_000, backoffMs)));
    }
    if (lastResponse) throw await responseError(lastResponse, path);
    throw new SpApiError(
      `SP-API network request failed after retries: ${lastNetworkError instanceof Error ? lastNetworkError.message : 'unknown network error'}`,
      { code: 'NETWORK_ERROR', details: lastNetworkError, path }
    );
  }

  async json(path, init = {}, restrictedToken) {
    const response = await this.request(path, init, restrictedToken);
    if (!response.ok) throw await responseError(response, path);
    return response.json();
  }

  async restrictedDataToken(documentId) {
    const id = z.string().min(1).parse(documentId);
    const path = `/reports/2021-06-30/documents/${encodeURIComponent(id)}`;
    const body = responsePayload(await this.json('/tokens/2021-03-01/restrictedDataToken', {
      method: 'POST',
      // dataElements is valid only for restricted Orders resources. A report
      // document RDT needs the exact method and path only.
      body: JSON.stringify({ restrictedResources: [{ method: 'GET', path }] })
    }));
    return z.object({ restrictedDataToken: z.string().min(1) }).parse(body).restrictedDataToken;
  }

  async listReports(query, maxPages = 100) {
    const reports = [];
    let path = queryPath('/reports/2021-06-30/reports', query);
    const seen = new Set();
    let unconsumedNextToken;
    for (let page = 0; page < maxPages; page += 1) {
      const body = responsePayload(await this.json(path));
      reports.push(...(body.reports ?? []));
      const nextToken = body.nextToken;
      unconsumedNextToken = nextToken;
      if (!nextToken) break;
      if (seen.has(nextToken)) break;
      seen.add(nextToken);
      // Reports API requires the next token to be the only query parameter.
      path = queryPath('/reports/2021-06-30/reports', { nextToken });
    }
    return { reports, nextToken: unconsumedNextToken };
  }

  async fetchSettlementReports(range, marketplaceId) {
    const createdSince = new Date(new Date(range.start).getTime() - 30 * 864e5).toISOString();
    const reportListing = await this.listReports({
      reportTypes: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
      processingStatuses: 'DONE',
      marketplaceIds: marketplaceId,
      createdSince,
      pageSize: 100
    });
    if (reportListing.nextToken) {
      throw new SpApiError('Settlement report listing was not completely paginated', {
        code: 'INCOMPLETE_REPORT_LIST'
      });
    }
    const reports = reportListing.reports;
    const requestedStart = new Date(range.start).getTime();
    const requestedEnd = new Date(range.end).getTime();

    const latestByWindow = new Map();
    for (const report of reports) {
      if (!report.reportDocumentId) continue;
      const start = new Date(report.dataStartTime ?? report.createdTime ?? 0).getTime();
      const end = new Date(report.dataEndTime ?? report.createdTime ?? 0).getTime();
      if (!(start < requestedEnd && end >= requestedStart)) continue;
      const key = `${report.dataStartTime ?? ''}|${report.dataEndTime ?? ''}`;
      const previous = latestByWindow.get(key);
      if (!previous || new Date(report.createdTime ?? 0) > new Date(previous.createdTime ?? 0)) {
        latestByWindow.set(key, report);
      }
    }
    const matchingReports = [...latestByWindow.values()].sort(
      (left, right) => new Date(left.dataStartTime ?? 0) - new Date(right.dataStartTime ?? 0)
    );
    if (!matchingReports.length) {
      throw new SpApiError('No completed Amazon settlement report overlaps this date range yet', { code: 'NO_SETTLEMENT_REPORT' });
    }

    const documents = [];
    for (const report of matchingReports) {
      documents.push({ report, ...(await this.downloadReportDocument(report.reportDocumentId)) });
    }
    const content = documents
      .map((document, index) => index === 0 ? document.content : document.content.split(/\r?\n/).slice(1).join('\n'))
      .filter(Boolean)
      .join('\n');
    const coverageStart = Math.min(...matchingReports.map(report => new Date(report.dataStartTime ?? range.start).getTime()));
    const coverageEnd = Math.max(...matchingReports.map(report => new Date(report.dataEndTime ?? range.end).getTime()));
    let coverageCursor = requestedStart;
    let coverageComplete = true;
    for (const report of matchingReports) {
      if (!report.dataStartTime || !report.dataEndTime) {
        coverageComplete = false;
        continue;
      }
      const reportStart = new Date(report.dataStartTime).getTime();
      const reportEnd = new Date(report.dataEndTime).getTime();
      if (reportEnd < coverageCursor) continue;
      if (reportStart > coverageCursor) {
        coverageComplete = false;
        break;
      }
      coverageCursor = Math.max(coverageCursor, reportEnd);
      if (coverageCursor >= requestedEnd) break;
    }
    coverageComplete = coverageComplete && coverageCursor >= requestedEnd;
    return {
      reportId: matchingReports.map(report => report.reportId).join(','),
      reportDocumentId: matchingReports.map(report => report.reportDocumentId).join(','),
      sourceReports: matchingReports,
      content,
      compressionAlgorithm: matchingReports.length > 1 ? 'MERGED_SETTLEMENT_REPORTS' : documents[0].compressionAlgorithm,
      reportsMerged: matchingReports.length,
      dataStartTime: new Date(coverageStart).toISOString(),
      dataEndTime: new Date(coverageEnd).toISOString(),
      coverageComplete
    };
  }

  async fetchReport(reportType, tenantId, range, marketplaceId = INDIA_MARKETPLACE_ID) {
    const parsedReportType = z.enum(REPORT_TYPES).parse(reportType);
    const applicationRange = normalizeReportRange(range);
    const requestRange = reportRequestRange(parsedReportType, range, marketplaceId);
    const parsedTenant = z.string().uuid().parse(tenantId);
    if (parsedReportType === 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2') {
      return this.fetchSettlementReports(applicationRange, marketplaceId);
    }

    const reportOptions = parsedReportType === 'GET_SALES_AND_TRAFFIC_REPORT'
      ? { dateGranularity: 'DAY', asinGranularity: 'CHILD' }
      : undefined;
    const createBody = {
      reportType: parsedReportType,
      marketplaceIds: [marketplaceId],
      dataStartTime: requestRange.start,
      dataEndTime: requestRange.end,
      ...(reportOptions ? { reportOptions } : {})
    };
    const create = responsePayload(await this.json('/reports/2021-06-30/reports', {
      method: 'POST',
      body: JSON.stringify(createBody)
    }));
    const { reportId } = z.object({ reportId: z.string().min(1) }).parse(create);

    let reportDocumentId = '';
    let reportedDataStartTime;
    let reportedDataEndTime;
    let cancelledNoData = false;
    for (let attempt = 0; attempt < REPORT_POLL_ATTEMPTS; attempt += 1) {
      const body = z.object({
        processingStatus: z.string(),
        reportDocumentId: z.string().optional(),
        dataStartTime: z.string().optional(),
        dataEndTime: z.string().optional()
      }).parse(responsePayload(await this.json(`/reports/2021-06-30/reports/${reportId}`)));
      reportedDataStartTime = body.dataStartTime ?? reportedDataStartTime;
      reportedDataEndTime = body.dataEndTime ?? reportedDataEndTime;
      if (body.processingStatus === 'DONE' && body.reportDocumentId) {
        reportDocumentId = body.reportDocumentId;
        break;
      }
      // Amazon uses CANCELLED when a report has no rows to generate (a normal
      // result for new or low-volume sellers). Treat that as a successful,
      // empty report so callers can finish the sync without inventing data.
      if (body.processingStatus === 'CANCELLED') {
        return { reportId, reportDocumentId: null, content: '', empty: true, processingStatus: body.processingStatus, dataStartTime: applicationRange.start, dataEndTime: applicationRange.end, reportedDataStartTime, reportedDataEndTime, coverageComplete: true, cancelledNoData: true };
      }
      if (body.processingStatus === 'FATAL') throw new Error(`Report ${reportId} ${body.processingStatus}`);
      await new Promise(resolve => setTimeout(resolve, REPORT_POLL_INTERVAL_MS));
    }
    if (!reportDocumentId && !cancelledNoData) {
      throw new SpApiError(`Report ${reportId} timed out for tenant ${parsedTenant}`, { code: 'REPORT_TIMEOUT' });
    }

    const downloaded = cancelledNoData
      ? { content: '', compressionAlgorithm: undefined }
      : await this.downloadReportDocument(
        reportDocumentId,
        GST_REPORTS.has(parsedReportType) ? await this.restrictedDataToken(reportDocumentId) : undefined
      );

    return {
      reportId,
      reportDocumentId: reportDocumentId || null,
      ...downloaded,
      dataStartTime: applicationRange.start,
      dataEndTime: applicationRange.end,
      reportedDataStartTime,
      reportedDataEndTime,
      coverageComplete: cancelledNoData || completedReportCoversRequest(
        parsedReportType,
        requestRange,
        reportedDataStartTime,
        reportedDataEndTime,
        marketplaceId
      ),
      cancelledNoData
    };
  }

  async downloadReportDocument(reportDocumentId, restrictedToken) {
    const id = z.string().min(1).parse(reportDocumentId);
    const document = responsePayload(await this.json(
      `/reports/2021-06-30/documents/${encodeURIComponent(id)}`,
      {},
      restrictedToken
    ));
    const { url, compressionAlgorithm } = z.object({
      url: z.string().url(),
      compressionAlgorithm: z.string().optional()
    }).parse(document);
    const download = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4) });
    if (!download.ok) throw await responseError(download, url);
    const buffer = Buffer.from(await download.arrayBuffer());
    const content = compressionAlgorithm === 'GZIP'
      ? gunzipSync(buffer).toString('utf8')
      : buffer.toString('utf8');
    return { content, compressionAlgorithm };
  }

  async estimateListingFees(sellerSku, body) {
    const sku = z.string().min(1).parse(sellerSku);
    return this.json(
      `/products/fees/v0/listings/${encodeURIComponent(sku)}/feesEstimate`,
      { method: 'POST', body: JSON.stringify(body) }
    );
  }

  /**
   * Orders v2026-01-01 includes order items in each result. Every pagination
   * request retains the original filters as required by Amazon.
   */
  async searchOrders(options) {
    const schema = z.object({
      marketplaceId: z.string().min(1),
      createdAfter: z.string().datetime().optional(),
      createdBefore: z.string().datetime().optional(),
      lastUpdatedAfter: z.string().datetime().optional(),
      lastUpdatedBefore: z.string().datetime().optional(),
      maxPages: z.number().int().min(1).max(100).default(100)
    }).refine(value => Boolean(value.createdAfter) !== Boolean(value.lastUpdatedAfter), {
      message: 'Provide exactly one of createdAfter and lastUpdatedAfter'
    });
    const parsed = schema.parse(options);
    const parameters = {
      marketplaceIds: parsed.marketplaceId,
      createdAfter: parsed.createdAfter,
      createdBefore: parsed.createdBefore,
      lastUpdatedAfter: parsed.lastUpdatedAfter,
      lastUpdatedBefore: parsed.lastUpdatedBefore,
      maxResultsPerPage: 100,
      includedData: ['PROCEEDS', 'PROMOTION', 'FULFILLMENT', 'TAX']
    };
    const orders = [];
    const seen = new Set();
    let nextToken;
    let pagesFetched = 0;
    for (let page = 0; page < parsed.maxPages; page += 1) {
      const body = responsePayload(await this.json(queryPath('/orders/2026-01-01/orders', {
        ...parameters,
        paginationToken: nextToken
      })));
      orders.push(...(body.orders ?? []));
      pagesFetched += 1;
      nextToken = body.pagination?.nextToken ?? body.nextToken;
      if (!nextToken || seen.has(nextToken)) break;
      seen.add(nextToken);
    }
    return { orders, pagesFetched, nextToken };
  }

  async getOrder(orderId, includedData = ['PROCEEDS', 'PROMOTION', 'FULFILLMENT', 'TAX']) {
    const id = z.string().min(1).parse(orderId);
    return responsePayload(await this.json(queryPath(
      `/orders/2026-01-01/orders/${encodeURIComponent(id)}`,
      { includedData }
    )));
  }

  async getCatalogItem(asin, marketplaceId = INDIA_MARKETPLACE_ID) {
    const parsedAsin = z.string().min(1).parse(asin);
    const path = queryPath(`/catalog/2022-04-01/items/${encodeURIComponent(parsedAsin)}`, {
      marketplaceIds: marketplaceId,
      includedData: 'attributes,dimensions,productTypes,summaries,classifications'
    });
    const raw = await this.json(path);
    const category = raw?.summaries?.[0]?.websiteDisplayGroup
      ?? raw?.classifications?.[0]?.classifications?.[0]?.displayName
      ?? raw?.productTypes?.[0]?.productType
      ?? null;
    const weightNode = raw?.dimensions?.[0]?.package?.weight ?? raw?.dimensions?.[0]?.item?.weight ?? null;
    return { ...raw, category, weightNode, raw };
  }

  async listInventorySummaries(marketplaceId = INDIA_MARKETPLACE_ID, maxPages = 100) {
    const base = {
      details: true,
      granularityType: 'Marketplace',
      granularityId: marketplaceId,
      marketplaceIds: marketplaceId
    };
    const inventorySummaries = [];
    const seen = new Set();
    let nextToken;
    let pagesFetched = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const body = responsePayload(await this.json(queryPath('/fba/inventory/v1/summaries', {
        ...base,
        nextToken
      })));
      inventorySummaries.push(...(body.inventorySummaries ?? []));
      pagesFetched += 1;
      nextToken = body.pagination?.nextToken ?? body.nextToken;
      if (!nextToken || seen.has(nextToken)) break;
      seen.add(nextToken);
    }
    return { inventorySummaries, pagesFetched, nextToken };
  }

  async listFinanceTransactions(postedAfter, postedBefore, nextToken) {
    const after = z.string().datetime().parse(postedAfter);
    const before = postedBefore ? z.string().datetime().parse(postedBefore) : undefined;
    const path = queryPath('/finances/2024-06-19/transactions', {
      postedAfter: after,
      postedBefore: before,
      nextToken
    });
    return this.json(path);
  }

  async listAllFinanceTransactions(postedAfter, postedBefore, maxPages = 100) {
    const start = new Date(z.string().datetime().parse(postedAfter));
    const end = new Date(z.string().datetime().parse(postedBefore));
    if (start >= end) throw new Error('Finance transaction range must start before it ends');
    const transactions = [];
    let pagesFetched = 0;
    let unconsumedNextToken;
    // listTransactions accepts at most 180 days. Use 179-day half-open
    // windows so long dashboard ranges remain valid without boundary overlap.
    for (let windowStart = start; windowStart < end;) {
      const windowEnd = new Date(Math.min(end.getTime(), windowStart.getTime() + 179 * 864e5));
      const seen = new Set();
      let nextToken;
      for (let page = 0; page < maxPages; page += 1) {
        const body = responsePayload(await this.listFinanceTransactions(
          windowStart.toISOString(),
          windowEnd.toISOString(),
          nextToken
        ));
        transactions.push(...(body.transactions ?? body.Transactions ?? []));
        pagesFetched += 1;
        nextToken = body.nextToken ?? body.NextToken;
        if (!nextToken || seen.has(nextToken)) break;
        seen.add(nextToken);
      }
      if (nextToken) {
        unconsumedNextToken = nextToken;
        break;
      }
      windowStart = windowEnd;
    }
    return { transactions, pagesFetched, nextToken: unconsumedNextToken };
  }
}
