// Fixture builders. Everything a test needs to exist, created explicitly - no
// shared mutable state between test files.
//
// Two things changed in the port, and both come from the same fact: a
// scheduling "seller" is now a platform TENANT.
//
//  * createSeller() became createTenant(), writing public.tenants rather than
//    a scheduling-owned sellers table (migration 025 dropped that one).
//  * Every fixture that writes a scheduling table does so inside
//    withSchedulingTenant. Those tables are behind FORCE row-level security,
//    so an insert with no tenant bound is refused - the fixtures have to obey
//    the same rule the application does, which is a feature: a fixture that
//    could write across the boundary would prove nothing about a repository
//    that cannot.
import crypto from 'node:crypto';
import { admin, TEST_TENANT_PREFIX } from './db.js';
import { withSchedulingTenant } from '../../src/db/pool.js';

/** Run `fn` bound to a tenant. Re-entrant, so nesting these is safe. */
export const asTenant = withSchedulingTenant;

export async function createTenant(label = crypto.randomUUID().slice(0, 8)) {
  const { rows } = await admin.query(
    `insert into tenants (company_name, status) values ($1, 'active') returning *`,
    [`${TEST_TENANT_PREFIX} ${label}`],
  );
  return rows[0];
}

/** A platform user, for the fixtures that need a real users(id) to reference. */
export async function createUser(tenantId, label = crypto.randomUUID().slice(0, 8)) {
  const { rows } = await admin.query(
    `insert into users (tenant_id, email, password_hash, role, status)
     values ($1, $2, 'not-a-real-hash', 'user', 'active') returning *`,
    [tenantId, `${TEST_TENANT_PREFIX}-${label}@example.test`],
  );
  return rows[0];
}

export async function findMarketplace(code = 'AMAZON') {
  const { rows } = await admin.query('select * from scheduling.marketplaces where code = $1', [code]);
  return rows[0];
}

export async function createMarketplaceAccount(tenantId, overrides = {}) {
  const {
    marketplaceCode = 'AMAZON',
    externalAccountId = null,
    region = 'eu-west-1',
    status = 'AUTHORIZED',
    metadata = { amazonMarketplaceId: 'A21TJRUUN4KGV', fulfillmentMode: 'EASY_SHIP' },
  } = overrides;
  const marketplace = await findMarketplace(marketplaceCode);
  const account = await asTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `insert into marketplace_accounts (seller_id, marketplace_id, external_account_id, region, status, metadata, connected_at)
       values ($1, $2, $3, $4, $5::varchar, $6, case when $5::varchar = 'AUTHORIZED' then now() else null end)
       returning *`,
      [tenantId, marketplace.id, externalAccountId, region, status, JSON.stringify(metadata)],
    );
    return rows[0];
  });
  return { ...account, marketplace_code: marketplace.code };
}

export async function createOrder(tenantId, marketplaceAccountId, overrides = {}) {
  const {
    externalOrderId = `407-${Math.floor(Math.random() * 9e6 + 1e6)}-${Math.floor(Math.random() * 9e6 + 1e6)}`,
    marketplaceStatus = 'Unshipped',
    internalStatus = 'READY_FOR_REVIEW',
    shipByDate = new Date(Date.now() + 8 * 3600_000),
    deliveryByDate = new Date(Date.now() + 72 * 3600_000),
    orderDate = new Date(Date.now() - 3600_000),
  } = overrides;
  return asTenant(tenantId, async (client) => {
    const account = await client.query('select marketplace_id from marketplace_accounts where id = $1', [marketplaceAccountId]);
    const { rows } = await client.query(
      `insert into orders (seller_id, marketplace_id, marketplace_account_id, external_order_id,
                           order_date, last_updated_date, marketplace_status, fulfillment_channel,
                           ship_by_date, delivery_by_date, internal_status, order_total_amount, order_total_currency)
       values ($1, $2, $3, $4, $5, $5, $6, 'MFN', $7, $8, $9, 999.00, 'INR')
       returning *`,
      [tenantId, account.rows[0].marketplace_id, marketplaceAccountId, externalOrderId,
        orderDate, marketplaceStatus, shipByDate, deliveryByDate, internalStatus],
    );
    return rows[0];
  });
}

export async function createOrderItem(tenantId, orderId, overrides = {}) {
  const {
    externalProductId = `B0${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    sku = 'SKU-1',
    title = 'Test product',
    quantityOrdered = 1,
    unitPrice = 999.0,
  } = overrides;
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `insert into order_items (order_id, seller_id, external_item_id, external_product_id, sku, title,
                                quantity_ordered, unit_price, currency)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'INR') returning *`,
      [orderId, tenantId, `item-${crypto.randomUUID().slice(0, 12)}`, externalProductId, sku, title,
        quantityOrdered, unitPrice],
    );
    return rows[0];
  });
}

export async function createPackage(tenantId, orderId, overrides = {}) {
  const {
    packageNumber = 1,
    weightGrams = 500,
    lengthCm = 30,
    widthCm = 20,
    heightCm = 10,
    packageType = 'BOX',
  } = overrides;
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `insert into packages (order_id, seller_id, package_number, weight_grams, length_cm, width_cm, height_cm, package_type)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [orderId, tenantId, packageNumber, weightGrams, lengthCm, widthCm, heightCm, packageType],
    );
    return rows[0];
  });
}
