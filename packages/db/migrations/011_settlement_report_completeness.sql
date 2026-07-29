ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS report_document_id text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS source_row_key text;

ALTER TABLE settlement_rows DROP CONSTRAINT IF EXISTS settlement_rows_tenant_id_order_id_amount_type_amount_descrip_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_source_row
  ON settlement_rows(tenant_id, report_document_id, source_row_key)
  WHERE report_document_id IS NOT NULL AND source_row_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS settlement_report_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id text NOT NULL,
  report_document_id text NOT NULL,
  data_start_time timestamptz,
  data_end_time timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  row_count int NOT NULL DEFAULT 0,
  settlement_ids text[] NOT NULL DEFAULT '{}',
  UNIQUE(tenant_id, report_document_id)
);

ALTER TABLE settlement_report_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_report_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON settlement_report_documents;
CREATE POLICY tenant_isolation ON settlement_report_documents
  USING (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));
