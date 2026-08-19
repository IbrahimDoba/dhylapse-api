-- Row-level security: tenant isolation enforced by the database.
--
-- The application already scopes every query by organization_id. This is the
-- second lock. A forgotten WHERE clause in one handler should be a bug, not a
-- breach — and in a system where "your competitor saw my stock levels" is
-- fatal, one lock is not enough.
--
-- Contract: every request opens a transaction and sets
--     app.user_id          — who is asking
--     app.organization_id  — which tenant they are acting for (may be unset)
-- both transaction-local, so a pooled connection cannot leak them into the
-- next request.
--
-- Two dimensions rather than one, because a user has to be able to discover
-- which organizations they belong to *before* an organization is selected.
-- Identity answers that; the tenant key answers everything after it.

CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

-- The organization table is keyed on `id`, not `organization_id`, so it needs
-- its own policy. Without one, any app-role query can enumerate every tenant's
-- name, plan, and billing status.
--
-- Readable when it is the selected tenant, OR when the caller is an active
-- member of it — that second clause is what makes an org switcher possible
-- without exposing anything the user isn't already entitled to see.
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization
  USING (
    id = current_org_id()
    OR EXISTS (
      SELECT 1 FROM membership m
       WHERE m.organization_id = organization.id
         AND m.user_id = current_user_id()
         AND m.status = 'active'
         AND m.deleted_at IS NULL
    )
  )
  WITH CHECK (id = current_org_id());

-- app_user is deliberately NOT under RLS: better-auth must look a user up by
-- email at login, before any organization context exists. It is the credential
-- plane, keyed by person rather than tenant. Queries against it must be scoped
-- in application code — never expose a raw user search to end users.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'location', 'invitation',
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

-- membership is the join that makes the organization policy above work, so it
-- carries the same dual test: visible within the selected tenant, or when the
-- row is the caller's own.
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON membership
  USING (organization_id = current_org_id() OR user_id = current_user_id())
  WITH CHECK (organization_id = current_org_id());

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
