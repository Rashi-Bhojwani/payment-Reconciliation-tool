// Proves, against a real Postgres carrying this repo's own migrations, that a
// tenant cannot read another tenant's order-scheduling rows.
//
// This exists because the scheduling merge's entire safety argument is "the
// scheduling tables are protected by the same row-level security as the
// reconciliation tables". That is a claim about a running database, not about
// source code: a policy can be present and still do nothing (the table owner
// is exempt unless FORCE is set, a policy can be created on the wrong table,
// an ALTER can drop it). Reading migration 025 cannot tell you whether it
// worked. Connecting as a non-superuser and trying to read another tenant's
// order can.
//
// Opt-in, like check:sql - it needs a throwaway database, so it is not part of
// `npm run check`. Point DATABASE_URL at a scratch database, run the
// migrations, then run this.
import pg from 'pg';
import { envFileLoadedFrom } from '@recon/db/env.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Point it at a THROWAWAY database - this script writes and deletes rows.');
  console.error(envFileLoadedFrom() ? `(.env loaded from ${envFileLoadedFrom()})` : '(no .env found)');
  process.exit(1);
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
// Distinctive enough that a leaked row is unmistakable in the output, and
// distinctive enough to clean up afterwards without touching real data.
const MARKER = 'isolation-check';

const admin = new pg.Client({ connectionString: url });
await admin.connect();

const failures = [];
const check = (ok, description, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${description}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(description);
};

