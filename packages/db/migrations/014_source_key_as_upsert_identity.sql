-- order_items and reimbursements are missing a source_key column entirely
-- (same untracked-drift pattern already found and fixed for
-- finance_transaction_items and settlement_rows/returns) - confirmed live:
-- "null value in column 'source_key' of relation 'order_items'/'reimbursements'
-- violates not-null constraint".
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS source_key text;
UPDATE order_items
SET source_key = encode(digest(coalesce(amazon_order_id,'') || '|' || coalesce(sku,'') || '|' || coalesce(asin,'') || '|' || id::text, 'sha256'), 'hex')
WHERE source_key IS NULL;
ALTER TABLE order_items ALTER COLUMN source_key SET DEFAULT encode(gen_random_bytes(16), 'hex');
ALTER TABLE order_items ALTER COLUMN source_key SET NOT NULL;

ALTER TABLE reimbursements ADD COLUMN IF NOT EXISTS source_key text;
UPDATE reimbursements
SET source_key = encode(digest(coalesce(sku,'') || '|' || coalesce(reimbursement_date::text,'') || '|' || coalesce(amount::text,'') || '|' || coalesce(reason,'') || '|' || id::text, 'sha256'), 'hex')
WHERE source_key IS NULL;
ALTER TABLE reimbursements ALTER COLUMN source_key SET DEFAULT encode(gen_random_bytes(16), 'hex');
ALTER TABLE reimbursements ALTER COLUMN source_key SET NOT NULL;

-- settlement_rows and returns also independently enforce a unique source_key
-- live (confirmed: "duplicate key value violates unique constraint
-- uq_settlement_rows_source_key") even though sync.js's ON CONFLICT target
-- for both is a set of business columns, not source_key. That mismatch is
-- the actual bug: settlement header rows deliberately share NULL order_id/
-- amount_type/amount_description/posted_date across different settlements
-- (Postgres never treats NULL as equal to NULL, so that composite target
-- intentionally never matches them to each other) - but source_key IS fully
-- deterministic per settlement, so re-syncing the exact same settlement a
-- second time inserts a row with an identical source_key that the composite
-- ON CONFLICT clause was never told to watch for, and the *other*, unrelated
-- unique constraint on source_key rejects it outright instead of updating.
--
-- The fix (applied in sync.js alongside this migration) is to make
-- (tenant_id, source_key) the actual ON CONFLICT arbiter for these tables,
-- since source_key is deterministic per logical source row and correctly
-- discriminates rows that share NULL business columns. Dedup first, exactly
-- like migration 013, in case any table's existing source_key values were
-- never actually unique.
DELETE FROM settlement_rows a USING settlement_rows b
WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.source_key = b.source_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_rows_tenant_source_key ON settlement_rows(tenant_id, source_key);

DELETE FROM returns a USING returns b
WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.source_key = b.source_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_returns_tenant_source_key ON returns(tenant_id, source_key);

DELETE FROM order_items a USING order_items b
WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.source_key = b.source_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_items_tenant_source_key ON order_items(tenant_id, source_key);

DELETE FROM reimbursements a USING reimbursements b
WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.source_key = b.source_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_reimbursements_tenant_source_key ON reimbursements(tenant_id, source_key);
