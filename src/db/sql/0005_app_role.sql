-- The role the application connects as.
--
-- This must NOT be a superuser and must NOT own the tables: Postgres exempts
-- both from row-level security, so an app connecting as the migration role has
-- tenant isolation silently disabled. The whole RLS layer depends on this file.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dhylapse_app') THEN
    CREATE ROLE dhylapse_app LOGIN PASSWORD 'dhylapse_app';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO dhylapse_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dhylapse_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dhylapse_app;

-- Tables created by future migrations need the same grants, or the app starts
-- throwing permission errors the first time a new table is queried.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dhylapse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dhylapse_app;

-- Belt and braces: make it impossible to accidentally grant this role a bypass.
ALTER ROLE dhylapse_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
