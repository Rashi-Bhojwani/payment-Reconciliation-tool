-- Migration 014 switched settlement_rows, returns, and order_items to use
-- (tenant_id, source_key) as their real ON CONFLICT identity, but never
-- dropped the composite business-column indexes migration 013 had created
-- for them. Postgres enforces *every* unique index on a table regardless of
-- which one an ON CONFLICT clause names - so a row that is perfectly valid
-- under the new source_key identity (e.g. the same order/fee/date/amount
-- genuinely appearing in two different, overlapping settlement documents,
-- which is real Amazon data, not a bug) still hit the old, now-obsolete
-- composite constraint and failed outright. Confirmed live:
-- "duplicate key value violates unique constraint uq_settlement_rows_conflict".
--
-- Reproduced directly against a real Postgres instance: two rows with
-- different source_key but identical business columns fail with both
-- indexes present, and succeed once the obsolete one is dropped.
DROP INDEX IF EXISTS uq_settlement_rows_conflict;
DROP INDEX IF EXISTS uq_returns_conflict;
DROP INDEX IF EXISTS uq_order_items_conflict;
