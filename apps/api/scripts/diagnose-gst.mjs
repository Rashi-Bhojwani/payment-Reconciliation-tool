// Answers, against your real database, why the GST & Tax page says
// "No invoices yet".
//
// There are only four possible reasons, and they need completely different
// fixes, so guessing between them wastes a day:
//
//   1. No GST sync has ever been attempted.
//   2. Syncs were attempted and Amazon refused them - almost always a 403
//      naming the Tax Invoicing role, which means the refresh token in use
//      predates that role being granted.
//   3. Syncs succeeded but stored nothing, because Amazon had no invoices for
//      the period asked for.
//   4. Invoices ARE stored, just not in the date range the page is showing.
//
// READ-ONLY. It selects and prints; it writes nothing. Safe against
// production, which is the point - the answer only exists there.
//
//   DATABASE_URL="postgres://..." node apps/api/scripts/diagnose-gst.mjs [tenantId]
//
// With no tenant id it reports on every active tenant.
import pg from 'pg';
import { envFileLoadedFrom } from '@recon/db/env.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  console.error(envFileLoadedFrom() ? `(.env loaded from ${envFileLoadedFrom()})` : '(no .env found)');
  process.exit(1);
}

const GST_TYPES = ['GET_GST_MTR_B2B_CUSTOM', 'GET_GST_MTR_B2C_CUSTOM'];
const onlyTenant = process.argv[2] ?? null;

// The RLS policies compare against app.current_tenant_id, so a per-tenant
// connection is needed to read the tenant-scoped tables at all. tenants itself
// carries no policy.
const client = new pg.Client({ connectionString: url, ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false } });
await client.connect();

const heading = text => console.log(`\n${text}\n${'-'.repeat(text.length)}`);
const asDate = value => (value ? new Date(value).toISOString().slice(0, 10) : '—');

