-- Dev/test bootstrap for Postgres. Idempotent; safe to run repeatedly.
--
--   wab_migrator  owns the databases and runs migrations (DDL).      -> DATABASE_MIGRATION_URL
--   wab_app       runtime role: DML only, append-only on audit_log.  -> DATABASE_URL
--
-- The passwords below are DEV-ONLY defaults. In production create the roles yourself with
-- strong passwords and point DATABASE_URL / DATABASE_MIGRATION_URL at them.
--
-- docker compose mounts this directory at /docker-entrypoint-initdb.d (runs once, on a fresh volume).
-- Natively:  psql -v ON_ERROR_STOP=1 -U postgres -f scripts/db-init/01-roles.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wab_migrator') THEN
    CREATE ROLE wab_migrator LOGIN PASSWORD 'wab_migrator_dev';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wab_app') THEN
    CREATE ROLE wab_app LOGIN PASSWORD 'wab_app_dev';
  END IF;
END
$$;

SELECT 'CREATE DATABASE wab OWNER wab_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'wab') \gexec

SELECT 'CREATE DATABASE wab_test OWNER wab_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'wab_test') \gexec

-- The integration tests restore a backup into this one (test/integration/backup-restore.test.ts), emptying it first.
SELECT 'CREATE DATABASE wab_restore_test OWNER wab_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'wab_restore_test') \gexec

ALTER DATABASE wab OWNER TO wab_migrator;
ALTER DATABASE wab_test OWNER TO wab_migrator;
ALTER DATABASE wab_restore_test OWNER TO wab_migrator;

GRANT CONNECT ON DATABASE wab TO wab_app;
GRANT CONNECT ON DATABASE wab_test TO wab_app;
GRANT CONNECT ON DATABASE wab_restore_test TO wab_app;
