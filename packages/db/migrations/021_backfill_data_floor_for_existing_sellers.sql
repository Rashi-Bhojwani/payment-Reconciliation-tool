-- Sellers who connected before 020_seller_data_floor.sql shipped never had
-- data_floor_date computed by runInitialSellerBackfill, so their date range
-- picker was left fully unrestricted - the deliberate safe default for a
-- seller with no recorded floor (see that migration's comment). That default
-- is too permissive here, not just cautious: those sellers' report retention
-- still only ever reached 90 days back from THEIR OWN first authorization,
-- exactly like a seller who backfills today - they simply never got that
-- boundary written down. Compute it retroactively the same way the live code
-- computes it going forward (see runInitialSellerBackfill in
-- apps/api/src/jobs/sync.js): 90 days before the seller's connected_at.
--
-- This only ever fills a currently-null value, so it can never overwrite a
-- floor a real backfill has already set (that floor is always more accurate,
-- since it comes from the actual window Amazon returned, not an estimate).
-- It is also naturally idempotent - migrate.js re-applies every .sql file on
-- every run, but the WHERE clause only matches rows still null, so re-running
-- this file a second time updates nothing.
update sellers
set data_floor_date = (connected_at - interval '90 days')::date
where data_floor_date is null and connected_at is not null;
