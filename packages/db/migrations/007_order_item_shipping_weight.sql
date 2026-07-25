ALTER TABLE order_items ADD COLUMN IF NOT EXISTS package_weight numeric(12,3);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS weight_unit text;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS package_dimensions text;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS catalog_raw jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_order_items_tenant_asin
  ON order_items(tenant_id, asin);
