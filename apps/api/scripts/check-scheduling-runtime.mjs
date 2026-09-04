// Drives the ported scheduling repositories through their REAL pool against a
// real database, and asserts they come back with rows.
//
// check-scheduling-isolation.mjs proves the policies work. This proves the
// application can still get past them, which is a different claim and, after
// this merge, the more fragile one. Three things about the port could each
// silently produce "no rows" rather than an error:
//
//   * the tenant is never bound, so FORCE row-level security filters
//     everything (see db/pool.js);
//   * search_path resolves an unqualified `orders` to public.orders -
//     reconciliation's own, completely different table;
//   * a join written as `JOIN sellers` resolves to public.sellers, whose id is
//     a seller row id and never a tenant id, so nothing matches.
//
// All three look identical from the outside: an empty orders page. So this
// plants one order for one tenant, reads it back through the same repository
// functions the routes call, and fails loudly if any layer eats it.
//
// Opt-in, like check:sql and check:scheduling-isolation - it needs a throwaway
// database. Point DATABASE_URL at one, run the migrations, then run this.
import pg from 'pg';
import { envFileLoadedFrom } from '@recon/db/env.js';
import {
  marketplaceAccountsRepo,
  marketplacesRepo,
  ordersRepo,
  packagesRepo,
  shipmentsRepo,
  schedulingPool,
  withSchedulingTenant,
  closeSchedulingPool,
} from '@recon/order-scheduler';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Point it at a THROWAWAY database - this script writes and deletes rows.');
  console.error(envFileLoadedFrom() ? `(.env loaded from ${envFileLoadedFrom()})` : '(no .env found)');
  process.exit(1);
}

const TENANT_A = '33333333-3333-3333-3333-333333333333';
const TENANT_B = '44444444-4444-4444-4444-444444444444';
const MARKER = 'runtime-check';

const failures = [];
const check = (ok, description, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${description}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(description);
};
const skip = (description, reason) => console.log(`skip ${description} - ${reason}`);

// Whether THIS pool's role is exempt from row-level security. A superuser (or
// a role with BYPASSRLS) sees every row no matter what the policies say, so an
// isolation assertion made over such a connection would fail and mean nothing.
// A scratch database is very often exactly that - `postgres` over a unix
// socket - so the isolation part of this script is skipped with a reason
// rather than reported as a false failure. check:scheduling-isolation covers
// the same ground properly: it creates its own unprivileged role for it.
const { rows: [role] } = await schedulingPool.query(
  'select rolsuper as superuser, rolbypassrls as bypassrls from pg_roles where rolname = current_user'
);
const rlsApplies = !role?.superuser && !role?.bypassrls;

const admin = new pg.Client({ connectionString: url });
await admin.connect();

