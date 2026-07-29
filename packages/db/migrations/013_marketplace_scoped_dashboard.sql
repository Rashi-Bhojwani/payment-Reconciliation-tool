-- Dashboard source rows carry the marketplace they came from.  The trigger is
-- intentionally data driven: importers never assume a particular marketplace.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['orders','order_items','settlement_rows','settlement_report_documents','finance_transactions','finance_transaction_items','returns','reimbursements','gst_invoices'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS marketplace_id text', table_name);
    EXECUTE format('UPDATE %I r SET marketplace_id=s.marketplace_id FROM sellers s WHERE r.tenant_id=s.tenant_id AND r.marketplace_id IS NULL', table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(tenant_id, marketplace_id)', 'idx_' || table_name || '_tenant_marketplace', table_name);
  END LOOP;
END $$;

ALTER TABLE settlement_report_documents ADD COLUMN IF NOT EXISTS content_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_document_content
  ON settlement_report_documents(tenant_id, marketplace_id, content_hash)
  WHERE content_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION set_source_marketplace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.marketplace_id IS NULL THEN
    SELECT marketplace_id INTO NEW.marketplace_id FROM sellers
      WHERE tenant_id=NEW.tenant_id AND auth_status='authorized'
      ORDER BY connected_at DESC LIMIT 1;
  END IF;
  IF NEW.marketplace_id IS NULL THEN RAISE EXCEPTION 'Marketplace is required for Amazon source rows'; END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['orders','order_items','settlement_rows','settlement_report_documents','finance_transactions','finance_transaction_items','returns','reimbursements','gst_invoices'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS source_marketplace ON %I', table_name);
    EXECUTE format('CREATE TRIGGER source_marketplace BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_source_marketplace()', table_name);
  END LOOP;
END $$;
