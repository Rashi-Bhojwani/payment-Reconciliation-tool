ALTER TABLE sync_jobs
  ADD COLUMN IF NOT EXISTS data_start_time timestamptz,
  ADD COLUMN IF NOT EXISTS data_end_time timestamptz,
  ADD COLUMN IF NOT EXISTS rows_imported integer,
  ADD COLUMN IF NOT EXISTS coverage_complete boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_sync_jobs_tenant_report_coverage
  ON sync_jobs(tenant_id, report_type, data_start_time, data_end_time)
  WHERE status = 'completed' AND coverage_complete = true;