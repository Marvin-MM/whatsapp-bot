# Running it in production

One server, one instance of each process. The stack in `docker-compose.prod.yml`:

| Service | What it is | Reachable from |
|---|---|---|
| `caddy` | Automatic HTTPS (Let's Encrypt), forwards to `web`, **overwrites** `X-Forwarded-For` | the internet (ports 80, 443) |
| `web` | `next start`: dashboard, webhook, SSE, media | `caddy` only |
| `worker` | every queue and scheduler (sending, drafting, alerts, sweeper) | nothing (it only makes outbound calls) |
| `migrate` | one-shot: applies migrations as the owning database role, then exits; `web` and `worker` wait for it | n/a |
| `postgres` | Postgres 16, data in the `pgdata` volume | `web`/`worker`/`migrate`, and **127.0.0.1 only** on the host (for backups) |
| `redis` | Redis 7, password, `noeviction`, append-only | `web`/`worker` |

Nothing here has been run on a real server by the person who wrote it: the files are validated (`docker compose config`, the env schema
against the rendered environment, static tests, and the backup/restore scripts against real Postgres), but **the first deploy is the first
real run**. Follow the checklist at the end and read the logs.

## What you need

- A Linux server (2 GB RAM is plenty for one number and under 500 messages a day) with **Docker** and the **compose plugin**.
- A **domain name** whose A/AAAA record points at the server, and ports **80 and 443** open to the internet (80 is needed for the certificate).
- On the host, for backups: `postgresql-client-16` (`pg_dump`, `pg_restore`, `psql`), and recommended `age` and `rclone`.
- The accounts from the README: Meta app + System User token, Groq key, Telegram bot.

## First deploy

```bash
git clone <your repository> /srv/wab && cd /srv/wab
cp .env.example .env
```

Edit `.env`. Everything in the README applies, with these differences:

```bash
APP_URL=https://assistant.example.com          # your real address, https
BETTER_AUTH_URL=https://assistant.example.com  # the same
# Used only by docker-compose.prod.yml. Generate each with: openssl rand -hex 24   (hex: they are placed inside connection URLs)
APP_DOMAIN=assistant.example.com               # no https://
POSTGRES_PASSWORD=...                          # Postgres superuser: used once, by the image, on first start
WAB_MIGRATOR_PASSWORD=...                      # the role that owns the schema; only the migrate step and backups use it
WAB_APP_PASSWORD=...                           # the runtime role (DML only, append-only audit log)
REDIS_PASSWORD=...
```

Leave the `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `REDIS_URL` and `MEDIA_STORAGE_DIR` lines from the example as they are: the compose file ignores
them and builds its own from the passwords above. **Containers receive only the variables the compose file lists** (no `env_file`), so the
migrator password never reaches `web` or `worker`.

```bash
mkdir -p data/media && sudo chown -R 10001:10001 data/media       # the app runs as uid 10001 and writes media here
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps                       # postgres, redis, web healthy; migrate "exited (0)"
docker compose -f docker-compose.prod.yml logs -f migrate web worker
```

The first start of an empty Postgres volume creates the two roles and the `wab` database (`scripts/db-init-prod/01-roles.sh`). That script runs
**once**: changing a password in `.env` later does not change the database role, so rotate a password with `ALTER ROLE ... PASSWORD` in `psql` and
then in `.env`.

Create the owner (interactive: password, then scan the QR/secret into your authenticator app):

```bash
docker compose -f docker-compose.prod.yml run --rm web node_modules/.bin/tsx --conditions=react-server scripts/seed-owner.ts
```

Then open `https://<your domain>/login`.

Register the webhook with Meta (README, "Connecting WhatsApp"): callback URL `https://<your domain>/api/webhooks/whatsapp`, your
`WEBHOOK_VERIFY_TOKEN`, and the fields `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`, `user_id_update`, `account_update`.
**Settings -> General** shows the same list and when Meta last reached you.

### Set up backups before you have data worth losing

Do this now, not later: [backup-restore.md](backup-restore.md).

## Updating

```bash
cd /srv/wab && git pull
docker compose -f docker-compose.prod.yml up -d --build
```

`migrate` runs first and `web`/`worker` start only if it succeeded; a failed migration leaves the old containers running. Take a backup before
an update that includes a migration. **Migrations only go forward.** To go back to an older version you restore the backup taken before the update
(see backup-restore.md); do not edit the database by hand.

## Knowing it is healthy

| Check | How |
|---|---|
| Web + database + Redis | `GET https://<domain>/api/health` -> `{"ok":true,"db":true,"redis":true}` |
| The worker is alive | `GET https://<domain>/api/health/worker` -> 200 `{"ok":true,"ageSeconds":n}`; **503 once the worker's heartbeat is older than 45 s** (it beats every 15 s) |
| From the dashboard | **Settings -> General -> Background worker**, "Messages that need attention" and "Failed background jobs" under **Settings -> Problems** |
| Containers | `docker compose -f docker-compose.prod.yml ps`. Note: Docker marks a container unhealthy but does **not** restart it for that |

Point an external uptime monitor (any service that polls a URL) at `/api/health/worker` and `/api/health`: they are the two that tell you the
system has stopped doing its job. Telegram alerts cover the cases the system can see itself (a message that may not have been sent, a rejected
token, a stuck event); they cannot tell you that the whole server is down.

Logs are JSON (pino) on stdout: `docker compose -f docker-compose.prod.yml logs --since 1h web worker`. They never contain message bodies, tokens or
full phone numbers.

## Hardening you can add

- **Keep the dashboard private, leave the webhook public.** Meta must reach `/api/webhooks/whatsapp`; the dashboard does not need the whole
  internet. In `deploy/Caddyfile` you can answer everything except the webhook only to your own addresses (Caddy's `remote_ip` matcher with a
  `respond 403` for the rest). Do this only if your address is stable; the login (password + authenticator code, 5 attempts per 15 minutes per
  address) is already the real protection.
- **Putting Cloudflare (or another proxy) in front of Caddy** changes who the client address is. Caddy must then be told which proxies to trust
  (`trusted_proxies` in its global options); otherwise every visitor looks like Cloudflare and the login rate limit becomes one shared bucket.
- **Firewall** to 22, 80 and 443 only. Postgres is bound to the loopback interface and Redis has no published port.

## Things to know

- **Customer messages go to Groq** (see the README privacy section). They live in Postgres and (media) in `data/media`; both are in the backup.
- **Disk.** `data/media` grows with customer photos and voice notes; the Postgres volume with messages; `backups/` with every backup you keep.
  `df -h` now and then; a full disk stops Postgres.
- **One instance of each.** Do not scale `web` or `worker` beyond one container: the send path, the sweeper and the schedulers assume it.
- **Time.** All times shown and used for quiet hours, "tomorrow 3pm" and the daily digest come from `OWNER_TIMEZONE`, not the server's clock zone.

## First-deploy checklist (what this repository could not check for you)

- [ ] `docker compose -f docker-compose.prod.yml up -d --build` finishes; `migrate` exits 0; `web` becomes healthy.
- [ ] `https://<domain>/api/health` and `/api/health/worker` answer 200 over a valid certificate.
- [ ] You can sign in, and **Settings -> General** says the worker is running.
- [ ] Meta's webhook verification succeeds (the callback URL turns green) and a message from another phone appears in **Chats** within seconds.
- [ ] A browser's developer console on every page shows **no Content-Security-Policy violation** (the policy is strict: scripts only with a per-request nonce).
- [ ] Login rate limiting counts **your** address: five wrong passwords from one address are refused, and another address is not affected (this proves Caddy's `X-Forwarded-For` handling).
- [ ] A backup runs, a copy reaches the off-server destination, and **you restored it once into a scratch database** (backup-restore.md).
- [ ] Reboot the server: everything comes back by itself (`restart: unless-stopped`).
