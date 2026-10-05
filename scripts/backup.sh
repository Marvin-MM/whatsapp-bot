#!/usr/bin/env bash
# Backs up the database (pg_dump, custom format) and the media directory into a timestamped folder.
#
#   scripts/backup.sh [config-file]
#
# Settings (environment, or a KEY=value file passed as the first argument: keep it chmod 600):
#   BACKUP_DATABASE_URL    required. libpq URL of the database, as the owning role (wab_migrator), e.g. postgres://wab_migrator:...@127.0.0.1:5432/wab
#   BACKUP_DIR             where backups go (default ./backups)
#   BACKUP_MEDIA_DIR       the media directory (default ./data/media)
#   BACKUP_ALLOW_NO_MEDIA  yes = accept a missing media directory (fresh install). Otherwise a missing one fails the backup.
#   BACKUP_KEEP            how many local backups to keep (default 14)
#   BACKUP_AGE_RECIPIENT   an `age` public key (age1...): encrypts the dump and the media archive. STRONGLY recommended.
#   BACKUP_RCLONE_REMOTE   an rclone destination (e.g. offsite:wab-backups): copies the backup off this server. Refused unless encrypted
#                          (override: BACKUP_ALLOW_UNENCRYPTED_UPLOAD=yes).
#
# What is NOT in a backup: your .env (keep it in a password manager: restoring needs it), Redis (queues are rebuilt by the sweeper), and the
# Caddy certificates (re-issued automatically). See docs/operations/backup-restore.md.
set -euo pipefail
umask 077

if [ -n "${1:-}" ]; then
  # shellcheck disable=SC1090
  set -a; . "$1"; set +a
fi

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required (see the header of this script)}"
BACKUP_DIR=${BACKUP_DIR:-./backups}
MEDIA_DIR=${BACKUP_MEDIA_DIR:-./data/media}
KEEP=${BACKUP_KEEP:-14}
RECIPIENT=${BACKUP_AGE_RECIPIENT:-}
REMOTE=${BACKUP_RCLONE_REMOTE:-}

case "$KEEP" in '' | *[!0-9]*) echo "BACKUP_KEEP must be a whole number" >&2; exit 2 ;; esac
for tool in pg_dump pg_restore psql tar sha256sum; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done
if [ -n "$RECIPIENT" ]; then command -v age >/dev/null || { echo "BACKUP_AGE_RECIPIENT is set but 'age' is not installed" >&2; exit 2; }; fi
if [ -n "$REMOTE" ]; then
  command -v rclone >/dev/null || { echo "BACKUP_RCLONE_REMOTE is set but 'rclone' is not installed" >&2; exit 2; }
  if [ -z "$RECIPIENT" ] && [ "${BACKUP_ALLOW_UNENCRYPTED_UPLOAD:-}" != "yes" ]; then
    echo "refusing to upload unencrypted customer data: set BACKUP_AGE_RECIPIENT (or BACKUP_ALLOW_UNENCRYPTED_UPLOAD=yes if you accept that)" >&2
    exit 2
  fi
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="$BACKUP_DIR/$stamp"
mkdir -p "$dest"
echo "backup $stamp -> $dest"
# A backup that failed half-way must not stay behind looking like one (and must never count towards retention).
finished=no
trap 'if [ "$finished" != yes ]; then rm -rf -- "${dest:?}"; echo "backup FAILED: nothing was kept" >&2; fi' EXIT

# One snapshot for both the dump and the row counts, so they describe the same instant even while messages keep arriving.
coproc SNAP { psql "$BACKUP_DATABASE_URL" --no-psqlrc -X -q -A -t -v ON_ERROR_STOP=1 2>&1; }
snap_in=${SNAP[1]}
snap_out=${SNAP[0]}
printf '%s\n' "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" "SELECT 'SNAPSHOT:' || pg_export_snapshot();" >&"$snap_in"
snapshot=
while IFS= read -r -t 30 line <&"$snap_out"; do
  case "$line" in
    SNAPSHOT:*) snapshot=${line#SNAPSHOT:}; break ;;
    *) echo "database: $line" >&2 ;;
  esac