try {
  const { rows: [{ superuser }] } = await admin.query(
    'select usesuper as superuser from pg_user where usename = current_user'
  );

  await admin.query('begin');
  // A role with no BYPASSRLS and no ownership - the only kind of connection
  // this proves anything about. Testing as the migration's own owner would
  // pass whether the policies work or not.
  await admin.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'scheduling_isolation_probe') then
        create role scheduling_isolation_probe login;
      end if;
    end $$;
  `);
  await admin.query('grant usage on schema public, scheduling to scheduling_isolation_probe');
  await admin.query('grant select, insert, update, delete on all tables in schema public to scheduling_isolation_probe');
  await admin.query('grant select, insert, update, delete on all tables in schema scheduling to scheduling_isolation_probe');

  for (const [id, name] of [[TENANT_A, `${MARKER} A`], [TENANT_B, `${MARKER} B`]]) {
    await admin.query(
      `insert into tenants (id, company_name, status) values ($1,$2,'active')
       on conflict (id) do update set company_name = excluded.company_name`,
      [id, name]
    );
    const { rows: [account] } = await admin.query(
      `insert into scheduling.marketplace_accounts (seller_id, marketplace_id, region, status, display_name)
       values ($1, (select id from scheduling.marketplaces where code='AMAZON'), 'IN', 'AUTHORIZED', $2)
       returning id`,
      [id, MARKER]
    );
    await admin.query(
      `insert into scheduling.orders (seller_id, marketplace_id, marketplace_account_id, external_order_id, order_date, last_updated_date)
       values ($1, (select id from scheduling.marketplaces where code='AMAZON'), $2, $3, now(), now())`,
      [id, account.id, `${MARKER}-${id.slice(0, 8)}`]
    );
  }
  await admin.query('commit');

  // The probe must connect as the unprivileged role, and getting that wrong
  // is the whole ballgame: node-postgres lets a connectionString win over a
  // sibling `user` option, so `new pg.Client({ connectionString: url, user:
  // 'probe' })` - the obvious spelling - silently connects as whoever the URL
  // names. Here that is the superuser, and every check below then passes for
  // the wrong reason, because superusers bypass row-level security entirely.
  // Caught exactly that way while writing this: the "leak" it reported was
  // real superuser access, not a broken policy.
  //
  // So no connectionString at all. The admin client has already resolved the
  // URL into discrete parameters; reusing those with `user` replaced leaves
  // nothing for a precedence rule to override. It also handles connection
  // strings that are not valid WHATWG URLs - a unix-socket DSN like
  // `postgres://postgres@/db?host=/tmp` has an empty host and makes `new
  // URL()` throw, which an earlier version of this did.
  const { host, port, database, ssl } = admin.connectionParameters;
  const probe = new pg.Client({
    host, port, database, ssl,
    user: 'scheduling_isolation_probe',
    password: undefined,
  });
  await probe.connect();
  try {
    await probe.query('select set_config($1,$2,false)', ['app.current_tenant_id', TENANT_A]);

    const visible = await probe.query(
      'select seller_id, external_order_id from scheduling.orders where external_order_id like $1',
      [`${MARKER}%`]
    );
    check(
      visible.rows.length === 1 && visible.rows[0].seller_id === TENANT_A,
      'a tenant sees only its own scheduling orders',
      `saw ${visible.rows.length} row(s)`
    );

    // The one that matters: not "the default query filters correctly" but
    // "asking for another tenant's row by id returns nothing".
    const targeted = await probe.query(
      'select external_order_id from scheduling.orders where seller_id = $1',
      [TENANT_B]
    );
    check(targeted.rows.length === 0, 'another tenant\'s order is unreachable even when asked for by seller_id',
      targeted.rows.length ? `LEAKED ${targeted.rows[0].external_order_id}` : '');

    // Writing across the boundary must fail too - a policy that only filters
    // reads still lets one tenant plant rows in another's account.
    let insertBlocked = false;
    try {
      await probe.query(
        `insert into scheduling.orders (seller_id, marketplace_id, marketplace_account_id, external_order_id, order_date, last_updated_date)
         select $1, marketplace_id, id, $2, now(), now() from scheduling.marketplace_accounts limit 1`,
        [TENANT_B, `${MARKER}-cross-write`]
      );
    } catch {
      insertBlocked = true;
    }
    check(insertBlocked, 'a tenant cannot insert a scheduling order against another tenant');

    // Releasing a pooled connection means clearing the setting, and the only
    // way to clear a GUC is to set it to ''. So the very next borrower of that
    // connection evaluates the policy with an empty string - and if the policy
    // casts that to uuid, the query does not return zero rows, it raises
    // "invalid input syntax for type uuid". That is a 500 on an unrelated
    // later request, on a connection that happens to be reused: intermittent,
    // unattributable, and effectively impossible to reproduce on demand.
    // Whether the policy compares as text is therefore not a style question,
    // and this asserts it against the running database rather than the SQL
    // file.
    await probe.query("select set_config('app.current_tenant_id','',false)");
    let clearedIsUsable = false;
    let clearedRows = -1;
    try {
      const cleared = await probe.query('select count(*)::int as n from scheduling.orders');
      clearedIsUsable = true;
      clearedRows = cleared.rows[0].n;
    } catch (error) {
      clearedIsUsable = false;
      clearedRows = error.message;
    }
    check(
      clearedIsUsable && clearedRows === 0,
      'a connection whose tenant was cleared returns no rows instead of erroring',
      clearedIsUsable ? `saw ${clearedRows} row(s)` : `raised: ${clearedRows}`
    );
    await probe.query('select set_config($1,$2,false)', ['app.current_tenant_id', TENANT_A]);

    for (const table of ['marketplace_accounts', 'order_items', 'packages', 'package_items', 'shipments', 'marketplace_connection_requests']) {
      const { rows: [policy] } = await admin.query(
        `select relrowsecurity as enabled, relforcerowsecurity as forced
           from pg_class where oid = ('scheduling.' || $1)::regclass`,
        [table]
      );
      check(policy?.enabled && policy?.forced, `scheduling.${table} has row-level security enabled and forced`);
    }
  } finally {
    await probe.end();
  }

  if (superuser) {
    console.log('note: connected as a superuser, so the planting/cleanup ran unrestricted - the checks themselves used a separate non-privileged role, which is what they are about.');
  }
} finally {
  await admin.query('begin');
  await admin.query('delete from scheduling.orders where external_order_id like $1', [`${MARKER}%`]);
  await admin.query('delete from scheduling.marketplace_accounts where display_name = $1', [MARKER]);
  await admin.query('delete from tenants where company_name like $1', [`${MARKER}%`]);
  await admin.query('commit');
  await admin.end();
}

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nAll isolation checks passed.');
process.exit(failures.length ? 1 : 0);