try {
  const { rows: tenants } = await client.query(
    onlyTenant
      ? 'select id, company_name from tenants where id = $1'
      : "select id, company_name from tenants where status = 'active' order by company_name",
    onlyTenant ? [onlyTenant] : [],
  );
  if (!tenants.length) {
    console.log(onlyTenant ? `No tenant with id ${onlyTenant}.` : 'No active tenants.');
    process.exit(0);
  }

  for (const tenant of tenants) {
    heading(`${tenant.company_name}  (${tenant.id})`);
    await client.query('select set_config($1,$2,false)', ['app.current_tenant_id', tenant.id]);

    // --- 1. is Amazon connected, and when was the token last issued? -------
    const { rows: [seller] } = await client.query(
      'select amazon_seller_id, connected_at, first_authorized_at from sellers where tenant_id = $1 order by connected_at desc limit 1',
      [tenant.id],
    );
    if (!seller) {
      console.log('Amazon is not connected at all. Settings -> Amazon Connection -> Connect.');
      continue;
    }
    console.log(`Amazon seller  : ${seller.amazon_seller_id}`);
    console.log(`Token issued   : ${seller.connected_at ? new Date(seller.connected_at).toISOString() : '—'}`);
    console.log('                 ^ THE KEY DATE. An SP-API refresh token carries the roles the');
    console.log('                   application had when the seller authorized it. If Tax Invoicing');
    console.log('                   was granted AFTER this timestamp, this token still cannot read');
    console.log('                   GST - re-authorize (Settings -> Amazon Connection) to reissue it.');

    // --- 2. what have the GST syncs actually done? -------------------------
    const { rows: jobs } = await client.query(
      `select report_type, status, source, started_at, completed_at, error_message
         from sync_jobs
        where tenant_id = $1 and report_type = any($2)
        order by started_at desc nulls last
        limit 10`,
      [tenant.id, GST_TYPES],
    );
    console.log(`\nGST sync attempts: ${jobs.length === 0 ? 'NONE EVER' : jobs.length + ' most recent'}`);
    for (const job of jobs) {
      const when = job.started_at ? new Date(job.started_at).toISOString().replace('T', ' ').slice(0, 19) : '—';
      console.log(`  ${when}  ${job.report_type.replace('GET_GST_MTR_', '').replace('_CUSTOM', '').padEnd(4)} ${job.status.padEnd(9)} ${job.source}`);
      if (job.error_message) console.log(`      Amazon said: ${job.error_message}`);
    }

    // --- 3. what is actually stored? ---------------------------------------
    const { rows: [stored] } = await client.query(
      `select count(*)::int as rows,
              count(*) filter (where invoice_type = 'b2b')::int as b2b,
              count(*) filter (where invoice_type = 'b2c')::int as b2c,
              min(invoice_date) as earliest, max(invoice_date) as latest,
              coalesce(sum(taxable_value), 0) as taxable,
              coalesce(sum(cgst + sgst + igst), 0) as tax
         from gst_invoices where tenant_id = $1`,
      [tenant.id],
    );
    console.log(`\nStored invoices  : ${stored.rows} (${stored.b2b} B2B, ${stored.b2c} B2C)`);
    if (stored.rows > 0) {
      console.log(`Covering         : ${asDate(stored.earliest)} -> ${asDate(stored.latest)}`);
      console.log(`Taxable value    : ${Number(stored.taxable).toFixed(2)}`);
      console.log(`Tax (C+S+I)      : ${Number(stored.tax).toFixed(2)}`);

      // Which months actually have data, so a range that shows nothing is
      // obviously a range problem rather than a sync problem.
      const { rows: months } = await client.query(
        `select to_char(invoice_date, 'YYYY-MM') as month, count(*)::int as rows
           from gst_invoices where tenant_id = $1 and invoice_date is not null
          group by 1 order by 1 desc limit 12`,
        [tenant.id],
      );
      console.log('By month         : ' + months.map(m => `${m.month}=${m.rows}`).join('  '));
    }

    // --- the verdict -------------------------------------------------------
    // Deliberately NOT filtered on status === 'failed'. Until this was fixed,
    // a GST report Amazon refused outright was recorded as 'completed' with
    // the 403 sitting in error_message - so keying off status would have
    // reported "Amazon returned an empty report" for the exact case this
    // script exists to identify. Historic rows written before that fix still
    // say 'completed', so the message is what to trust here, not the status.
    const refused = jobs.find(job => /403|forbidden|unauthorized|Tax Invoicing|role/i.test(job.error_message ?? ''));
    console.log('\nVERDICT');
    if (stored.rows > 0) {
      console.log('  Invoices ARE stored. If the page still says "No invoices yet", the date range');
      console.log('  selected on the dashboard does not overlap the months listed above - change');
      console.log('  the range to one of them.');
    } else if (jobs.length === 0) {
      console.log('  No GST sync has ever run for this tenant. Reports page -> sync');
      console.log('  GET_GST_MTR_B2B_CUSTOM and GET_GST_MTR_B2C_CUSTOM.');
    } else if (refused) {
      const tokenAge = seller.connected_at ? new Date(seller.connected_at).toISOString().replace('T', ' ').slice(0, 16) : 'unknown';
      const refusedAt = refused.started_at ? new Date(refused.started_at).toISOString().replace('T', ' ').slice(0, 16) : 'unknown';
      console.log('  Amazon REFUSED the sync (see the error above). This is a permissions answer,');
      console.log('  not a data answer - the report was never produced.');
      console.log(`\n  Token in use was issued : ${tokenAge}`);
      console.log(`  Amazon refused at       : ${refusedAt}`);
      console.log('\n  If you granted Tax Invoicing in Developer Central BEFORE the token date above,');
      console.log('  and it is still refusing, then the role is not actually attached to the');
      console.log('  application Amazon sees - check Developer Central shows it as approved, not');
      console.log('  merely requested, and that this app is the one it was approved for.');
      console.log('  Otherwise: re-authorize (Settings -> Amazon Connection) to reissue the token');
      console.log('  with the role, then sync again. A token only ever carries the roles the');
      console.log('  application held at the moment it was issued.');
    } else if (jobs.some(job => job.status === 'completed')) {
      console.log('  A GST sync completed but stored nothing, so Amazon returned an empty report');
      console.log('  for the period requested. Amazon India generates the MTR after a month closes -');
      console.log('  try a range covering a fully finished month, and check the same month exists in');
      console.log('  Seller Central under Reports -> Tax Document Library.');
    } else {
      console.log('  GST syncs are recorded but none has completed. Check the errors above.');
    }
  }
} finally {
  await client.query("select set_config('app.current_tenant_id','',false)").catch(() => undefined);
  await client.end();
}
