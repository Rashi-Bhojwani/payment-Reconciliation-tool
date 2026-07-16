CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  plan text NOT NULL DEFAULT 'starter',
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by_admin_id uuid
);

CREATE TABLE IF NOT EXISTS sellers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  amazon_seller_id text NOT NULL,
  marketplace_id text NOT NULL,
  refresh_token_encrypted text NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, amazon_seller_id)
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  s3_key text
);

CREATE TABLE IF NOT EXISTS orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, amazon_order_id text NOT NULL, order_date timestamptz, total_amount numeric(12,2), status text, UNIQUE(tenant_id, amazon_order_id));
CREATE TABLE IF NOT EXISTS settlement_rows (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, settlement_id text, order_id text, amount_type text, amount_description text, amount numeric(12,2) NOT NULL DEFAULT 0, posted_date timestamptz, raw jsonb NOT NULL DEFAULT '{}'::jsonb, UNIQUE(tenant_id, order_id, amount_type, amount_description, posted_date, amount));
CREATE TABLE IF NOT EXISTS gst_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, invoice_type text NOT NULL CHECK(invoice_type IN ('b2b','b2c')), order_id text, cgst numeric(12,2) DEFAULT 0, sgst numeric(12,2) DEFAULT 0, igst numeric(12,2) DEFAULT 0, taxable_value numeric(12,2) DEFAULT 0, invoice_date date);
CREATE TABLE IF NOT EXISTS returns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, order_id text, return_reason text, disposition text, status text NOT NULL CHECK(status IN ('yet_to_receive','received_not_in_hand','received')), return_date date);
CREATE TABLE IF NOT EXISTS reimbursements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, amount numeric(12,2), reason text, sku text, reimbursement_date date);
CREATE TABLE IF NOT EXISTS inventory_snapshots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, sku text, fulfillable_quantity int, snapshot_date date NOT NULL DEFAULT current_date, UNIQUE(tenant_id, sku, snapshot_date));
CREATE TABLE IF NOT EXISTS sales_traffic_daily (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, date date NOT NULL, asin text, sessions int DEFAULT 0, page_views int DEFAULT 0, units_ordered int DEFAULT 0, ordered_product_sales numeric(12,2) DEFAULT 0, featured_offer_percentage numeric(5,2), units_refunded int DEFAULT 0, shipped_product_sales numeric(12,2) DEFAULT 0, UNIQUE(tenant_id, date, asin));
CREATE TABLE IF NOT EXISTS ad_campaigns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, campaign_name text NOT NULL, UNIQUE(tenant_id, campaign_name));
CREATE TABLE IF NOT EXISTS ad_campaign_daily (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, campaign_id uuid REFERENCES ad_campaigns(id) ON DELETE CASCADE, date date NOT NULL, impressions int DEFAULT 0, clicks int DEFAULT 0, spend numeric(12,2) DEFAULT 0, sales numeric(12,2) DEFAULT 0, orders int DEFAULT 0, UNIQUE(tenant_id, campaign_id, date));
CREATE TABLE IF NOT EXISTS fee_leak_flags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, order_id text, expected_fee numeric(12,2), actual_fee numeric(12,2), variance numeric(12,2), flagged_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS generated_reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, report_type text NOT NULL, period text NOT NULL, narrative_json jsonb NOT NULL DEFAULT '{}'::jsonb, generated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id, report_type, period));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sellers','sync_jobs','orders','settlement_rows','gst_invoices','returns','reimbursements','inventory_snapshots','sales_traffic_daily','ad_campaigns','ad_campaign_daily','fee_leak_flags','generated_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id::text = current_setting(''app.current_tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.current_tenant_id'', true))', t);
  END LOOP;
END $$;
