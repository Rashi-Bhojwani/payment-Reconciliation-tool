ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_channel text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sales_channel text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_orders_tenant_fulfillment_date
  ON orders(tenant_id, fulfillment_channel, order_date DESC);

CREATE INDEX IF NOT EXISTS idx_settlement_rows_tenant_order
  ON settlement_rows(tenant_id, order_id, posted_date DESC);

CREATE INDEX IF NOT EXISTS idx_finance_transactions_tenant_order
  ON finance_transactions(tenant_id, related_order_id, posted_date DESC);
