-- Tracks the one-time 90-day backfill that runs right after a seller
-- authorizes. Amazon retains report documents for a maximum of 90 days
-- (confirmed against the official SP-API getReports reference: "Reports are
-- retained for a maximum of 90 days") and imposes no such limit on the
-- Orders/Finances APIs, so the moment of authorization is the only chance
-- to ever capture that report-based history - after 90 days it is gone from
-- Amazon's side regardless of what this tool does. Everything from that
-- point forward is kept current by the existing nightly scheduler
-- (startScheduler in sync.js), so this column only needs to track the
-- one-time catch-up, not ongoing sync.
--
-- migrate.js re-runs EVERY .sql file on every invocation (there is no
-- migration-tracking table), so a bare `UPDATE ... WHERE backfill_status =
-- 'pending'` here would be wrong the moment anyone runs db:migrate again for
-- some later, unrelated change: a seller who authorized in between - whose
-- backfill is genuinely still pending or running - would be silently marked
-- 'completed', permanently losing the only window this data is ever
-- reachable in. Gating the whole block on the columns not existing yet makes
-- the backfill of existing rows run exactly once, on the first apply, and
-- never touch a seller created afterward.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'sellers' AND column_name = 'backfill_status'
  ) THEN
    ALTER TABLE sellers ADD COLUMN backfill_status text NOT NULL DEFAULT 'pending' CHECK (backfill_status IN ('pending','running','completed'));
    ALTER TABLE sellers ADD COLUMN backfill_started_at timestamptz;
    ALTER TABLE sellers ADD COLUMN backfill_completed_at timestamptz;
    -- One entry per report type/source once attempted:
    -- {"DIRECT_SP_API_SYNC":"completed","GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2":"failed",...}
    -- so the dashboard can show real per-source progress ("6 of 8") instead
    -- of one opaque spinner, and a source Amazon genuinely refuses (a
    -- missing SP-API role, exactly like the Brand Analytics 403 hit earlier)
    -- is recorded failed rather than left pending forever, which would
    -- otherwise block the seller out of their own dashboard indefinitely.
    ALTER TABLE sellers ADD COLUMN backfill_progress jsonb NOT NULL DEFAULT '{}'::jsonb;
    -- A seller authorized before this migration existed has nothing to
    -- backfill retroactively through this new code path (their 90-day
    -- window may already be partly or fully gone, and no code before this
    -- deploy ever ran the backfill for them), and must not be shown a
    -- blocking "syncing" screen forever. Runs once, for rows that exist at
    -- this exact moment only.
    UPDATE sellers SET backfill_status = 'completed', backfill_completed_at = now();
  END IF;
END $$;
