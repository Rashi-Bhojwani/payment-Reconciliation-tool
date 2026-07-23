import dotenv from 'dotenv';
dotenv.config();

export const secrets = {
  lwaClientId: process.env.LWA_CLIENT_ID ?? '',
  lwaClientSecret: process.env.LWA_CLIENT_SECRET ?? '',
  spApiAppId: process.env.SP_API_APP_ID ?? '',
  redirectUri: process.env.SP_API_REDIRECT_URI ?? '',
  publicApiOrigin: process.env.PUBLIC_API_ORIGIN ?? process.env.API_PUBLIC_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me',
  tokenEncryptionKey: process.env.SESSION_SECRET ?? 'dev-only-change-me',
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  s3Bucket: process.env.S3_BUCKET ?? '',
  s3Region: process.env.S3_REGION ?? 'ap-south-1',
  localReportDir: process.env.LOCAL_REPORT_DIR ?? 'storage/raw-reports'
};
