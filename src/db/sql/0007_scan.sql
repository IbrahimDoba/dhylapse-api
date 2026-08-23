-- Support for the nightly expiry scan.
--
-- The scan is inherently cross-tenant: it has to walk every organization. RLS
-- makes that impossible for the app role, which is the point — so rather than
-- giving the worker a privileged connection that bypasses isolation entirely,
-- expose one function that returns just the organization list. The scan then
-- processes each tenant through the normal withTenant path, fully inside RLS.
--
-- A worker with BYPASSRLS would be simpler and much worse: every query it ran
-- would be unprotected, forever, for the convenience of one enumeration.

CREATE OR REPLACE FUNCTION organizations_to_scan()
RETURNS TABLE (id uuid, name text, timezone text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.id, o.name, o.timezone
    FROM organization o
   WHERE o.deleted_at IS NULL
     AND o.billing_status <> 'cancelled'
   ORDER BY o.id;
$$;

REVOKE ALL ON FUNCTION organizations_to_scan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION organizations_to_scan() TO dhylapse_app;

-- Recipients for an organization's alerts. Same reasoning: the scan needs to
-- resolve who to notify while acting for that tenant, and membership is
-- already visible under RLS — but app_user is not tenant-scoped, so the join
-- is wrapped here rather than left to an unscoped query in application code.
CREATE OR REPLACE FUNCTION alert_recipients(p_organization_id uuid)
RETURNS TABLE (user_id uuid, email text, name text, role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.email, u.name, m.role
    FROM membership m
    JOIN app_user u ON u.id = m.user_id
   WHERE m.organization_id = p_organization_id
     AND m.status = 'active'
     AND m.deleted_at IS NULL
     AND u.deleted_at IS NULL;
$$;

REVOKE ALL ON FUNCTION alert_recipients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alert_recipients(uuid) TO dhylapse_app;

-- Job runs are system rows with no organization_id, so they cannot be written
-- under the tenant policy — its WITH CHECK requires the row to belong to the
-- current tenant. Rather than loosening that policy (which would also let a
-- tenant forge global drug_catalog and recall rows), the scan records its run
-- through this function.

CREATE OR REPLACE FUNCTION record_job_run(
  p_job_name    text,
  p_status      text,
  p_duration_ms int,
  p_stats       jsonb,
  p_error       text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO job_run (job_name, status, finished_at, duration_ms, stats, error)
  VALUES (p_job_name, p_status, now(), p_duration_ms, p_stats, p_error)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION record_job_run(text, text, int, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_job_run(text, text, int, jsonb, text) TO dhylapse_app;
