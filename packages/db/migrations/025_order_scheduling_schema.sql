-- 025 — the order scheduling tool, merged in as a `scheduling` schema.
--
-- WHY A SEPARATE SCHEMA, AND NOT public
-- The scheduling tool and this one both define tables called `orders`,
-- `order_items`, `sellers` and `users`, with entirely different shapes -
-- reconciliation's `orders` is (tenant_id, amazon_order_id, order_date,
-- total_amount, status), scheduling's is a 25-column row carrying ship-by
-- dates, encrypted buyer PII and a marketplace lifecycle. Merging them into
-- one namespace would mean renaming half of one application's tables and
-- rewriting every query that touches them, for no gain. A schema keeps both
-- sets under their own real names, so ported scheduling SQL reads exactly as
-- it did in its own repository and reconciliation's data cannot be reached
-- by a mistyped scheduling query at all.
--
-- WHAT IS DELIBERATELY *NOT* DUPLICATED
-- The scheduling tool shipped its own `users`, `sellers`, `session` and
-- `user_seller_access` tables because it was a standalone app with its own
-- login. Merged, a second login and a second seller list would be two things
-- to keep in sync and two places to get isolation wrong. So:
--   * scheduling's "seller" IS this platform's tenant. seller_id references
--     public.tenants(id) directly - one company, one tenant, one seller.
--   * the staff user columns reference public.users(id).
--   * `session` and `user_seller_access` are dropped entirely; access is the
--     API's existing JWT plus the tenant scoping every other table already
--     uses.
--
-- ISOLATION
-- Every scheduling table carrying a seller_id gets the same row-level
-- security policy as the reconciliation tables, reading the same
-- `app.current_tenant_id` setting that withTenant() sets. That is what makes
-- the merge safe rather than merely tidy: one connection helper, one
-- isolation rule, no scheduling-specific way to leak another tenant's orders.
-- package_items carries a denormalized seller_id purely so it can be covered
-- by that same rule - reachable only via package_id would have left it as the
-- one table with no policy of its own.
--
-- This file is the CONSOLIDATED final shape of the scheduling tool's eight
-- migrations, not a replay of them. Those eight create tables and then rename,
-- drop and restructure them (003 and 004 in particular rewrite the order model
-- and delete the AI-era tables); replaying that history into a fresh schema
-- would apply and then undo work for no reason, and could not be re-run.
-- Everything here is IF NOT EXISTS so this file is safe to apply repeatedly,
-- which the migration runner requires - it re-applies every file every time.

CREATE SCHEMA IF NOT EXISTS scheduling;

-- Lookup, not a capability store. What a marketplace can actually do lives on
-- each adapter's static `capabilities` object in code, so the database and the
-- adapters cannot drift on it.
CREATE TABLE IF NOT EXISTS scheduling.marketplaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(30) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  is_active boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO scheduling.marketplaces (code, name, is_active) VALUES
  ('AMAZON',   'Amazon',   TRUE),
  ('FLIPKART', 'Flipkart', FALSE),
  ('MYNTRA',   'Myntra',   FALSE),
  ('MEESHO',   'Meesho',   FALSE)
ON CONFLICT (code) DO NOTHING;

