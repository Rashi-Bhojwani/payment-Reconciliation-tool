-- Diagnostic: which table/row is producing an implausibly old data_floor_date?
-- Usage: psql "$DATABASE_URL" -v tenant_id="'<tenant-uuid>'" -f apps/api/scripts/find-earliest-date-source.sql
-- (or paste the query below into any Postgres client, substituting the tenant id literal)

select 'sellers.data_floor_date' as source, data_floor_date as earliest_date, id::text as row_id
from sellers where tenant_id = :tenant_id
union all
select 'orders.order_date', min(order_date)::date, min(order_date)::text
from orders where tenant_id = :tenant_id
union all
select 'settlement_rows.posted_date', min(posted_date)::date, min(posted_date)::text
from settlement_rows where tenant_id = :tenant_id
union all
select 'sales_traffic_daily.date', min(date), min(date)::text
from sales_traffic_daily where tenant_id = :tenant_id
union all
select 'gst_invoices.invoice_date', min(invoice_date), min(invoice_date)::text
from gst_invoices where tenant_id = :tenant_id
union all
select 'reimbursements.reimbursement_date', min(reimbursement_date), min(reimbursement_date)::text
from reimbursements where tenant_id = :tenant_id
union all
select 'returns.return_date', min(return_date), min(return_date)::text
from returns where tenant_id = :tenant_id
order by earliest_date nulls last;
