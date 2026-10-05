# WhatsApp Assistant

A single-owner assistant for one WhatsApp Business number. Customer messages arrive through the WhatsApp Cloud API webhook;
the system drafts replies in the owner's own writing style, keeps a rolling summary per conversation, tracks follow-ups the
owner owes, and shows everything on a real-time, mobile-first dashboard. Nothing is sent without the owner's explicit action
(autopilot is a later, opt-in, gated phase).

> **Status: Phase 2 of 8 (manual sending).** Everything from Phase 1 (ingest, media, live dashboard), plus: you can **reply from
> the dashboard** (typed replies and approved templates), the send path is crash-safe (a message is never sent twice, and one
> whose delivery we cannot confirm is handed to you, never guessed at), the 24-hour window is enforced and counted down live,
> the **kill switches** work from Settings, and alerts reach you on **Telegram**. There is **no AI drafting yet** (Phase 3-4).
> What is and is not done is in [`docs/phase-reports/phase-2.md`](docs/phase-reports/phase-2.md); the checks only you can do
> (real Meta, real Telegram) are in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md); every place this build deliberately differs from
> the original spec is in [`DECISIONS.md`](DECISIONS.md).

## Privacy: who sees customer messages

**Customer messages are sent to Groq** (an external LLM provider) to draft replies, summarize conversations, extract your
style and transcribe voice notes. They also live in your Postgres database and (media) on your disk. Do not use this system
for conversations that must not leave your infrastructure. Logs never contain message bodies, tokens or full phone numbers.

## Requirements

- Node.js 24 LTS (`.nvmrc`; 22.12+ also works) and pnpm 10 (`corepack enable`)
- Docker (for local Postgres 16 + Redis), or native Postgres 16 and Redis 7 (see below)

## Quick start (local development)

```bash
cp .env.example .env            # then fill in the blanks; see comments inside
docker compose up -d            # Postgres 16 + Redis (data services only)
pnpm install
pnpm db:migrate                 # applies drizzle/ as the migration role
pnpm seed:owner                 # creates the owner, enrolls an authenticator (TOTP), seeds settings
pnpm dev                        # web on http://localhost:3000
pnpm dev:worker                 # in a second terminal: queue workers + schedulers
```

Sign in at <http://localhost:3000/login> with `OWNER_EMAIL`, the password you chose, and a code from your authenticator app.
Until you have a Meta app, Groq key and Telegram bot, any non-empty placeholder in `.env` is enough to run the dashboard; real
values are needed to receive WhatsApp messages (next section).

Generate secrets with `openssl rand -base64 32`. List current Groq production models (and pick `LLM_MODEL_*`) with:

```bash
curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
```

### Without Docker (native Postgres and Redis)

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 -f scripts/db-init/01-roles.sql   # roles wab_migrator / wab_app + databases wab, wab_test
redis-server --maxmemory-policy noeviction --daemonize yes                  # BullMQ requires noeviction
```

The default URLs in `.env.example` then work unchanged.

## Connecting WhatsApp

Meta's console changes often: follow Meta's own current documentation for the exact clicks; this is what the app needs from it.

1. **A Meta app with the WhatsApp product** and a WhatsApp Business Account, with your number connected through **Coexistence**
   (the number stays usable in the WhatsApp Business app on your phone). Note the **phone number id** and the **WABA id**
   (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`).
2. **A System User access token** (Business Settings -> System users) with `whatsapp_business_messaging` and
   `whatsapp_business_management`; assign it the WhatsApp account. This is `WHATSAPP_ACCESS_TOKEN`. Use a System User, not a
   temporary token: the temporary one expires in hours and media downloads would start failing.
3. **The app secret** (`META_APP_SECRET`: every webhook is verified with it) and a **verify token** you invent
   (`WEBHOOK_VERIFY_TOKEN`: any long random string).
4. **A public HTTPS URL for the webhook only.** For local development a tunnel is enough:
   `cloudflared tunnel --url http://localhost:3000` prints an `https://....trycloudflare.com` address. The dashboard itself
   stays on `localhost`.
5. In the app's WhatsApp -> Configuration, set the **callback URL** to `https://<your-host>/api/webhooks/whatsapp` and the
   **verify token** from step 3, then **subscribe to these fields**: `messages`, `smb_message_echoes`, `history`,
   `smb_app_state_sync`, `user_id_update`, `account_update`. (Settings shows the exact URL and this list.)
6. Open **Settings -> WhatsApp connection**: it shows when Meta last reached you, the backlog, the history-import progress and
   recent alerts. Send yourself a message from another phone and watch it appear in **Chats** within a few seconds.

Things worth knowing:

- **Voice notes.** They are transcribed with Whisper, which has **no Luganda**. A transcript is trusted only when it is plausible
  English; anything else is shown as "automatic transcript unreliable, please listen" and its text is discarded, never shown to
  an AI model. English transcripts are always labelled "auto-transcribed". Set `TRANSCRIBE_AUDIO=false` to turn this off.
- **Media** is stored under `MEDIA_STORAGE_DIR` (default `./data/media`) and served only to the signed-in owner. Include it in
  backups, and do not place symlinks or other people's files in it. Meta keeps media for about 30 days and download links for
  minutes, so the worker must be running.
