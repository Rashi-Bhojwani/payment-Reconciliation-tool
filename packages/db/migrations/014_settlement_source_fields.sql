ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS transaction_type text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS shipment_id text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS marketplace_name text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS settlement_start_date timestamptz;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS settlement_end_date timestamptz;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS deposit_date timestamptz;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS header_total_minor bigint;
CREATE INDEX IF NOT EXISTS settlement_rows_tenant_deposit_idx ON settlement_rows(tenant_id,deposit_date) WHERE deposit_date IS NOT NULL;
