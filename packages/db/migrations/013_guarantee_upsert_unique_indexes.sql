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
--
-- Because the constraint was never actually enforced on some of these
-- tables, genuine duplicate rows (identical on every conflict column) had
-- nothing stopping them from accumulating across repeated syncs - confirmed
-- live: CREATE UNIQUE INDEX on settlement_rows failed with a duplicate key
-- for the exact same (tenant_id, order_id, amount_type, amount_description,
-- posted_date, amount) inserted twice. Each block below removes only true
-- duplicates first. The self-join uses plain `=` (not IS NOT DISTINCT FROM),
-- so - exactly like the constraint it is standing in for - two rows that
-- share a NULL in any of these columns are never treated as duplicates of
-- each other (settlement header rows all share NULL order_id/amount_type/
-- amount_description/posted_date, and are genuinely distinct settlements).

DELETE FROM orders a USING orders b
WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.amazon_order_id = b.amazon_order_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_conflict ON orders(tenant_id, amazon_order_id);

DELETE FROM settlement_rows a USING settlement_rows b
WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.order_id = b.order_id
  AND a.amount_type = b.amount_type AND a.amount_description = b.amount_description
  AND a.posted_date = b.posted_date AND a.amount = b.amount;
CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_rows_conflict ON settlement_rows(tenant_id, order_id, amount_type, amount_description, posted_date, amount);

DELETE FROM gst_invoices a USING gst_invoices b
WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.invoice_type = b.invoice_type
  AND a.order_id = b.order_id AND a.invoice_date = b.invoice_date;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gst_invoices_conflict ON gst_invoices(tenant_id, invoice_type, order_id, invoice_date);

DELETE FROM returns a USING returns b
WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.order_id = b.order_id
  AND a.return_date = b.return_date AND a.return_reason = b.return_reason AND a.disposition = b.disposition;
CREATE UNIQUE INDEX IF NOT EXISTS uq_returns_conflict ON returns(tenant_id, order_id, return_date, return_reason, disposition);

DELETE FROM inventory_snapshots a USING inventory_snapshots b
WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.sku = b.sku AND a.snapshot_date = b.snapshot_date;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_snapshots_conflict ON inventory_snapshots(tenant_id, sku, snapshot_date);

DELETE FROM sales_traffic_daily a USING sales_traffic_daily b
WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.date = b.date AND a.asin = b.asin;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_traffic_daily_conflict ON sales_traffic_daily(tenant_id, date, asin);

DELETE FROM order_items a USING order_items b
WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.amazon_order_id = b.amazon_order_id
  AND a.sku = b.sku AND a.asin = b.asin;
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_items_conflict ON order_items(tenant_id, amazon_order_id, sku, asin);

DELETE FROM finance_transactions a USING finance_transactions b
WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.transaction_id = b.transaction_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_transactions_conflict ON finance_transactions(tenant_id, transaction_id);
