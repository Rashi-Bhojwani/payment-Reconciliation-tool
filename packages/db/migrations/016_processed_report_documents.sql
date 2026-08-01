-- Settlement report documents are immutable once generated. Tracking which
-- ones a tenant has already downloaded and saved lets fetchReport skip
-- re-downloading them on every sync - previously a long-history account's
-- settlement sync re-fetched its *entire* historical backlog on every single
-- call (confirmed live: 17+ documents, each paced ~45s apart by Amazon's
-- real rate limit, taking 12+ minutes and never actually finishing before
-- the next sync request started the same backlog over again).
CREATE TABLE IF NOT EXISTS processed_report_documents (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_document_id text NOT NULL,
  report_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, report_document_id)
);
ALTER TABLE processed_report_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_report_documents FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY tenant_isolation ON processed_report_documents USING (tenant_id::text = current_setting('app.current_tenant_id', true)) WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
