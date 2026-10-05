#!/bin/bash
# Production bootstrap for Postgres. Runs ONCE, on a fresh data volume, as the image's init step (docker-entrypoint-initdb.d).
#
#   wab_migrator  owns the database and runs migrations (DDL).      -> used only by the one-shot `migrate` service
#   wab_app       runtime role: DML only, append-only on audit_log.  -> used by web and worker
#
# Passwords come from the compose environment (WAB_MIGRATOR_PASSWORD, WAB_APP_PASSWORD) and are passed to psql as variables and quoted by
# format(%L), so no password character can end the statement. Use URL-safe passwords (`openssl rand -hex 24`): they are also placed in
# connection URLs.
set -euo pipefail

: "${WAB_MIGRATOR_PASSWORD:?WAB_MIGRATOR_PASSWORD is required}"
: "${WAB_APP_PASSWORD:?WAB_APP_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v migrator_pw="$WAB_MIGRATOR_PASSWORD" -v app_pw="$WAB_APP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE wab_migrator LOGIN PASSWORD %L', :'migrator_pw') \gexec
SELECT format('CREATE ROLE wab_app LOGIN PASSWORD %L', :'app_pw') \gexec
CREATE DATABASE wab OWNER wab_migrator;
REVOKE ALL ON DATABASE wab FROM PUBLIC;
GRANT CONNECT ON DATABASE wab TO wab_app;
SQL
