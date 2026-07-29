ALTER TABLE settlement_reports ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE settlement_reports ADD COLUMN IF NOT EXISTS parsed_row_count integer NOT NULL DEFAULT 0;
ALTER TABLE settlement_reports ADD COLUMN IF NOT EXISTS import_status text NOT NULL DEFAULT 'imported';
CREATE UNIQUE INDEX IF NOT EXISTS settlement_reports_document_content_uq
  ON settlement_reports(tenant_id, marketplace_id, document_id, content_hash);

CREATE TABLE IF NOT EXISTS settlement_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id text NOT NULL,
  document_id text NOT NULL,
  settlement_id text NOT NULL,
  header_total_minor bigint NOT NULL,
  detail_total_minor bigint NOT NULL,
  control_difference_minor bigint NOT NULL,
  imported_row_count integer NOT NULL,
  completeness_status text NOT NULL CHECK(completeness_status IN ('complete','reconciliation_error')),
  validated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,report_id,settlement_id)
);
CREATE INDEX IF NOT EXISTS settlement_controls_tenant_settlement_idx ON settlement_controls(tenant_id,settlement_id);
ALTER TABLE settlement_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settlement_controls
  USING (tenant_id::text=current_setting('app.current_tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.current_tenant_id',true));
