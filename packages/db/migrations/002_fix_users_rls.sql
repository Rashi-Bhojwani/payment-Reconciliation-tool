-- Users must be readable before a tenant context exists so login, admin seeding,
-- and seller registration do not fail behind tenant-scoped RLS.
ALTER TABLE IF EXISTS users DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
