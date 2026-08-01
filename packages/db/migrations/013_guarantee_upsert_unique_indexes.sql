-- sync.js's batchUpsert() issues `ON CONFLICT (columns) DO UPDATE` for these
-- tables, which requires Postgres to find a unique index/constraint on
-- exactly those columns (the "arbiter"). Migration 001 declares one via
-- inline UNIQUE(...) on each CREATE TABLE, but CREATE TABLE IF NOT EXISTS is
-- a no-op against a table that already existed before that constraint was
-- written - as confirmed live on settlement_rows, which threw "there is no
-- unique or exclusion constraint matching the ON CONFLICT specification"
-- despite migration 001 declaring exactly this constraint. CREATE UNIQUE
-- INDEX IF NOT EXISTS (unlike ALTER TABLE ADD CONSTRAINT, which Postgres
-- does not support with IF NOT EXISTS) is safe to run whether or not the
-- original inline constraint actually made it onto a given database, and a
-- harmless no-op if it did.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_conflict ON orders(tenant_id, amazon_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_rows_conflict ON settlement_rows(tenant_id, order_id, amount_type, amount_description, posted_date, amount);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gst_invoices_conflict ON gst_invoices(tenant_id, invoice_type, order_id, invoice_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_returns_conflict ON returns(tenant_id, order_id, return_date, return_reason, disposition);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_snapshots_conflict ON inventory_snapshots(tenant_id, sku, snapshot_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_traffic_daily_conflict ON sales_traffic_daily(tenant_id, date, asin);
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_items_conflict ON order_items(tenant_id, amazon_order_id, sku, asin);
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_transactions_conflict ON finance_transactions(tenant_id, transaction_id);
