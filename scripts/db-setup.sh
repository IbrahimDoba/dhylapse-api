#!/usr/bin/env bash
#
# Applies the full database setup in the required order.
#
#   ./scripts/db-setup.sh          apply to the existing database
#   ./scripts/db-setup.sh --reset  drop and recreate first (destroys all data)
#
# The order matters: migrations alone leave you with a schema that has no
# tenant isolation and no ledger enforcement, and nothing surfaces it.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }

: "${DATABASE_MIGRATION_URL:?set DATABASE_MIGRATION_URL (privileged connection)}"
DB_NAME="$(basename "${DATABASE_MIGRATION_URL%%\?*}")"

if [ "${1:-}" = "--reset" ]; then
  echo "==> dropping and recreating $DB_NAME"
  ADMIN_URL="${DATABASE_MIGRATION_URL%/*}/postgres"
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)"
  psql "$ADMIN_URL" -q -c "CREATE DATABASE \"$DB_NAME\""
fi

echo "==> 1/6 extensions"
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -q -f src/db/sql/0001_extensions.sql

echo "==> 2/6 migrations"
npx drizzle-kit migrate >/dev/null

echo "==> 3/6 row-level security"
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -q -f src/db/sql/0002_rls.sql

echo "==> 4/6 ledger triggers and constraints"
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -q -f src/db/sql/0004_derived.sql

echo "==> 5/6 application role"
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -q -f src/db/sql/0005_app_role.sql

echo "==> 6/6 signup bootstrap function"
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -q -f src/db/sql/0006_bootstrap.sql

TABLES=$(psql "$DATABASE_MIGRATION_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
echo "==> done — $TABLES tables"
