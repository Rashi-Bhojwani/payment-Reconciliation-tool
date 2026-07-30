-- Amazon report/API integrity upgrade. New source keys make every importer
-- idempotent even when Amazon regenerates a report or returns nullable fields.

-- These existing tables force tenant RLS, including for their owner. The
-- backfills below are cross-tenant maintenance, so suspend RLS for the duration
-- of this migration. A migration file is sent to PostgreSQL as one query and is
-- therefore atomic; the final block restores every policy before commit.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'settlement_rows',
    'order_items',
    'finance_transactions',
    'finance_transaction_items',
    'returns',
    'reimbursements',
    'gst_invoices'
  ] LOOP
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

ALTER TABLE sync_jobs
  ADD COLUMN IF NOT EXISTS orders_coverage_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS finance_coverage_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inventory_coverage_complete boolean NOT NULL DEFAULT false;

-- Older direct-sync rows had one all-or-nothing coverage flag. Preserve that
-- conservative meaning when upgrading; new syncs record each API separately.
UPDATE sync_jobs
SET orders_coverage_complete = coverage_complete,
    finance_coverage_complete = coverage_complete,
    inventory_coverage_complete = coverage_complete
WHERE report_type = 'DIRECT_SP_API_SYNC'
  AND coverage_complete = true;

CREATE TABLE IF NOT EXISTS settlement_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  settlement_id text NOT NULL,
  settlement_start_date timestamptz,
  settlement_end_date timestamptz,
  deposit_date timestamptz,
  total_amount numeric(16,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'INR',
  report_id text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(tenant_id, settlement_id)
);
ALTER TABLE settlement_statements DISABLE ROW LEVEL SECURITY;

-- Preserve statement metadata that older imports stored as zero-amount detail
-- rows. Dates are backfilled only for formats that can be converted safely;
-- the next settlement sync refreshes all fields through the application parser.
INSERT INTO settlement_statements(tenant_id, settlement_id, deposit_date, currency, report_id, raw)
SELECT DISTINCT ON (tenant_id, settlement_id)
  tenant_id,
  settlement_id,
  CASE
    WHEN coalesce(raw->>'deposit-date', raw->>'deposit date', raw->>'depositDate', '') ~ '^\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}:\d{2}(\s+(UTC|GMT))?$'
      THEN to_timestamp(
        regexp_replace(coalesce(raw->>'deposit-date', raw->>'deposit date', raw->>'depositDate'), '\s+(UTC|GMT)$', '', 'i'),
        'DD.MM.YYYY HH24:MI:SS'
      )::timestamp AT TIME ZONE 'UTC'
    WHEN coalesce(raw->>'deposit-date', raw->>'deposit date', raw->>'depositDate', '') ~ '^\d{1,2}\.\d{1,2}\.\d{4}$'
      THEN to_timestamp(
        coalesce(raw->>'deposit-date', raw->>'deposit date', raw->>'depositDate'),
        'DD.MM.YYYY'
      )::timestamp AT TIME ZONE 'UTC'
    WHEN coalesce(raw->>'deposit-date', raw->>'deposit date', raw->>'depositDate', '') ~ '^\d{4}-\d{2}-\d{2}T'
      THEN coalesce(raw->>'deposit-date', raw->>'deposit date', raw->>'depositDate')::timestamptz
    ELSE NULL
  END,
  coalesce(nullif(raw->>'currency', ''), 'INR'),
  NULL,
  raw
FROM settlement_rows
WHERE settlement_id IS NOT NULL
  AND coalesce(raw->>'deposit-date', raw->>'deposit date', raw->>'depositDate', '') <> ''
ON CONFLICT (tenant_id, settlement_id) DO UPDATE SET
  deposit_date = coalesce(excluded.deposit_date, settlement_statements.deposit_date),
  currency = excluded.currency,
  raw = excluded.raw;

-- Header rows are metadata, not money movements.
DELETE FROM settlement_rows
WHERE coalesce(raw->>'deposit-date', raw->>'deposit date', raw->>'depositDate', '') <> ''
  AND coalesce(raw->>'amount', '') = ''
  AND amount_type IS NULL
  AND amount_description IS NULL;

ALTER TABLE settlement_rows
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS report_id text,
  ADD COLUMN IF NOT EXISTS transaction_type text,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS order_item_code text,
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS quantity integer;

-- Remove repeated copies produced by the old nullable composite constraint.
DELETE FROM settlement_rows newer
USING settlement_rows older
WHERE newer.tenant_id = older.tenant_id
  AND newer.raw = older.raw
  AND newer.id > older.id;

UPDATE settlement_rows
SET source_key = encode(digest(concat_ws(
  E'\x1f',
  'legacy-settlement',
  coalesce(settlement_id, ''),
  coalesce(order_id, ''),
  coalesce(amount_type, ''),
  coalesce(amount_description, ''),
  coalesce(amount::text, ''),
  coalesce(posted_date::text, ''),
  raw::text
), 'sha256'), 'hex')
WHERE source_key IS NULL;

