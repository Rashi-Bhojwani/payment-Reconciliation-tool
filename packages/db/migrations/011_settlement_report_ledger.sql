-- Auditable, idempotent source identity for scheduled settlement reports.
CREATE TABLE IF NOT EXISTS settlement_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id text NOT NULL,
  document_id text NOT NULL,
  marketplace_id text NOT NULL,
  data_start_time timestamptz,
  data_end_time timestamptz,
  created_time timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, report_id)
);

ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS source_report_id text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS source_document_id text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS source_line_number integer;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS source_line_hash text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS amount_minor bigint;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS classification_id text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS classification_reason text;
ALTER TABLE settlement_rows DROP CONSTRAINT IF EXISTS settlement_rows_tenant_id_order_id_amount_type_amount_description_posted_date_amount_key;
UPDATE settlement_rows SET amount_minor=round(amount*100)::bigint WHERE amount_minor IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS settlement_rows_source_line_uq
  ON settlement_rows(tenant_id, source_report_id, source_line_hash)
  WHERE source_report_id IS NOT NULL AND source_line_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS settlement_reports_coverage_idx
  ON settlement_reports(tenant_id, data_start_time, data_end_time);

ALTER TABLE settlement_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON settlement_reports;
CREATE POLICY tenant_isolation ON settlement_reports
  USING (tenant_id::text=current_setting('app.current_tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.current_tenant_id',true));
