import dotenv from 'dotenv';
dotenv.config();

export const secrets = {
  lwaClientId: process.env.LWA_CLIENT_ID ?? '',
  lwaClientSecret: process.env.LWA_CLIENT_SECRET ?? '',
  spApiAppId: process.env.SP_API_APP_ID ?? '',
<<<<<<< HEAD
  redirectUri: process.env.SP_API_REDIRECT_URI,
=======
  redirectUri: process.env.SP_API_REDIRECT_URI ?? 'http://localhost:4000/oauth/callback',
>>>>>>> e8c9d3e5c8273b7c1c4ef93ac3ac209ee23747d6
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me',
  tokenEncryptionKey: process.env.SESSION_SECRET ?? 'dev-only-change-me',
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  s3Bucket: process.env.S3_BUCKET ?? '',
  s3Region: process.env.S3_REGION ?? 'ap-south-1'
};