- **Meta's payload shapes** were reconstructed from SDK type definitions and open-source fixtures because Meta's own pages were
  unreachable while this was built (see D-031). If you can, paste 5-6 real payloads from Meta's webhook test tool (a text,
  a voice note, a status, a phone-app reply, a history chunk) into `test/fixtures/webhooks/real/` (see the README there) and run
  `pnpm test`: they become contract tests.
- **Webhook failures are repaired automatically.** Anything Meta sends is stored before it is acknowledged; a sweeper
  re-queues anything the worker did not finish, and Meta itself retries for about 36 hours if the app is down.

## Telegram alerts

Alerts (a message that may not have been sent, a reply window about to close, a rejected WhatsApp token, a stuck event) can be sent to
your Telegram chat. They are **notifications only** and never contain message text.

1. In Telegram, talk to **@BotFather**, send `/newbot`, and copy the bot token into `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot. Then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy the number
   at `"chat":{"id": ...}` into `TELEGRAM_CHAT_ID`. (Keep the token secret: anyone with it can post as the bot.)
3. `TELEGRAM_WEBHOOK_SECRET` is any long random string; it is used from the autopilot phase on, when the bot can also receive taps.
4. Restart the worker, open **Settings -> Telegram alerts** and press **Send a test message**. Set your quiet hours there: during
   them only critical alerts are sent (everything still appears in the dashboard).

## Sending

- Type a reply in the box under a conversation (Ctrl/Cmd + Enter sends). It is refused with a reason if sending is paused, the text
  is empty or too long, or still contains a `[[placeholder]]`.
- **The 24-hour window.** WhatsApp lets you send a normal message only within 24 hours of the customer's last message. The badge
  counts down live; after that the box is replaced by the **template picker**: approved templates are loaded from your WhatsApp
  Business Account (create and approve them in WhatsApp Manager; templates with image headers or button links that need values are
  listed as "not available from here").
- **A message we could not confirm** (a timeout, a worker that stopped mid-send) is marked "Not confirmed". Check your phone, then
  press **It arrived** or **It did not arrive: send again**. The system never resends by itself: the Cloud API has no way to ask
  "did you get this?", so a guess would be a duplicate message to a customer.
- **Kill switches** (Settings): pause sending (takes effect on the very next message, even ones already waiting), pause AI. Autopilot
  cannot be enabled yet.
- **Worker required.** Sending, retries and the safety-net scans (`alerts-scan` every 5 min, token check daily, 30-day payload purge)
  all run in the worker. Settings -> "Messages that need attention" lists anything that failed, was not confirmed or is still queued.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js web app (dev / production build / serve) |
| `pnpm dev:worker` / `pnpm worker` | BullMQ workers and schedulers (`tsx --conditions=react-server`) |
| `pnpm db:generate` | Generate a SQL migration from `src/lib/db/schema.ts` (`--custom` for hand-written SQL) |
| `pnpm db:migrate` | Apply migrations with `DATABASE_MIGRATION_URL`. **Never runs during `next build`.** |
| `pnpm seed:owner` | Create the owner and enroll TOTP (`--help`; `--reset` after losing your authenticator) |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit` / ESLint |
| `pnpm test` | Unit tests (no services needed) |
| `pnpm test:integration` | Integration tests against real Postgres + Redis (database must end in `_test`, Redis db 15) |

## How it fits together

- **web** (`next start`): dashboard, webhooks, SSE, media, server actions. **worker** (`pnpm worker`): every queue and scheduler.
  One instance of each. Postgres is the source of truth; Redis carries BullMQ jobs and realtime pub/sub.
- **Database roles.** The app connects as `wab_app` (DML only, and *append-only* on `audit_log`); only `pnpm db:migrate` uses
  the owning `wab_migrator` role. The `wab_*_dev` passwords in `scripts/db-init/01-roles.sql` are for local development only:
  in production create the roles with strong passwords.
- **Auth.** Better Auth with email + password and TOTP. Public sign-up is disabled; the only account is `OWNER_EMAIL`, and a
  session without enrolled TOTP is never accepted. Every page, server action and route handler checks the session itself;
  `proxy.ts` only redirects.
- **Behind a reverse proxy.** Login rate limiting (5 attempts / 15 min / IP) trusts `X-Forwarded-For`. Run behind a proxy that
  *overwrites* it (Caddy, nginx, Cloudflare Tunnel), otherwise the limit can be bypassed by spoofing the header.

## Roadmap

| Phase | Delivers | Status |
|---|---|---|
| 0 | Scaffold, schema, auth + TOTP, shell, worker runtime, state machines | done |
| 1 | WhatsApp webhook ingest (incl. Coexistence echoes/history), media, live read-only dashboard | done (real-Meta checks: `docs/ACCEPTANCE.md`) |
| 2 | Manual send path, templates, kill switches, Telegram notifications | done (real-Meta checks: `docs/ACCEPTANCE.md`) |
| 3 | Chat import, style extraction, few-shot retrieval, evaluation harness | |
| 4 | Drafting + `/approvals` | |
| 5 | Summaries, tasks, follow-ups | |
| 6 | Analytics, hardening, production deploy, backups | |
| 7 | Autopilot (gated by measured quality) | |

Not yet documented here (written in the phase that needs it): production deployment, backup and restore.