-- One row per connected seller+marketplace. (seller_id, marketplace_id) is
-- deliberately NOT unique - a tenant could connect two Amazon accounts - but
-- the same external account must never be connected twice system-wide.
CREATE TABLE IF NOT EXISTS scheduling.marketplace_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  marketplace_id uuid NOT NULL REFERENCES scheduling.marketplaces(id),
  external_account_id varchar(100),
  region varchar(20) NOT NULL,
  display_name varchar(255),
  status varchar(30) NOT NULL DEFAULT 'PENDING',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace_id, external_account_id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_accounts_seller ON scheduling.marketplace_accounts (seller_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_accounts_marketplace ON scheduling.marketplace_accounts (marketplace_id);

-- One generic encrypted blob rather than a refresh-token-shaped column: a
-- future marketplace may not use OAuth at all (a static key/secret pair), and
-- the plaintext payload is marketplace-defined JSON.
CREATE TABLE IF NOT EXISTS scheduling.marketplace_account_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace_account_id uuid NOT NULL UNIQUE REFERENCES scheduling.marketplace_accounts(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version int NOT NULL DEFAULT 1,
  granted_roles text[],
  last_refreshed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduling.marketplace_connection_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  marketplace_id uuid NOT NULL REFERENCES scheduling.marketplaces(id),
  marketplace_account_id uuid REFERENCES scheduling.marketplace_accounts(id) ON DELETE CASCADE,
  state_token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_connection_requests_seller
  ON scheduling.marketplace_connection_requests (seller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scheduling.marketplace_account_sync_state (
  marketplace_account_id uuid PRIMARY KEY REFERENCES scheduling.marketplace_accounts(id) ON DELETE CASCADE,
  last_synced_at timestamptz,
  last_successful_cursor timestamptz,
  notification_subscription_id varchar(255),
  sqs_destination_id varchar(255),
  consecutive_failures int NOT NULL DEFAULT 0,
  circuit_open_until timestamptz
);

-- marketplace_status is nullable on purpose. Confirmed against a real SP-API
-- v2026-01-01 searchOrders response: list results carry no per-order status,
-- ship-by/delivery-by date or order total at all - those come from a per-order
-- detail call the adapter does not make. A NOT NULL here would reject every
-- order the list endpoint returns.
CREATE TABLE IF NOT EXISTS scheduling.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  marketplace_id uuid NOT NULL REFERENCES scheduling.marketplaces(id),
  marketplace_account_id uuid NOT NULL REFERENCES scheduling.marketplace_accounts(id),
  external_order_id varchar(50) NOT NULL,
  order_date timestamptz NOT NULL,
  last_updated_date timestamptz NOT NULL,
  marketplace_status varchar(40),
  fulfillment_channel varchar(20),
  ship_service_level varchar(60),
  is_prime boolean DEFAULT FALSE,
  is_business_order boolean DEFAULT FALSE,
  earliest_ship_date timestamptz,
  ship_by_date timestamptz,
  delivery_by_date timestamptz,
  order_total_amount numeric(12,2),
  order_total_currency varchar(3),
  -- Buyer PII: encrypted at rest, purged 30 days after delivery.
  buyer_name_enc bytea,
  shipping_address_enc bytea,
  buyer_phone_enc bytea,
  pii_iv bytea,
  pii_auth_tag bytea,
  pii_purged_at timestamptz,
  internal_status varchar(40) NOT NULL DEFAULT 'NEW',
  raw_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace_account_id, external_order_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_review ON scheduling.orders (seller_id, internal_status, ship_by_date);
CREATE INDEX IF NOT EXISTS idx_orders_purge ON scheduling.orders (pii_purged_at, delivery_by_date);
CREATE INDEX IF NOT EXISTS idx_orders_marketplace_account ON scheduling.orders (marketplace_account_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller_order_date ON scheduling.orders (seller_id, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_orders_seller_status ON scheduling.orders (seller_id, marketplace_status);

CREATE TABLE IF NOT EXISTS scheduling.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES scheduling.orders(id) ON DELETE CASCADE,
  seller_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  external_item_id varchar(50) NOT NULL,
  external_product_id varchar(20) NOT NULL,
  sku varchar(100),
  title text,
  quantity_ordered int NOT NULL,
  quantity_shipped int NOT NULL DEFAULT 0,
  unit_price numeric(12,2),
  currency varchar(3),
  UNIQUE (order_id, external_item_id)
);
CREATE INDEX IF NOT EXISTS idx_order_items_external_product
  ON scheduling.order_items (seller_id, external_product_id);

-- Dimensions are nullable: getOrCreatePrimary() creates an empty placeholder
-- the moment an order needs one, and a human fills it in afterwards, so a
-- package legitimately exists before anyone has weighed anything.
CREATE TABLE IF NOT EXISTS scheduling.packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES scheduling.orders(id) ON DELETE CASCADE,
  seller_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  package_number int NOT NULL DEFAULT 1,
  weight_grams numeric(10,2),
  length_cm numeric(8,2),
  width_cm numeric(8,2),
  height_cm numeric(8,2),
  package_type varchar(30),
  entered_by_user_id uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, package_number)
);
CREATE INDEX IF NOT EXISTS idx_packages_order ON scheduling.packages (order_id);
CREATE INDEX IF NOT EXISTS idx_packages_seller ON scheduling.packages (seller_id);

CREATE TABLE IF NOT EXISTS scheduling.package_items (
  package_id uuid NOT NULL REFERENCES scheduling.packages(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES scheduling.order_items(id) ON DELETE CASCADE,
  seller_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  quantity int NOT NULL,
  PRIMARY KEY (package_id, order_item_id)
);
CREATE INDEX IF NOT EXISTS idx_package_items_seller ON scheduling.package_items (seller_id);

CREATE TABLE IF NOT EXISTS scheduling.shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES scheduling.orders(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES scheduling.packages(id),
  seller_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  marketplace_account_id uuid REFERENCES scheduling.marketplace_accounts(id),
  provider varchar(30) NOT NULL,
  external_shipment_id varchar(100),
  tracking_id varchar(100),
  carrier_name varchar(100),
  scheduled_pickup_start timestamptz,
  scheduled_pickup_end timestamptz,
  label_url text,
  invoice_url text,
  status varchar(40) NOT NULL,
  confirmed_at timestamptz,
  -- The one thing standing between a retry and a double-booked pickup.
  idempotency_key varchar(100) UNIQUE,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shipments_seller_created ON scheduling.shipments (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON scheduling.shipments (order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_marketplace_account ON scheduling.shipments (marketplace_account_id);

CREATE TABLE IF NOT EXISTS scheduling.audit_logs (
  id bigserial PRIMARY KEY,
  user_id uuid,
  seller_id uuid,
  action varchar(80) NOT NULL,
  entity_type varchar(50),
  entity_id uuid,
  changes jsonb,
  accessed_pii boolean NOT NULL DEFAULT FALSE,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_seller ON scheduling.audit_logs (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON scheduling.audit_logs (user_id, created_at DESC);

-- The same isolation rule the reconciliation tables use, reading the same
-- setting withTenant() sets, so a scheduling query is protected by exactly the
-- mechanism already audited for everything else. FORCE so the table owner is
-- not silently exempt - that exemption is the usual reason a policy looks
-- present and does nothing.
--
-- audit_logs is excluded: its seller_id is a plain, nullable column (no FK -
-- an audit row must survive the seller it describes being deleted), and a
-- policy comparing NULL to the current tenant would silently discard exactly
-- the platform-level entries an audit trail exists to keep.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'marketplace_accounts','marketplace_connection_requests','orders',
    'order_items','packages','package_items','shipments'
  ] LOOP
    EXECUTE format('ALTER TABLE scheduling.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE scheduling.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON scheduling.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON scheduling.%I USING (seller_id = current_setting(''app.current_tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

-- marketplaces is a global lookup (four rows, no seller_id) and is read by
-- every tenant. It carries no tenant data, so it is readable without a
-- policy - the alternative would be duplicating the same four rows per
-- tenant to satisfy a rule that protects nothing.
