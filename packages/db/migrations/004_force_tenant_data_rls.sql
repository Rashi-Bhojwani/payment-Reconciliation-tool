DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['orders','settlement_rows','gst_invoices','returns','reimbursements','inventory_snapshots','sales_traffic_daily','fee_leak_flags','generated_reports','order_items','finance_transactions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
