-- Two gaps in the one-time 90-day backfill (019_seller_initial_backfill.sql)
-- that together locked a real seller out of their own dashboard for a full day.
--
-- THE STUCK STATE. backfill_status='running' blocks every page in the app, on
-- purpose: a partially backfilled range must never be read as a final figure.
-- But nothing ever cleared that flag except the backfill's own completion. If
-- the API process stopped mid-backfill - a redeploy, a restart, a crash, a
-- laptop closing on `npm run dev` - the row stayed 'running' forever, with no
-- process left to finish it and no path back. The seller sees a progress
-- screen that will never advance, and the app's own advice ("refresh the
-- page") cannot help, because nothing is running to make progress.
--
-- sync_jobs already had exactly this problem and already has the fix: rows
-- interrupted by a restart are timed out on the next dashboard load, with the
-- comment "Persist the timeout so all pages agree and the stale state does not
-- live forever." The same reasoning simply never reached this table.
--
-- backfill_heartbeat_at is what makes that timeout decidable. Time since
-- backfill_started_at cannot distinguish "genuinely still working" from
-- "died an hour ago" - a real backfill can legitimately run a long time, since
-- Amazon throttles report creation hard and one settlement history can span
-- many documents. A heartbeat written as each source and each retry completes
-- separates the two: recent means alive, stale means gone. It also stays
-- correct if the API ever runs as more than one instance, which an in-memory
-- "is it running here" check would not.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS backfill_heartbeat_at timestamptz;

-- 'failed' is the honest fourth state and the original CHECK had no room for
-- it, so a timed-out backfill had nowhere truthful to go: 'completed' claims
-- work that did not happen, and 'pending' invites an infinite re-run. The
-- per-source detail in backfill_progress says which sources actually finished.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'sellers'::regclass
       AND conname = 'sellers_backfill_status_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%failed%'
  ) THEN
    ALTER TABLE sellers DROP CONSTRAINT sellers_backfill_status_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'sellers'::regclass AND conname = 'sellers_backfill_status_check'
  ) THEN
    ALTER TABLE sellers ADD CONSTRAINT sellers_backfill_status_check
      CHECK (backfill_status IN ('pending','running','completed','failed'));
  END IF;
END $$;

-- Release anything already stuck. This is the one-off repair for rows that
-- predate the heartbeat: they have no heartbeat to judge, and a backfill
-- started more than six hours ago is not still running under any reading -
-- the whole eight-source pass takes minutes to low hours even when Amazon is
-- throttling. Bounded by backfill_started_at so a backfill genuinely running
-- right now, during a deploy, is untouched.
UPDATE sellers
   SET backfill_status = 'failed'
 WHERE backfill_status = 'running'
   AND backfill_heartbeat_at IS NULL
   AND backfill_started_at < now() - interval '6 hours';
