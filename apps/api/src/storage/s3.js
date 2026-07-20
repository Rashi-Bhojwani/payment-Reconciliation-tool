import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { secrets } from '../config/secrets.js';

const s3 = new S3Client({ region: secrets.s3Region });
const RawReportSchema = z.object({ tenantId: z.string().uuid(), reportType: z.string().min(1), reportId: z.string().min(1), content: z.string() });

/** @param {string} value */
function safePathSegment(value) { return value.replace(/[^a-zA-Z0-9._=-]/g, '_'); }

/** @param {{ tenantId: string, reportType: string, reportId: string, content: string }} params */
async function putLocalRawReport(params) {
  const dir = path.resolve(process.cwd(), secrets.localReportDir, params.tenantId, safePathSegment(params.reportType));
  await mkdir(dir, { recursive: true });
  const fileName = `${safePathSegment(params.reportId)}-${Date.now()}.txt`;
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, params.content, 'utf8');
  return `local://${path.relative(process.cwd(), filePath)}`;
}

/** @param {{ tenantId: string, reportType: string, reportId: string, content: string }} params */
export async function putRawReport(params) {
  const parsed = RawReportSchema.parse(params);
  const key = `raw-reports/${parsed.tenantId}/${parsed.reportType}/${parsed.reportId}-${Date.now()}.txt`;
  if (!secrets.s3Bucket || secrets.s3Bucket === 'HEHE') return putLocalRawReport(parsed);
  try {
    await s3.send(new PutObjectCommand({ Bucket: secrets.s3Bucket, Key: key, Body: parsed.content, ContentType: 'text/plain; charset=utf-8' }));
    return key;
  } catch {
    return putLocalRawReport(parsed);
  }
}
