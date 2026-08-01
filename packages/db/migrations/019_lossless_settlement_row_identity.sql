-- Financial values are not row identities: Amazon can emit two completely
-- identical settlement lines for separate units/events. Track the immutable
-- report document and physical row position so those lines are both retained.
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS source_document_id text;
ALTER TABLE settlement_rows ADD COLUMN IF NOT EXISTS source_row_number int;

CREATE INDEX IF NOT EXISTS idx_settlement_rows_document_position
  ON settlement_rows(tenant_id, source_document_id, source_row_number);

-- Rows imported by older versions cannot be mapped back to a document/line,
-- and may already be lossy. Force a clean replay from Amazon rather than
-- mixing guessed legacy identities with exact provenance-aware rows.
DELETE FROM settlement_rows;
DELETE FROM processed_report_documents
WHERE report_type = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2';
