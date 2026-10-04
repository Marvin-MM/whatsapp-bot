-- Least-privilege grants for the application role (wab_app). Hand-written, not generated.
--
-- The app role can read/write app tables but has NO DDL, and on audit_log it may only INSERT and SELECT:
-- the audit trail is append-only at the database level, not just by convention.
--
-- Fails loudly if the role is missing: silently skipping would leave the app role unrestricted
-- (or the app unable to connect). Create roles first with scripts/db-init/01-roles.sql.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wab_app') THEN
    RAISE EXCEPTION 'role wab_app does not exist; run scripts/db-init/01-roles.sql (or create it) before migrating';
  END IF;

  GRANT USAGE ON SCHEMA public TO wab_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wab_app;

  -- Tables created by later migrations (run by whoever runs the migrator) get the same grants.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wab_app;

  REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM wab_app;
END
$$;
