-- A settlement line is only auditable in the context of the immutable Amazon
-- report document that supplied it.  Keep old rows valid while new syncs fill
-- the provenance columns.
CREATE TABLE IF NOT EXISTS settlement_report_documents (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id text NOT NULL,
  report_document_id text NOT NULL,
  marketplace_id text NOT NULL,
  data_start_time timestamptz NOT NULL,
  data_end_time timestamptz NOT NULL,
  created_time timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  raw_key text,
  PRIMARY KEY (tenant_id, report_id)
);

ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS source_report_id text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS source_document_id text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS source_line_number integer;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS source_line_id text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS amount_minor bigint;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS classification_id text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS classification_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_source_line
  ON settlement_rows(tenant_id, source_report_id, source_line_id)
  WHERE source_report_id IS NOT NULL AND source_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_settlement_report_coverage
  ON settlement_report_documents(tenant_id, marketplace_id, data_start_time, data_end_time);

ALTER TABLE settlement_report_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_settlement_report_documents ON settlement_report_documents;
CREATE POLICY tenant_isolation_settlement_report_documents ON settlement_report_documents
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