try {
  await admin.query('begin');
  for (const [id, name] of [[TENANT_A, `${MARKER} A`], [TENANT_B, `${MARKER} B`]]) {
    await admin.query(
      `insert into tenants (id, company_name, status) values ($1,$2,'active')
       on conflict (id) do update set company_name = excluded.company_name`,
      [id, name]
    );
  }
  await admin.query('commit');

  // --- writes, through the repositories, inside a tenant scope -------------
  const planted = await withSchedulingTenant(TENANT_A, async () => {
    const marketplace = await marketplacesRepo.findByCode('AMAZON');
    check(Boolean(marketplace), 'the AMAZON marketplace row is readable without a tenant scope');

    const account = await marketplaceAccountsRepo.create(TENANT_A, {
      marketplaceId: marketplace.id,
      region: 'eu-west-1',
      displayName: MARKER,
      metadata: { amazonMarketplaceId: 'A21TJRUUN4KGV' },
    });
    check(Boolean(account?.id), 'a marketplace account can be created through the repository');

    const { rows: [order] } = await admin.query(
      `insert into scheduling.orders
         (seller_id, marketplace_id, marketplace_account_id, external_order_id,
          order_date, last_updated_date, internal_status)
       values ($1,$2,$3,$4, now(), now(), 'READY_FOR_REVIEW') returning id`,
      [TENANT_A, marketplace.id, account.id, `${MARKER}-403-1234567-1234567`]
    );
    return { marketplace, account, orderId: order.id };
  });

  // --- reads, through the exact functions the routes call ------------------
  await withSchedulingTenant(TENANT_A, async () => {
    // The one that catches an unqualified `orders` resolving to public.orders:
    // that table has no internal_status column at all, so this would throw
    // rather than return a row.
    const found = await ordersRepo.findById(TENANT_A, planted.orderId);
    check(found?.external_order_id === `${MARKER}-403-1234567-1234567`,
      'ordersRepo.findById resolves to scheduling.orders and returns the row',
      found ? `internal_status=${found.internal_status}` : 'got null');

    // The one that catches `JOIN sellers` - listForMarketplace joins tenants
    // for the seller name, and a wrong join silently returns zero rows.
    const forMarketplace = await ordersRepo.listForMarketplace(planted.marketplace.id, [TENANT_A], {});
    check(forMarketplace.total === 1 && forMarketplace.rows[0]?.seller_name === `${MARKER} A`,
      'the cross-tenant order list joins public.tenants for the seller name',
      `total=${forMarketplace.total} seller_name=${forMarketplace.rows[0]?.seller_name ?? 'null'}`);

    const list = await ordersRepo.list(TENANT_A, { limit: 10 });
    check(list.total === 1, 'the per-tenant order list returns the planted order', `total=${list.total}`);

    // Returns a { status: count } object, not rows - the shape the overview
    // route hands straight to the UI.
    const counts = await ordersRepo.countsByInternalStatus(TENANT_A);
    check(counts.READY_FOR_REVIEW === 1, 'status counts are computed inside the tenant scope',
      JSON.stringify(counts));

    // getOrCreatePrimary writes; a write with the wrong tenant bound would be
    // rejected by the policy's WITH CHECK rather than silently misfiled.
    const pkg = await packagesRepo.getOrCreatePrimary(TENANT_A, planted.orderId);
    check(Boolean(pkg?.id) && pkg.package_number === 1, 'a primary package can be created for the order');
    check(packagesRepo.isComplete(pkg) === false, 'a freshly created package is correctly reported incomplete');

    const shipments = await shipmentsRepo.list([TENANT_A], {});
    check(shipments.total === 0, 'the shipments list runs its tenants join and returns nothing yet',
      `total=${shipments.total}`);

    const accounts = await marketplaceAccountsRepo.listBySeller(TENANT_A);
    check(accounts.length === 1, 'the account list returns exactly this tenant\'s account');
  });

  // --- the isolation claim, restated at the repository level ---------------
  const isolationCheck = 'another tenant\'s scope cannot read the order even with the right id and seller id';
  if (rlsApplies) {
    await withSchedulingTenant(TENANT_B, async () => {
      const leaked = await ordersRepo.findById(TENANT_A, planted.orderId);
      check(leaked === null, isolationCheck, leaked ? `LEAKED ${leaked.external_order_id}` : '');
    });
  } else {
    skip(isolationCheck, 'this DATABASE_URL connects as a superuser or a BYPASSRLS role, which is exempt from every policy; run check:scheduling-isolation, which makes its own unprivileged role');
  }

  // --- the guard against the silent-zero-rows failure ---------------------
  let guarded = false;
  let guardMessage = '';
  try {
    await ordersRepo.list(TENANT_A, { limit: 1 });
  } catch (error) {
    guarded = /no tenant bound/i.test(error.message);
    guardMessage = error.message;
  }
  check(guarded,
    'a repository call with NO tenant scope raises instead of quietly returning nothing',
    guarded ? '' : `got: ${guardMessage || 'no error at all'}`);
} finally {
  await admin.query('begin');
  await admin.query('delete from scheduling.orders where external_order_id like $1', [`${MARKER}%`]);
  await admin.query('delete from scheduling.marketplace_accounts where display_name = $1', [MARKER]);
  await admin.query('delete from tenants where company_name like $1', [`${MARKER}%`]);
  await admin.query('commit');
  await admin.end();
  await closeSchedulingPool();
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll scheduling runtime checks passed.');
process.exit(failures.length ? 1 : 0);
