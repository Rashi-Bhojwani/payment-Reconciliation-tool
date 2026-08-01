-- Lets a sync request recognize "we already have this exact range" instead
-- of always re-hitting Amazon, which was a real contributor to the rate
-- limiting seen in the account's own SP-API usage report (429s across
-- orders, reports document downloads, and report creation).
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS range_start timestamptz;
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS range_end timestamptz;
CREATE INDEX IF NOT EXISTS idx_sync_jobs_reuse_lookup ON sync_jobs(tenant_id, report_type, status, completed_at DESC);
