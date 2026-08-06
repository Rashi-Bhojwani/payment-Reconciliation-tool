// Side-effect import: loads .env before anything below reads process.env.
// This used to be `import dotenv from 'dotenv'; dotenv.config();`, which only
// checks process.cwd() and always printed a startup banner ("injected env
// (0) from .env") once @recon/db's own loader (packages/db/src/env.js -
// searches upward from cwd AND from its own directory, so it finds the repo
// root .env from apps/api too, and never overwrites a real value already set)
// started running first via server.js's import order. dotenv correctly found
// nothing left to inject at that point - the (0) was not a sign .env failed
// to load, it was proof the other loader had already succeeded - but it read
// exactly like a failure, so it is worth stopping printing it. This is a
// direct, explicit dependency now instead of relying on which file some
// other entry point happens to import first.
import '@recon/db/env.js';

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
