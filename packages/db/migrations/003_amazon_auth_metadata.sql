ALTER TABLE sellers ADD COLUMN IF NOT EXISTS seller_name text;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS seller_central_region text NOT NULL DEFAULT 'IN';
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS auth_status text NOT NULL DEFAULT 'authorized' CHECK (auth_status IN ('authorized','revoked','expired'));
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS last_token_refresh_at timestamptz;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sellers_tenant_auth_status ON sellers(tenant_id, auth_status, connected_at DESC);
