#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh into an EMPTY database and an EMPTY media directory, then proves the result: every table's row
# count must equal the count recorded at backup time. It never overwrites anything: a target that already holds data is refused.
#
#   scripts/restore.sh <backup-folder> [config-file]
#
# Settings (environment, or a KEY=value file passed as the second argument: keep it chmod 600):
#   RESTORE_DATABASE_URL   required. libpq URL of the EMPTY target database, as its owner (wab_migrator).
#   RESTORE_MEDIA_DIR      where the media goes (default ./data/media). Must be empty or absent.
#   BACKUP_AGE_IDENTITY    path to your `age` secret key file: required when the backup is encrypted.
#
# To restore onto a new server: start only Postgres (docker compose -f docker-compose.prod.yml up -d postgres: its first start creates the
# roles and an empty `wab` database), run this, then start everything. To rehearse (recommended, monthly): create a scratch database owned by
# wab_migrator, point RESTORE_DATABASE_URL at it and a scratch RESTORE_MEDIA_DIR, and read the verdict. See docs/operations/backup-restore.md.
set -euo pipefail
umask 077

folder=${1:-}
[ -d "$folder" ] || { echo "usage: scripts/restore.sh <backup-folder> [config-file]" >&2; exit 2; }
if [ -n "${2:-}" ]; then
  # shellcheck disable=SC1090
  set -a; . "$2"; set +a
fi
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required (see the header of this script)}"
MEDIA_TARGET=${RESTORE_MEDIA_DIR:-./data/media}

for tool in pg_restore psql tar sha256sum; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done

echo "checking the backup files"
[ -f "$folder/SHA256SUMS" ] || { echo "no SHA256SUMS in $folder: not a backup folder" >&2; exit 1; }
(cd "$folder" && sha256sum --check --quiet SHA256SUMS) || { echo "the backup files do not match their checksums: do not restore from this folder" >&2; exit 1; }

# Refuse a target that already holds anything.
table_count=$(psql "$RESTORE_DATABASE_URL" --no-psqlrc -X -q -A -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')")
if [ "$table_count" != "0" ]; then
  echo "refusing: the target database already has $table_count tables. Restore only into an empty database (drop and recreate it first, as a superuser)." >&2
  exit 1
fi
if [ -d "$MEDIA_TARGET" ] && [ -n "$(find "$MEDIA_TARGET" -mindepth 1 -print -quit)" ]; then
  echo "refusing: $MEDIA_TARGET is not empty. Restore only into an empty media directory." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf -- "${work:?}"' EXIT

# Prints the path of a backup file, decrypting it into $work first when the backup is encrypted.
# Returns 3 when the backup simply has no such file, and 1 when it has it but it cannot be read (no key, wrong key).
plain() {
  local name=$1
  if [ -f "$folder/$name" ]; then echo "$folder/$name"; return 0; fi
  if [ -f "$folder/$name.age" ]; then
    if [ -z "${BACKUP_AGE_IDENTITY:-}" ]; then echo "this backup is encrypted: set BACKUP_AGE_IDENTITY to your age secret key file" >&2; return 1; fi
    command -v age >/dev/null || { echo "missing tool: age" >&2; return 1; }
    age --decrypt --identity "$BACKUP_AGE_IDENTITY" --output "$work/$name" "$folder/$name.age" || { echo "could not decrypt $name.age: is BACKUP_AGE_IDENTITY the key for this backup?" >&2; return 1; }
    echo "$work/$name"
    return 0
  fi
  return 3
}

# Open everything BEFORE touching the target, so a wrong key can never leave a half-restored database.
dump=$(plain db.dump) || { [ $? -eq 3 ] && echo "no database dump in $folder" >&2; exit 1; }
media=
media_status=0
media=$(plain media.tar) || media_status=$?
if [ "$media_status" -ne 0 ] && [ "$media_status" -ne 3 ]; then exit 1; fi

echo "restoring the database"
pg_restore --exit-on-error --single-transaction --dbname="$RESTORE_DATABASE_URL" "$dump"

echo "verifying row counts against the backup"
actual="$work/counts.actual"
psql "$RESTORE_DATABASE_URL" --no-psqlrc -X -q -A -t -c "SELECT table_schema || '.' || table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema IN ('public', 'drizzle') AND table_type = 'BASE TABLE' ORDER BY 1" >"$actual"
if ! diff -u "$folder/counts.txt" "$actual" >"$work/counts.diff"; then
  echo "MISMATCH: the restored database does not hold what was backed up:" >&2
  cat "$work/counts.diff" >&2
  exit 1
fi
tables=$(wc -l <"$actual" | tr -d ' ')
rows=$(awk -F'|' '{ sum += $2 } END { print sum + 0 }' "$actual")

if [ -n "$media" ]; then
  echo "restoring media"
  mkdir -p "$MEDIA_TARGET"
  tar -C "$MEDIA_TARGET" --strip-components=1 -xf "$media"
  expected=$(tr -d ' \n' <"$folder/media-files.txt")
  restored=$(find "$MEDIA_TARGET" -type f | wc -l | tr -d ' ')
  if [ "$expected" != "$restored" ]; then
    echo "MISMATCH: the backup recorded $expected media files, $restored were restored" >&2
    exit 1
  fi
  media_note="$restored media files"
else
  media_note="no media archive in this backup"
fi

echo "RESTORE VERIFIED: $tables tables, $rows rows all equal the backup; $media_note."
echo "next: start the stack (docker compose -f docker-compose.prod.yml up -d). Migrations are a no-op for a current backup. Queues start empty: the sweeper re-queues any unprocessed webhook event."
