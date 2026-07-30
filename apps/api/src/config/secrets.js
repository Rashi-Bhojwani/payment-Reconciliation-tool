import crypto from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config();

const production = process.env.NODE_ENV === 'production';
const configured = value => Boolean(value && value !== 'HEHE');
const runtimeSecret = crypto.randomBytes(32).toString('hex');
const jwtSecretConfigured = configured(process.env.JWT_SECRET);
const encryptionKeyConfigured = configured(process.env.SESSION_SECRET);

if (production && (!jwtSecretConfigured || !encryptionKeyConfigured)) {
  throw new Error('JWT_SECRET and SESSION_SECRET are required in production');
}

export const secrets = {
  lwaClientId: configured(process.env.LWA_CLIENT_ID) ? process.env.LWA_CLIENT_ID : '',
  lwaClientSecret: configured(process.env.LWA_CLIENT_SECRET) ? process.env.LWA_CLIENT_SECRET : '',
  spApiAppId: configured(process.env.SP_API_APP_ID) ? process.env.SP_API_APP_ID : '',
  redirectUri: process.env.SP_API_REDIRECT_URI ?? '',
  publicApiOrigin: process.env.PUBLIC_API_ORIGIN ?? process.env.API_PUBLIC_URL ?? '',
  jwtSecret: jwtSecretConfigured ? process.env.JWT_SECRET : runtimeSecret,
  tokenEncryptionKey: encryptionKeyConfigured ? process.env.SESSION_SECRET : runtimeSecret,
  encryptionKeyConfigured,
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  s3Bucket: process.env.S3_BUCKET ?? '',
  s3Region: process.env.S3_REGION ?? 'ap-south-1',
  localReportDir: process.env.LOCAL_REPORT_DIR ?? 'storage/raw-reports'
};
