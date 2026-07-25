CREATE TABLE IF NOT EXISTS finance_transaction_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transaction_id text NOT NULL,
  order_id text,
  sku text,
  asin text,
  category text NOT NULL,
  amount_description text,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  currency text DEFAULT 'INR',
  posted_date timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(tenant_id, transaction_id, order_id, sku, category, amount_description, amount)
);
CREATE INDEX IF NOT EXISTS idx_finance_items_tenant_category_date ON finance_transaction_items(tenant_id, category, posted_date);
CREATE INDEX IF NOT EXISTS idx_finance_items_tenant_order ON finance_transaction_items(tenant_id, order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_items_idempotent ON finance_transaction_items(tenant_id,transaction_id,coalesce(order_id,''),coalesce(sku,''),category,coalesce(amount_description,''),amount);

CREATE TABLE IF NOT EXISTS fee_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku text NOT NULL, asin text, price_snapshot numeric(12,2) NOT NULL, category text,
  referral_fee numeric(12,2) DEFAULT 0, fulfillment_fee numeric(12,2) DEFAULT 0,
  closing_fee numeric(12,2) DEFAULT 0, other_fee numeric(12,2) DEFAULT 0,
  total_fee numeric(12,2) NOT NULL, source text NOT NULL CHECK(source IN ('amazon_estimate','slab_fallback')),
  raw jsonb NOT NULL DEFAULT '{}'::jsonb, estimated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, sku, price_snapshot)
);

ALTER TABLE fee_leak_flags ADD COLUMN IF NOT EXISTS sku text;
ALTER TABLE fee_leak_flags ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE fee_leak_flags ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE fee_leak_flags ADD COLUMN IF NOT EXISTS resolved boolean NOT NULL DEFAULT false;
DELETE FROM fee_leak_flags a USING fee_leak_flags b WHERE a.tenant_id=b.tenant_id AND a.order_id=b.order_id AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_leak_tenant_order ON fee_leak_flags(tenant_id, order_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['finance_transaction_items','fee_estimates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id::text = current_setting(''app.current_tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.current_tenant_id'', true))', t);
  END LOOP;
END $$;
