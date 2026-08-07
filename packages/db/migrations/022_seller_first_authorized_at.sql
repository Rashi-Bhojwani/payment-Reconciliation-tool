-- 021 computed data_floor_date from connected_at minus 90 days, trusting
-- connected_at as a proxy for "first ever authorized". That trust was
-- misplaced: the OAuth callback's upsert (apps/api/src/server.js) reset
-- connected_at to now() on every reconnect, not just the first one - it has
-- to, since other queries rely on connected_at to mean "most recently
-- connected" when picking the active seller row. So any seller who
-- reconnected even once since first authorizing got a floor computed from
-- their LATEST connection instead of their first - later than the true
-- floor, which can lock the picker below data that is already sitting in
-- the database from the seller's real first backfill.
--
-- Fixed two ways:
--  1. server.js now writes a separate first_authorized_at once, on the true
--     first INSERT only (left out of the ON CONFLICT DO UPDATE SET clause,
--     so Postgres leaves the existing value untouched on every future
--     reconnect) - so this drift can't happen again going forward.
--  2. For sellers already affected, the true original authorization moment
--     was overwritten in place with no history kept, so it can't be
--     recovered from a timestamp anymore - but the earliest date actually
--     stored in each fact table IS ground truth for what was really
--     fetched, independent of any connected_at history. The floor is
--     lowered (never raised - LEAST only ever moves it earlier) to match
--     wherever real synced data reaches further back than the recorded
--     floor.
--
-- Both parts are naturally idempotent: the column add/backfill only fills a
-- currently-null value, and the LEAST() correction converges to the same
-- answer (the true minimum) no matter how many times migrate.js re-applies
-- this file.
alter table sellers add column if not exists first_authorized_at timestamptz;
update sellers set first_authorized_at = coalesce(first_authorized_at, connected_at) where first_authorized_at is null;

update sellers s
set data_floor_date = least(
  s.data_floor_date,
  coalesce((select min(order_date)::date from orders where tenant_id = s.tenant_id), s.data_floor_date),
  coalesce((select min(posted_date)::date from settlement_rows where tenant_id = s.tenant_id), s.data_floor_date),
  coalesce((select min(date) from sales_traffic_daily where tenant_id = s.tenant_id), s.data_floor_date),
  coalesce((select min(invoice_date) from gst_invoices where tenant_id = s.tenant_id), s.data_floor_date),
  coalesce((select min(reimbursement_date) from reimbursements where tenant_id = s.tenant_id), s.data_floor_date),
  coalesce((select min(return_date) from returns where tenant_id = s.tenant_id), s.data_floor_date)
)
where s.data_floor_date is not null;