ALTER TABLE settlement_rows ALTER COLUMN source_key SET NOT NULL;
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT constraint_row.conname
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'settlement_rows'::regclass
      AND constraint_row.contype = 'u'
      AND ARRAY(
        SELECT attribute.attname::text
        FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, position)
        JOIN pg_attribute attribute
          ON attribute.attrelid = constraint_row.conrelid
         AND attribute.attnum = key_column.attnum
        ORDER BY key_column.position
      ) = ARRAY['tenant_id','order_id','amount_type','amount_description','posted_date','amount']::text[]
  LOOP
    EXECUTE format('ALTER TABLE settlement_rows DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_rows_source_key
  ON settlement_rows(tenant_id, source_key);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS amazon_last_updated_at timestamptz;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS amazon_order_item_id text,
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS currency text;

UPDATE order_items
SET amazon_order_item_id = coalesce(
      amazon_order_item_id,
      raw->>'orderItemId',
      raw->>'OrderItemId',
      raw->>'order-item-id'
    ),
    source_key = coalesce(
      source_key,
      CASE
        WHEN coalesce(raw->>'orderItemId', raw->>'OrderItemId', raw->>'order-item-id') IS NOT NULL
          THEN 'orders-v2026:' || amazon_order_id || ':' || coalesce(raw->>'orderItemId', raw->>'OrderItemId', raw->>'order-item-id')
        ELSE 'legacy-order-item:' || id::text
      END
    );

ALTER TABLE order_items ALTER COLUMN source_key SET NOT NULL;
ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS order_items_tenant_id_amazon_order_id_sku_asin_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_items_source_key
  ON order_items(tenant_id, source_key);
CREATE INDEX IF NOT EXISTS idx_order_items_tenant_order_item_id
  ON order_items(tenant_id, amazon_order_item_id);

ALTER TABLE finance_transactions
  ADD COLUMN IF NOT EXISTS transaction_status text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS account_type text,
  ADD COLUMN IF NOT EXISTS marketplace_id text;

UPDATE finance_transactions
SET transaction_status = coalesce(transaction_status, raw->>'transactionStatus', raw->>'TransactionStatus'),
    description = coalesce(description, raw->>'description', raw->>'Description'),
    account_type = coalesce(
      account_type,
      raw->>'accountType',
      raw->>'AccountType',
      raw#>>'{sellingPartnerMetadata,accountType}',
      raw#>>'{SellingPartnerMetadata,AccountType}'
    );

ALTER TABLE finance_transaction_items
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS account_section text,
  ADD COLUMN IF NOT EXISTS breakdown_path text,
  ADD COLUMN IF NOT EXISTS is_summary boolean NOT NULL DEFAULT false;

UPDATE finance_transaction_items
SET source_key = coalesce(source_key, 'legacy-finance-item:' || id::text),
    is_summary = category LIKE 'summary_%';
ALTER TABLE finance_transaction_items ALTER COLUMN source_key SET NOT NULL;
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT constraint_row.conname
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'finance_transaction_items'::regclass
      AND constraint_row.contype = 'u'
      AND ARRAY(
        SELECT attribute.attname::text
        FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, position)
        JOIN pg_attribute attribute
          ON attribute.attrelid = constraint_row.conrelid
         AND attribute.attnum = key_column.attnum
        ORDER BY key_column.position
      ) = ARRAY['tenant_id','transaction_id','order_id','sku','category','amount_description','amount']::text[]
  LOOP
    EXECUTE format('ALTER TABLE finance_transaction_items DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
DROP INDEX IF EXISTS uq_finance_items_idempotent;
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_items_source_key
  ON finance_transaction_items(tenant_id, source_key);

ALTER TABLE returns
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS order_item_id text,
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS asin text,
  ADD COLUMN IF NOT EXISTS fnsku text,
  ADD COLUMN IF NOT EXISTS amazon_status text,
  ADD COLUMN IF NOT EXISTS fulfillment_center_id text;

UPDATE returns SET source_key = coalesce(source_key, 'legacy-return:' || id::text);
ALTER TABLE returns ALTER COLUMN source_key SET NOT NULL;
ALTER TABLE returns DROP CONSTRAINT IF EXISTS returns_tenant_id_order_id_return_date_return_reason_disposition_key;
ALTER TABLE returns DROP CONSTRAINT IF EXISTS returns_status_check;
ALTER TABLE returns ADD CONSTRAINT returns_status_check
  CHECK(status IN ('yet_to_receive','received_not_in_hand','received'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_returns_source_key
  ON returns(tenant_id, source_key);

ALTER TABLE reimbursements
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS reimbursement_id text,
  ADD COLUMN IF NOT EXISTS order_id text,
  ADD COLUMN IF NOT EXISTS fnsku text,
  ADD COLUMN IF NOT EXISTS asin text,
  ADD COLUMN IF NOT EXISTS amount_per_unit numeric(16,2),
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS quantity_cash integer,
  ADD COLUMN IF NOT EXISTS quantity_inventory integer,
  ADD COLUMN IF NOT EXISTS quantity_total integer,
  ADD COLUMN IF NOT EXISTS raw jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE reimbursements SET source_key = coalesce(source_key, 'legacy-reimbursement:' || id::text);
ALTER TABLE reimbursements ALTER COLUMN source_key SET NOT NULL;
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT constraint_row.conname
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'reimbursements'::regclass
      AND constraint_row.contype = 'u'
      AND ARRAY(
        SELECT attribute.attname::text
        FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, position)
        JOIN pg_attribute attribute
          ON attribute.attrelid = constraint_row.conrelid
         AND attribute.attnum = key_column.attnum
        ORDER BY key_column.position
      ) = ARRAY['tenant_id','sku','reimbursement_date','amount','reason']::text[]
  LOOP
    EXECUTE format('ALTER TABLE reimbursements DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_reimbursements_source_key
  ON reimbursements(tenant_id, source_key);

ALTER TABLE gst_invoices
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS document_number text,
  ADD COLUMN IF NOT EXISTS line_id text,
  ADD COLUMN IF NOT EXISTS transaction_type text,
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS asin text,
  ADD COLUMN IF NOT EXISTS quantity integer,
  ADD COLUMN IF NOT EXISTS invoice_amount numeric(16,2),
  ADD COLUMN IF NOT EXISTS tax_total numeric(16,2),
  ADD COLUMN IF NOT EXISTS utgst numeric(16,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cess numeric(16,2) NOT NULL DEFAULT 0;

UPDATE gst_invoices SET source_key = coalesce(source_key, 'legacy-gst:' || id::text);
ALTER TABLE gst_invoices ALTER COLUMN source_key SET NOT NULL;
ALTER TABLE gst_invoices
  DROP CONSTRAINT IF EXISTS gst_invoices_tenant_id_invoice_type_order_id_invoice_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gst_invoices_source_key
  ON gst_invoices(tenant_id, source_key);

ALTER TABLE sales_traffic_daily
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS browser_sessions integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mobile_app_sessions integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS browser_page_views integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mobile_app_page_views integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_rate numeric(8,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS units_shipped integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS orders_shipped integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_session_percentage numeric(8,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS order_item_session_percentage numeric(8,4) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sales_traffic_asin (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  parent_asin text NOT NULL DEFAULT '',
  child_asin text NOT NULL DEFAULT '',
  sku text NOT NULL DEFAULT '',
  sessions integer NOT NULL DEFAULT 0,
  page_views integer NOT NULL DEFAULT 0,
  browser_sessions integer NOT NULL DEFAULT 0,
  mobile_app_sessions integer NOT NULL DEFAULT 0,
  browser_page_views integer NOT NULL DEFAULT 0,
  mobile_app_page_views integer NOT NULL DEFAULT 0,
  units_ordered integer NOT NULL DEFAULT 0,
  total_order_items integer NOT NULL DEFAULT 0,
  ordered_product_sales numeric(16,2) NOT NULL DEFAULT 0,
  featured_offer_percentage numeric(8,4),
  unit_session_percentage numeric(8,4),
  currency text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(tenant_id, period_start, period_end, parent_asin, child_asin, sku)
);
ALTER TABLE sales_traffic_asin DISABLE ROW LEVEL SECURITY;

UPDATE sales_traffic_asin
SET parent_asin=coalesce(parent_asin,''),
    child_asin=coalesce(child_asin,''),
    sku=coalesce(sku,'');
ALTER TABLE sales_traffic_asin
  ALTER COLUMN parent_asin SET DEFAULT '',
  ALTER COLUMN parent_asin SET NOT NULL,
  ALTER COLUMN child_asin SET DEFAULT '',
  ALTER COLUMN child_asin SET NOT NULL,
  ALTER COLUMN sku SET DEFAULT '',
  ALTER COLUMN sku SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_traffic_asin_tenant_period
  ON sales_traffic_asin(tenant_id, period_start, period_end);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'settlement_rows',
    'order_items',
    'finance_transactions',
    'finance_transaction_items',
    'returns',
    'reimbursements',
    'gst_invoices',
    'settlement_statements',
    'sales_traffic_asin'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    IF table_name IN ('settlement_statements', 'sales_traffic_asin') THEN
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id::text = current_setting(''app.current_tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.current_tenant_id'', true))',
        table_name
      );
    END IF;
  END LOOP;
END $$;
