# Backups and restores

A backup you have never restored is a hope, not a backup. `scripts/backup.sh` makes one; `scripts/restore.sh` restores it **and proves the result**,
so the monthly rehearsal below takes a few minutes.

## What is in a backup, and what is not

| In the backup | Not in the backup (and why that is fine) |
|---|---|
| The whole database (`pg_dump`, custom format): contacts, messages, drafts, tasks, summaries, style guides, settings, audit log, sessions, the migration journal | **Your `.env`**: it holds secrets. Keep it in a password manager; restoring needs it |
| The media directory (voice notes, photos, documents) as one archive | **Redis**: queues and heartbeats are rebuilt. The sweeper re-queues any webhook event that was not processed, and the 5-minute safety scan re-creates missing draft, summary and send jobs from the database. Only the list of *failed* jobs (Settings -> Problems) is lost |
| Exact **row counts per table** at the instant of the dump, and SHA-256 checksums of every file | **Caddy's certificates**: re-issued automatically |

Customer messages are in the backup, so **encrypt it** (below). Without encryption the script still works but warns on every run, and it
refuses to upload an unencrypted backup anywhere.

## Set it up (once, on the server)

1. Install the tools on the host: `postgresql-client-16`, `age`, `rclone` (for the off-server copy).
2. **Make an encryption key pair, and keep the secret half OFF this server** (password manager, or printed and stored somewhere safe):
   ```bash
   age-keygen -o wab-backup.key        # prints "Public key: age1..."; wab-backup.key is the SECRET half
   ```
   The server only ever needs the public key (`age1...`). Anyone with the secret key can read every backup; without it, nobody can, including you.
3. Configure an **off-server destination** with `rclone config` (any S3-compatible bucket, Backblaze B2, a second server over SFTP, Google Drive...). A
   backup that lives only on the machine it protects does not survive losing that machine.
4. Create `/etc/wab-backup.env` (`chmod 600`):
   ```bash
   BACKUP_DATABASE_URL=postgres://wab_migrator:<WAB_MIGRATOR_PASSWORD>@127.0.0.1:5432/wab
   BACKUP_DIR=/srv/wab-backups
   BACKUP_MEDIA_DIR=/srv/wab/data/media
   BACKUP_KEEP=14                         # newest 14 complete backups are kept here
   BACKUP_AGE_RECIPIENT=age1...           # the PUBLIC key
   BACKUP_RCLONE_REMOTE=offsite:wab-backups
   ```
5. Run it once by hand: `/srv/wab/scripts/backup.sh /etc/wab-backup.env`. It prints where the backup went and any warning.
6. Schedule it (`crontab -e`), daily at a quiet hour:
   ```
   17 3 * * *  /srv/wab/scripts/backup.sh /etc/wab-backup.env >> /var/log/wab-backup.log 2>&1 && curl -fsS -m 10 https://<your uptime monitor>/<id> >/dev/null
   ```
   The `&&` pings an uptime/cron monitor **only when the backup succeeded**, so a silent failure becomes a missed ping. (Any monitor with a "expect a
   ping every day" mode works; the script itself cannot tell you it did not run.)
7. Retention in the **remote** location is not managed by the script: set a lifecycle rule there, or prune with `rclone delete --min-age 60d`.

What `backup.sh` guarantees: one consistent snapshot (the dump and the row counts describe the same instant even while messages arrive); the dump
is read back (`pg_restore --list`) before it is trusted; a backup that fails half-way is deleted rather than left looking like a backup;
a missing media directory is an error (a typo must not give you backups without photos); only complete backups count towards `BACKUP_KEEP`.

## Rehearse a restore (monthly, and after any change to this procedure)

Restore into a **scratch database**, never over the live one. In the compose stack:

```bash
cd /srv/wab
# 1. An empty scratch database owned by the migration role (run as the Postgres superuser inside the container):
docker compose -f docker-compose.prod.yml exec postgres psql -U postgres -c "CREATE DATABASE wab_drill OWNER wab_migrator"

# 2. Point the restore at it (chmod 600):
cat > /etc/wab-restore-drill.env <<'ENV'
RESTORE_DATABASE_URL=postgres://wab_migrator:<WAB_MIGRATOR_PASSWORD>@127.0.0.1:5432/wab_drill
RESTORE_MEDIA_DIR=/tmp/wab-drill-media
BACKUP_AGE_IDENTITY=/path/to/wab-backup.key     # the SECRET key; bring it for the drill, do not leave it on the server
ENV

# 3. Restore the newest backup (from BACKUP_DIR, or `rclone copy` one back from the off-server location to prove that path works too):
scripts/restore.sh /srv/wab-backups/<newest folder> /etc/wab-restore-drill.env
```

Success looks like:

```
RESTORE VERIFIED: 19 tables, 1352 rows all equal the backup; 2 media files.
```

That line is only printed when **every table's row count equals the count recorded at backup time** and the media file count matches. Anything
else prints `MISMATCH` with the difference and exits non-zero. Then drop the scratch database
(`... exec postgres psql -U postgres -c "DROP DATABASE wab_drill"`) and remove the scratch media directory and the secret key from the server.

`restore.sh` refuses (and changes nothing) when: the target database already contains tables, the media directory is not empty, a file does not
match its checksum, an encrypted backup has no key or the wrong one. It decrypts everything **before** it touches the target.

## Disaster: restoring onto a new server

1. Provision the server, install Docker, clone the repository, restore your `.env` from the password manager (same `BETTER_AUTH_SECRET`!).
2. Start **only** Postgres: `docker compose -f docker-compose.prod.yml up -d postgres`. Its first start creates the roles and an empty `wab` database.
3. Fetch the newest backup from the off-server location, then:
   ```bash
   mkdir -p data/media && sudo chown -R 10001:10001 data/media
   # /etc/wab-restore.env: RESTORE_DATABASE_URL=postgres://wab_migrator:...@127.0.0.1:5432/wab   RESTORE_MEDIA_DIR=/srv/wab/data/media   BACKUP_AGE_IDENTITY=...
   scripts/restore.sh <backup folder> /etc/wab-restore.env
   ```
4. Bring up everything: `docker compose -f docker-compose.prod.yml up -d --build`. The migration step has nothing to do for a current backup (and applies
   newer migrations if your code is newer than the backup).
5. Point DNS at the new server and wait for the certificate. Meta's webhook URL is unchanged if the domain is.
6. Messages that arrived **after** the last backup were retried by Meta for up to ~36 hours if they came while the server was down; anything older
   is only in WhatsApp itself (the history sync can re-send recent chats). Expect to look at **Problems** and **Needs attention** once.
7. If you lost `BETTER_AUTH_SECRET`, sign-ins and authenticator enrolment no longer verify: run `seed:owner --reset` to enrol a new authenticator.

## What was and was not tested

Tested in this repository (`test/integration/backup-restore.test.ts`, against real Postgres): backup then restore reproduces every row byte for
byte and every media file; grants (append-only audit log, no DDL for the runtime role) survive; a backup taken **while rows are being inserted**
restores exactly (and the same test fails if the shared snapshot is removed); every refusal listed above; encryption with a right, a wrong and a
missing key; retention; the loud warnings. **Not tested here**: a real `rclone` upload (a stand-in program was used to check the command line), and a restore
on a different machine or a different Postgres minor version. Your monthly rehearsal is what covers those.
