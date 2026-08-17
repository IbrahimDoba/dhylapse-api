-- Row-level security: tenant isolation enforced by the database.
--
-- The application already scopes every query by organization_id. This is the
-- second lock. A forgotten WHERE clause in one handler should be a bug, not a
-- breach — and in a system where "your competitor saw my stock levels" is
-- fatal, one lock is not enough.
--
-- Contract: every request opens a transaction and sets
--     SET LOCAL app.organization_id = '<uuid>';
-- before touching any tenant table. LOCAL scopes it to the transaction, so a
-- pooled connection can never leak the setting into the next request.

CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid;
$$;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'location', 'membership', 'invitation',
    'product', 'product_category', 'product_location_setting', 'product_supplier',
    'supplier', 'unit_of_measure',
    'batch', 'stock_movement', 'stock_count', 'stock_count_line',
    'stock_transfer', 'stock_transfer_line',
    'alert_rule', 'alert_event', 'notification', 'notification_delivery',
    'notification_preference',
    'disposition', 'recall_batch', 'import_job', 'import_row', 'scan',
    'purchase_order', 'purchase_order_line', 'dispense', 'product_demand_stat',
    'attachment', 'org_setting', 'api_key',
    'webhook_endpoint', 'webhook_delivery', 'idempotency_key'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE applies the policy to the table owner too, so a migration or an
    -- admin script can't quietly bypass isolation.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (organization_id = current_org_id())
        WITH CHECK (organization_id = current_org_id())
    $f$, t);
  END LOOP;
END $$;

-- Tables with a NULLABLE organization_id hold shared reference data
-- (drug_catalog, recall, audit_log, job_run): rows owned by the tenant OR
-- global rows visible to everyone. Writes are restricted to owned rows.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['drug_catalog', 'recall', 'audit_log', 'job_run'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_or_global ON %I
        USING (organization_id IS NULL OR organization_id = current_org_id())
        WITH CHECK (organization_id = current_org_id())
    $f$, t);
  END LOOP;
END $$;

-- The migration/admin role bypasses RLS. The application role must NOT.
-- CREATE ROLE dhylapse_app NOLOGIN;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dhylapse_app;
