# WhatsApp Assistant

A single-owner assistant for one WhatsApp Business number. Customer messages arrive through the WhatsApp Cloud API webhook;
the system drafts replies in the owner's own writing style, keeps a rolling summary per conversation, tracks follow-ups the
owner owes, and shows everything on a real-time, mobile-first dashboard. Nothing is sent without the owner's explicit action
(autopilot is a later, opt-in, gated phase).

> **Status: Phase 4 of 8 (drafting and approvals).** On top of Phase 3 (import, style, evaluation): when a customer writes, the system now **drafts a
> reply in your style** and shows it on **Approvals** for you to approve, edit, reject or regenerate. **Nothing is ever sent without your explicit
> approval**, and a draft with a `[[placeholder]]` (a fact it did not have) cannot be sent until you fill it in. Summaries and tasks are Phase 5, the
> optional autopilot Phase 7. What is and is not done is in [`docs/phase-reports/phase-4.md`](docs/phase-reports/phase-4.md); the checks only you can do
> (real chats, the real model, a real phone) are in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md); every place this build deliberately differs from the
> original spec is in [`DECISIONS.md`](DECISIONS.md).

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

## Teaching it your style

1. **Export your chats** from the WhatsApp app: open a customer chat -> menu -> *More* -> *Export chat* -> *Without media*. You get a `.txt` per
   customer. Put them in a folder.
2. **Import them**: `pnpm import:chats ./my-exports --me "Your Name"` where the name is exactly how you appear in the export (leave `--me` out and
   it asks). Add `--dry-run` first to see what it would do. It is safe to run again: nothing is imported twice, and messages WhatsApp already
   delivered to the dashboard are not duplicated. Group chats are refused. If a file's dates cannot tell day/month from month/day it says so;
   `--date-order dmy|mdy` fixes it. Imported chats appear under **Resolved**.
3. **Write your business profile** in **Settings -> Business profile**: prices, stock rules, delivery, hours, policies. It is the **only**
   source of facts the assistant may state: anything not there becomes a `[[placeholder]]` you must fill in before a draft can be sent.
4. **Extract a style guide** on **Style** (needs at least 30 of your own messages). Read it; compare it with the active one; **Activate** it.
   Until one is active, drafts are plain and short.
5. **Measure**: `pnpm eval:drafts` holds out your 50 most recent real replies, drafts each with the current prompt, model and style guide,
   and writes `eval/results/<time>.md`. Run it before and after any change to the prompt, the model or the style guide: a change ships only
   if the median edit distance did not get worse and no new invented facts appeared. The report contains real messages: keep it local.

## Approving drafts

When a customer writes, a draft appears under **Approvals** a few seconds after they stop typing (`DRAFT_DEBOUNCE_SECONDS`, 25 by default; a burst of
messages is one draft). If Telegram is set up you get one "draft ready" ping with a link (never the customer's name or words), at most one per
conversation per 10 minutes, a digest when more than 5 are waiting, silent during quiet hours.

- **Approve and send** sends the draft exactly as written. Edit the text first and the button becomes **Send edited reply**; your edit is remembered
  as an edit (the dashboard shows how often you change each kind of draft, so you can judge how far to trust it). **Reject** drops it (the customer is
  still waiting; **Draft a reply** on the conversation asks for a new one). **Regenerate** throws it away and writes a fresh one.
- **Yellow badges are warnings, not blocks**: a complaint, an angry customer, money or a promise, a message that tries to give the assistant
  instructions ("ignore previous instructions...": flagged by the model AND by a pattern check of our own), a voice note it could not read, a customer
  asking whether they are talking to a bot (the draft never denies it). **A `[[placeholder]]` is a block**: it is a fact the assistant did not have;
  click the chip, type the real answer, then send.
- **Stale draft**: if the customer wrote again after a draft was made, the draft is replaced automatically; in the rare case one slips through, the
  card says so and offers **Send anyway** instead of Approve.
- **Keyboard**: `a` approve, `e` edit, `r` reject, `g` regenerate, `j`/`k` next/previous. Ignored while you type; Esc leaves the box.
- **If drafting fails** (the model is down, the key is wrong) the card says so and offers **Try again**; replying by hand always works, and a failed
  draft raises an alert. Turn **AI** off in Settings to stop drafting without stopping anything else.

## Testing against the real model

`pnpm test:ai` asks the real draft model a handful of adversarial and fact-checking questions (an injection, a request for its instructions, "are you a
bot?", a price it was not given) three times each and prints how many times each rule held. It needs `GROQ_API_KEY` and `LLM_MODEL_DRAFT` (in the
environment or in `.env`), costs a few cents, sends invented text only, and is never run by CI. A pass at 3/3 and a pass at 2/3 are different news:
read the numbers. It uses the throwaway `_test` database.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js web app (dev / production build / serve) |
| `pnpm dev:worker` / `pnpm worker` | BullMQ workers and schedulers (`tsx --conditions=react-server`) |
| `pnpm db:generate` | Generate a SQL migration from `src/lib/db/schema.ts` (`--custom` for hand-written SQL) |
| `pnpm db:migrate` | Apply migrations with `DATABASE_MIGRATION_URL`. **Never runs during `next build`.** |
| `pnpm import:chats <path>` | Import WhatsApp chat exports (`--me`, `--dry-run`, `--contact`, `--date-order`) |
| `pnpm eval:drafts` | Measure draft quality against your most recent real replies (needs `GROQ_API_KEY`) |
| `pnpm seed:owner` | Create the owner and enroll TOTP (`--help`; `--reset` after losing your authenticator) |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit` / ESLint |
| `pnpm test` | Unit tests (no services needed) |
| `pnpm test:integration` | Integration tests against real Postgres + Redis (database must end in `_test`, Redis db 15) |
| `pnpm test:ai` | Opt-in: behaviour of the REAL draft model (needs `GROQ_API_KEY`, `LLM_MODEL_DRAFT`; a few cents) |

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
| 3 | Chat import, style extraction, few-shot retrieval, evaluation harness | done (real-model checks: `docs/ACCEPTANCE.md`) |
| 4 | Drafting + `/approvals` | done (real-model and real-phone checks: `docs/ACCEPTANCE.md`) |
| 5 | Summaries, tasks, follow-ups | |
| 6 | Analytics, hardening, production deploy, backups | |
| 7 | Autopilot (gated by measured quality) | |

Not yet documented here (written in the phase that needs it): production deployment, backup and restore.
