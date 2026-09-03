// The scheduling tool's config surface, backed by this platform's environment
// instead of its own.
//
// Every ported file under this package imports `config` and reads the same
// handful of paths it always did (config.spapi.clientId, config.crypto.key,
// and so on). Keeping that shape means none of those files had to change:
// this is the single adapter between two environments, rather than an edit
// scattered across forty of them.
//
// It also deliberately does NOT introduce a parallel set of Amazon
// credentials. Both applications talk to the same SP-API application on
// behalf of the same seller, so they read the same LWA_CLIENT_ID /
// LWA_CLIENT_SECRET / SP_API_APP_ID / SP_API_REDIRECT_URI the reconciliation
// side already uses. Two copies of one credential is two things to rotate and
// one of them to forget.
import crypto from 'node:crypto';
import { secrets } from '../../../apps/api/src/config/secrets.js';

const env = process.env.NODE_ENV ?? 'development';

// The standalone tool required ENCRYPTION_KEY: 32 raw bytes, base64. This
// platform has never had one - it derives its token key from SESSION_SECRET.
// Both are honoured, in that order, for a specific reason: an operator who
// already ran the standalone scheduler has marketplace credentials encrypted
// under ENCRYPTION_KEY, and silently deriving a different key would turn
// every one of those rows into an undecryptable blob with no error until
// something tried to use it. Set ENCRYPTION_KEY to carry that data over;
// leave it unset on a fresh install and one secret covers everything.
function resolveEncryptionKey() {
  const provided = process.env.ENCRYPTION_KEY;
  if (provided) {
    const raw = Buffer.from(provided, 'base64');
    if (raw.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be exactly 32 bytes when base64-decoded. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    }
    return provided;
  }
  // Same derivation the reconciliation side uses for its own token
  // encryption, so a deployment that never sets ENCRYPTION_KEY still gets a
  // real 32-byte key rather than a padded passphrase.
  return crypto.createHash('sha256').update(secrets.tokenEncryptionKey).digest('base64');
}

const positiveInt = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  env,
  isProduction: env === 'production',
  logLevel: process.env.LOG_LEVEL ?? (env === 'production' ? 'info' : 'debug'),

  db: {
    url: process.env.DATABASE_URL ?? '',
    ssl: process.env.DATABASE_SSL === 'true' || process.env.DATABASE_SSL === '1',
    poolMax: positiveInt('SCHEDULING_POOL_MAX', 5)
  },

  crypto: {
    key: resolveEncryptionKey(),
    keyVersion: positiveInt('ENCRYPTION_KEY_VERSION', 1)
  },

  // Only used to sign single-use OAuth state tokens, which is what the
  // standalone tool used its session secret for too.
  session: { secret: secrets.jwtSecret },

  spapi: {
    appId: secrets.spApiAppId,
    clientId: secrets.lwaClientId,
    clientSecret: secrets.lwaClientSecret,
    redirectUri: secrets.redirectUri,
    configured: Boolean(secrets.lwaClientId && secrets.lwaClientSecret && secrets.spApiAppId),
    // A draft (unpublished) SP-API application must send version=beta on the
    // consent URL or Amazon rejects the authorization outright.
    draftApp: process.env.SP_API_DRAFT_APP === 'true' || process.env.SP_API_DRAFT_APP === '1'
  },

  marketplace: {
    defaultTimezone: process.env.MARKETPLACE_DEFAULT_TIMEZONE ?? 'Asia/Kolkata'
  }
};

export default config;
