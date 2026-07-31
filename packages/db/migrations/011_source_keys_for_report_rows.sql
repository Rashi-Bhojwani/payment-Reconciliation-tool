ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS source_key text;
UPDATE settlement_rows
SET source_key = encode(digest(coalesce(settlement_id,'') || '|' || coalesce(order_id,'') || '|' || coalesce(amount_type,'') || '|' || coalesce(amount_description,'') || '|' || coalesce(posted_date::text,'') || '|' || coalesce(amount::text,''), 'sha256'), 'hex')
WHERE source_key IS NULL;
ALTER TABLE settlement_rows ALTER COLUMN source_key SET DEFAULT encode(gen_random_bytes(16), 'hex');
ALTER TABLE settlement_rows ALTER COLUMN source_key SET NOT NULL;

ALTER TABLE returns ADD COLUMN IF NOT EXISTS source_key text;
UPDATE returns
SET source_key = encode(digest(coalesce(order_id,'') || '|' || coalesce(return_date::text,'') || '|' || coalesce(return_reason,'') || '|' || coalesce(disposition,''), 'sha256'), 'hex')
WHERE source_key IS NULL;
ALTER TABLE returns ALTER COLUMN source_key SET DEFAULT encode(gen_random_bytes(16), 'hex');
ALTER TABLE returns ALTER COLUMN source_key SET NOT NULL;
