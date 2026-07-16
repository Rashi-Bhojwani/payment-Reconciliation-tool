import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { secrets } from '../config/secrets.js';

const s3 = new S3Client({ region: secrets.s3Region });
const RawReportSchema = z.object({ tenantId: z.string().uuid(), reportType: z.string().min(1), reportId: z.string().min(1), content: z.string() });

/** @param {{ tenantId: string, reportType: string, reportId: string, content: string }} params */
export async function putRawReport(params) {
  const parsed = RawReportSchema.parse(params);
  if (!secrets.s3Bucket || secrets.s3Bucket === 'HEHE') {
    throw new Error('S3_BUCKET must point to a real AWS S3 bucket before syncing reports');
  }
  const key = `raw-reports/${parsed.tenantId}/${parsed.reportType}/${parsed.reportId}-${Date.now()}.txt`;
  await s3.send(new PutObjectCommand({ Bucket: secrets.s3Bucket, Key: key, Body: parsed.content, ContentType: 'text/plain; charset=utf-8' }));
  return key;
}
