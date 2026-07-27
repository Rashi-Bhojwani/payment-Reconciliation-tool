CREATE TABLE IF NOT EXISTS settlement_transaction_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  posted_at timestamptz,
  settlement_id text,
  type text,
  order_id text,
  sku text,
  description text,
  quantity integer,
  marketplace text,
  account_type text,
  fulfillment text,
  order_city text,
  order_state text,
  order_postal text,
  product_sales numeric,
  shipping_credits numeric,
  gift_wrap_credits numeric,
  promotional_rebates numeric,
  total_sales_tax_liable numeric,
  tcs_cgst numeric,
  tcs_sgst numeric,
  tcs_igst numeric,
  tds_194o numeric,
  selling_fees numeric,
  fba_fees numeric,
  other_transaction_fees numeric,
  other numeric,
  total numeric,
  transaction_status text,
  transaction_release_date timestamptz,
  raw_row jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_settlement_lines_tenant_posted ON settlement_transaction_lines(tenant_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_settlement_lines_tenant_order ON settlement_transaction_lines(tenant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_settlement_lines_tenant_status ON settlement_transaction_lines(tenant_id, transaction_status);

ALTER TABLE settlement_transaction_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_transaction_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON settlement_transaction_lines;
CREATE POLICY tenant_isolation ON settlement_transaction_lines
  USING (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));
