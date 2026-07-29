-- Migration 011 accidentally used app.tenant_id while every existing policy
-- and withTenant() use app.current_tenant_id.  Recreate the policy using the
-- established setting and force RLS consistently with the other tenant tables.
ALTER TABLE settlement_report_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_report_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_settlement_report_documents ON settlement_report_documents;
DROP POLICY IF EXISTS tenant_isolation ON settlement_report_documents;
CREATE POLICY tenant_isolation ON settlement_report_documents
  USING (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));
