-- Remove provenance created by the retired manual-upload path. Dashboard data
-- is API-only; scheduled/requested SP-API reports are retained.
DELETE FROM settlement_rows WHERE source_report_id LIKE 'upload-%' OR source_document_id LIKE 'upload-%';
DELETE FROM settlement_controls WHERE report_id LIKE 'upload-%' OR document_id LIKE 'upload-%';
DELETE FROM settlement_reports WHERE report_id LIKE 'upload-%' OR document_id LIKE 'upload-%';

CREATE TABLE IF NOT EXISTS dashboard_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  marketplace_id text NOT NULL, local_start_date date NOT NULL, local_end_date date NOT NULL,
  utc_start timestamptz NOT NULL, utc_end timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','completed','completed_with_errors','failed')),
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_sync_one_active_range_uq ON dashboard_sync_runs(tenant_id,marketplace_id,local_start_date,local_end_date) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS source_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  marketplace_id text NOT NULL, source_type text NOT NULL, local_start_date date NOT NULL, local_end_date date NOT NULL,
  utc_start timestamptz NOT NULL, utc_end timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','syncing','complete','partial','unavailable','failed','rate_limited','unsupported','expired_historical_data','permission_missing','report_not_generated','deposit_data_missing')),
  progress integer NOT NULL DEFAULT 0, pages_expected integer, pages_completed integer NOT NULL DEFAULT 0,
  reports_expected integer, reports_completed integer NOT NULL DEFAULT 0, rows_imported integer NOT NULL DEFAULT 0,
  next_token_present boolean NOT NULL DEFAULT false, retry_count integer NOT NULL DEFAULT 0,
  last_successful_sync timestamptz, error_code text, error_message text, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,marketplace_id,source_type,local_start_date,local_end_date)
);
CREATE TABLE IF NOT EXISTS dashboard_sync_sources (
  run_id uuid NOT NULL REFERENCES dashboard_sync_runs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, source_type text NOT NULL,
  status text NOT NULL, progress integer NOT NULL DEFAULT 0, rows_imported integer NOT NULL DEFAULT 0,
  retry_count integer NOT NULL DEFAULT 0, next_token_present boolean NOT NULL DEFAULT false,
  last_error text, amazon_error_code text, retryable boolean NOT NULL DEFAULT true, unavailable_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,source_type)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['dashboard_sync_runs','source_coverage','dashboard_sync_sources'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id::text=current_setting(''app.current_tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.current_tenant_id'',true))',t);
  END LOOP;
END $$;
