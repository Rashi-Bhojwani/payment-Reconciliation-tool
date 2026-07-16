import cron from 'node-cron';
import pLimit from 'p-limit';
import { z } from 'zod';
import { assertActiveTenant, pool, withTenant } from '@recon/db';
import { REPORT_TYPES, SpApiClient } from '@recon/sp-api-client';
import { decryptSecret } from '../config/crypto.js';
import { putRawReport } from '../storage/s3.js';
import { runJob } from './runner.js';

const NIGHTLY_REPORTS = [...REPORT_TYPES];
const SyncParamsSchema = z.object({ tenantId: z.string().uuid(), reportType: z.enum(REPORT_TYPES), range: z.object({ start: z.string().datetime(), end: z.string().datetime() }).optional() });
const SettlementRowSchema = z.record(z.string(), z.string().optional());

/** @param {string} text @returns {Array<Record<string,string|undefined>>} */
function parseTsv(text) {
  const trimmed = z.string().parse(text).trim();
  if (!trimmed) return [];
  const [headerLine, ...lines] = trimmed.split(/\r?\n/);
  const headers = headerLine.split('\t');
  return lines.map(line => Object.fromEntries(line.split('\t').map((value, index) => [headers[index], value])));
}

/** @param {string} tenantId @param {string} content */
async function saveSettlementRows(tenantId, content) {
  const rows = z.array(SettlementRowSchema).parse(parseTsv(content));
  await withTenant(tenantId, async client => {
    for (const row of rows) {
      const amount = z.coerce.number().default(0).parse(row.amount);
      await client.query(
        `insert into settlement_rows(tenant_id, settlement_id, order_id, amount_type, amount_description, amount, posted_date, raw)
         values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
        [tenantId, row['settlement-id'], row['order-id'], row['amount-type'], row['amount-description'], amount, row['posted-date'] || null, row]
      );
    }
  });
  return rows.length;
}

/** @param {{ tenantId: string, reportType: string, range?: { start: string, end: string } }} params */
export async function syncReportForTenant(params) {
  const parsed = SyncParamsSchema.parse(params);
  const range = parsed.range ?? { start: new Date(Date.now() - 30 * 864e5).toISOString(), end: new Date().toISOString() };
  await assertActiveTenant(parsed.tenantId);
  return runJob(`sync:${parsed.reportType}:${parsed.tenantId}`, async () => {
    const sync = await pool.query('insert into sync_jobs(tenant_id, report_type, status, started_at) values($1,$2,$3,now()) returning id', [parsed.tenantId, parsed.reportType, 'running']);
    try {
      const seller = await pool.query('select refresh_token_encrypted, marketplace_id from sellers where tenant_id = $1 limit 1', [parsed.tenantId]);
      if (!seller.rowCount) throw new Error('No connected Amazon seller account');
      const client = new SpApiClient(decryptSecret(seller.rows[0].refresh_token_encrypted));
      const report = await client.fetchReport(parsed.reportType, parsed.tenantId, range, seller.rows[0].marketplace_id);
      const s3Key = await putRawReport({ tenantId: parsed.tenantId, reportType: parsed.reportType, reportId: report.reportId, content: report.content });
      const rowsImported = parsed.reportType === 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2' ? await saveSettlementRows(parsed.tenantId, report.content) : 0;
      await pool.query('update sync_jobs set status=$1, completed_at=now(), s3_key=$2 where id=$3', ['completed', s3Key, sync.rows[0].id]);
      return { rowsImported, s3Key };
    } catch (error) {
      await pool.query('update sync_jobs set status=$1, completed_at=now(), error_message=$2 where id=$3', ['failed', error instanceof Error ? error.message : 'unknown error', sync.rows[0].id]);
      throw error;
    }
  });
}

/** @param {string} reportType */
async function syncActiveTenants(reportType) {
  const parsedReportType = z.enum(REPORT_TYPES).parse(reportType);
  const tenants = await pool.query("select id from tenants where status = 'active'");
  const limit = pLimit(3);
  await Promise.all(tenants.rows.map(row => limit(() => syncReportForTenant({ tenantId: row.id, reportType: parsedReportType }))));
}

export function startScheduler() {
  cron.schedule('0 2 * * *', () => { void Promise.all(NIGHTLY_REPORTS.map(reportType => syncActiveTenants(reportType))); });
  cron.schedule('0 * * * *', () => { void runJob('hourly-finances-placeholder', async () => undefined); });
}