done
[ -n "$snapshot" ] || { echo "could not open a snapshot on the database (is BACKUP_DATABASE_URL right?)" >&2; exit 1; }

pg_dump --format=custom --snapshot="$snapshot" --file="$dest/db.dump" "$BACKUP_DATABASE_URL"

# Exact row counts at the snapshot: restore.sh compares the restored database against these.
printf '%s\n' "SELECT table_schema || '.' || table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema IN ('public', 'drizzle') AND table_type = 'BASE TABLE' ORDER BY 1;" "SELECT 'END-OF-COUNTS';" >&"$snap_in"
: >"$dest/counts.txt"
while IFS= read -r -t 60 line <&"$snap_out"; do
  [ "$line" = "END-OF-COUNTS" ] && break
  printf '%s\n' "$line" >>"$dest/counts.txt"
done
printf '%s\n' "COMMIT;" "\\q" >&"$snap_in"
wait "$SNAP_PID" 2>/dev/null || true
[ -s "$dest/counts.txt" ] || { echo "no row counts were produced" >&2; exit 1; }

# The archive must be readable before we trust it.
pg_restore --list "$dest/db.dump" >/dev/null

if [ -d "$MEDIA_DIR" ]; then
  tar -C "$(dirname "$MEDIA_DIR")" -cf "$dest/media.tar" "$(basename "$MEDIA_DIR")"
  find "$MEDIA_DIR" -type f | wc -l | tr -d ' ' >"$dest/media-files.txt"
elif [ "${BACKUP_ALLOW_NO_MEDIA:-}" = "yes" ]; then
  echo "note: $MEDIA_DIR does not exist: backing up without media because BACKUP_ALLOW_NO_MEDIA=yes" >&2
  echo 0 >"$dest/media-files.txt"
else
  # A typo in this path would otherwise make every backup quietly lack the media.
  echo "the media directory $MEDIA_DIR does not exist: refusing to make a backup without it (set BACKUP_MEDIA_DIR, or BACKUP_ALLOW_NO_MEDIA=yes on a fresh install)" >&2
  exit 1
fi

if [ -n "$RECIPIENT" ]; then
  for file in db.dump media.tar; do
    [ -f "$dest/$file" ] || continue
    age --recipient "$RECIPIENT" --output "$dest/$file.age" "$dest/$file"
    rm -f -- "${dest:?}/${file:?}"
  done
fi

(cd "$dest" && sha256sum -- * | grep -v ' SHA256SUMS$' >SHA256SUMS)

if [ -n "$REMOTE" ]; then
  rclone copy "$dest" "$REMOTE/$stamp"
  echo "uploaded to $REMOTE/$stamp"
else
  echo "WARNING: NO OFF-SERVER COPY. This backup lives on the same server as the data: a lost or wiped server loses both." >&2
  echo "WARNING: set BACKUP_RCLONE_REMOTE (and BACKUP_AGE_RECIPIENT) so every backup is copied elsewhere." >&2
fi
if [ -z "$RECIPIENT" ]; then
  echo "WARNING: this backup is NOT encrypted (BACKUP_AGE_RECIPIENT is not set). It contains customer messages." >&2
fi

finished=yes

# Retention: keep the newest $KEEP COMPLETE backups here (a folder counts only if it has its checksum file). Only folders named like a backup
# are ever considered, so nothing else in $BACKUP_DIR can be removed.
if [ "$KEEP" -gt 0 ]; then
  kept=0
  while IFS= read -r folder; do
    [ -f "$folder/SHA256SUMS" ] || continue
    kept=$((kept + 1))
    if [ "$kept" -gt "$KEEP" ]; then
      rm -rf -- "${folder:?}"
      echo "removed old backup $folder"
    fi
  done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]{8}T[0-9]{6}Z' | sort -r)
fi

echo "done: $(du -sh "$dest" | cut -f1) in $dest ($(wc -l <"$dest/counts.txt" | tr -d ' ') tables, $(cat "$dest/media-files.txt") media files)"
