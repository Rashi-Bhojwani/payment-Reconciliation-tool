ALTER TABLE finance_transaction_items ADD COLUMN IF NOT EXISTS source_key text;
UPDATE finance_transaction_items
SET source_key = encode(digest(coalesce(transaction_id,'') || '|' || coalesce(order_id,'') || '|' || coalesce(sku,'') || '|' || coalesce(category,'') || '|' || coalesce(amount_description,'') || '|' || coalesce(amount::text,''), 'sha256'), 'hex')
WHERE source_key IS NULL;
ALTER TABLE finance_transaction_items ALTER COLUMN source_key SET DEFAULT encode(gen_random_bytes(16), 'hex');
ALTER TABLE finance_transaction_items ALTER COLUMN source_key SET NOT NULL;
