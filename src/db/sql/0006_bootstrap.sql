-- Signup bootstrap.
--
-- With RLS on `organization`, the app role cannot create one: the policy
-- requires id = current_org_id(), and at signup there is no organization yet.
-- Rather than punch a general hole in the policy or hand the server a
-- privileged connection, expose exactly one SECURITY DEFINER function that
-- performs the whole bootstrap atomically and nothing else.
--
-- SECURITY DEFINER runs with the owner's rights, so `search_path` is pinned —
-- otherwise a caller could shadow `organization` with their own table and have
-- this function write to it.

CREATE OR REPLACE FUNCTION bootstrap_organization(
  p_user_id        uuid,
  p_org_name       text,
  p_slug           text,
  p_location_name  text DEFAULT NULL,
  p_timezone       text DEFAULT 'Africa/Lagos',
  p_currency       text DEFAULT 'NGN',
  p_country        text DEFAULT 'NG'
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id      uuid;
  v_location_id uuid;
  v_threshold   int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = p_user_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'unknown user %', p_user_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO organization (name, slug, timezone, default_currency, country_code, created_by)
  VALUES (p_org_name, p_slug, p_timezone, upper(p_currency), upper(p_country), p_user_id)
  RETURNING id INTO v_org_id;

  -- Every organization has at least one location. Single-shop tenants never
  -- see the concept, but the inventory tables require one from day one.
  INSERT INTO location (organization_id, name, code, created_by)
  VALUES (v_org_id, COALESCE(p_location_name, p_org_name), 'MAIN', p_user_id)
  RETURNING id INTO v_location_id;

  INSERT INTO membership (organization_id, user_id, role, status, all_locations, created_by)
  VALUES (v_org_id, p_user_id, 'owner', 'active', true, p_user_id);

  -- Seed the default expiry ladder. These are rows, not constants, precisely so
  -- a pharmacy can change them without a deploy.
  FOREACH v_threshold IN ARRAY ARRAY[180, 90, 30, 7] LOOP
    INSERT INTO alert_rule (
      organization_id, name, kind, threshold_days, severity, channels, cadence, created_by
    ) VALUES (
      v_org_id,
      v_threshold || ' day expiry alert',
      'expiry',
      v_threshold,
      CASE v_threshold WHEN 7 THEN 1 WHEN 30 THEN 2 WHEN 90 THEN 3 ELSE 4 END,
      CASE WHEN v_threshold <= 7
           THEN '["in_app","email","push"]'::jsonb
           ELSE '["in_app","email"]'::jsonb END,
      CASE WHEN v_threshold <= 7 THEN 'immediate' ELSE 'daily_digest' END,
      p_user_id
    );
  END LOOP;

  INSERT INTO alert_rule (organization_id, name, kind, severity, cadence, created_by)
  VALUES (v_org_id, 'Low stock', 'low_stock', 3, 'daily_digest', p_user_id);

  RETURN v_org_id;
END $$;

REVOKE ALL ON FUNCTION bootstrap_organization(uuid, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bootstrap_organization(uuid, text, text, text, text, text, text)
  TO dhylapse_app;
