# WhatsApp Assistant

A single-owner assistant for one WhatsApp Business number. Customer messages arrive through the WhatsApp Cloud API webhook;
the system drafts replies in the owner's own writing style, keeps a rolling summary per conversation, tracks follow-ups the
owner owes, and shows everything on a real-time, mobile-first dashboard. Nothing is sent without the owner's explicit action,
with one opt-in exception: **autopilot**, which is off, cannot be switched on until it has proven itself on the owner's own replies, and even then
sends only simple, well-supported replies, after a countdown the owner can cancel.

> **Status: Phase 7 of 8 (autopilot, ships OFF).** On top of Phase 6 (analytics, hardening, production stack, proven backups): an **autopilot** that can send
> simple replies by itself, built so that it is unreachable until it has earned it. **Nothing is sent without your approval while autopilot is off, and it
> is off until its nine checks pass on your real data** (an evaluation of the drafts and 200 approved drafts with a low edit distance: see **Autopilot**
> below). What is and is not done is in [`docs/phase-reports/phase-7.md`](docs/phase-reports/phase-7.md); the checks only you can do (real chats, the
> real model, a real phone, a real server) are in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md); every place this build deliberately differs from the
> original spec is in [`DECISIONS.md`](DECISIONS.md).

## Privacy: who sees customer messages

**Customer messages are sent to Groq** (an external LLM provider) to draft replies, summarize conversations, extract your
style and transcribe voice notes. They also live in your Postgres database and (media) on your disk. Do not use this system
for conversations that must not leave your infrastructure. Logs never contain message bodies, tokens or full phone numbers. When autopilot schedules a
reply, the Telegram message you can cancel it from contains **the reply the assistant wrote** (never the customer's own words) and the customer's name or
handle: you cannot cancel what you cannot read. Every other Telegram message is ids and counts only.

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
sudo -u postgres psql -v ON_ERROR_STOP=1 -f scripts/db-init/01-roles.sql   # roles wab_migrator / wab_app + databases wab, wab_test, wab_restore_test
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
your Telegram chat. They are **notifications only** and never contain message text (the one exception is the autopilot's cancel-in-time message, below).

1. In Telegram, talk to **@BotFather**, send `/newbot`, and copy the bot token into `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot. Then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy the number
   at `"chat":{"id": ...}` into `TELEGRAM_CHAT_ID`. (Keep the token secret: anyone with it can post as the bot.)
3. `TELEGRAM_WEBHOOK_SECRET` is any long random string of letters, digits, `_` and `-` (for example `openssl rand -hex 32`); Telegram sends it back with
   every button tap so the app can tell a tap from anyone else's request. It is only needed for autopilot (see **Autopilot**).
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

## Summaries, tasks and follow-ups

- **After you reply** (from the dashboard or from your phone) the assistant reads what is new since its last summary and updates two things: a
  three-sentence **summary** of the conversation (shown above the thread) and your **tasks**: things a customer asked you to do, things you promised
  ("I'll call you tomorrow at 3"), and time-bound reminders. It does not create a task for something already done in the same messages, and it never
  invents a time: no time stated means no time set.
- **Tasks** lists them: late ones first and in red (with the lateness in words), then upcoming, then those with no time; Done and Cancelled below.
  Filter by kind and by when. Each task links to the message it came from. You can **add**, **edit**, **finish**, **cancel** and **reopen** them; times
  are your own clock (`OWNER_TIMEZONE`). A task the assistant noted wrongly is one click to cancel: nothing is sent to anyone because of a task.
- **Overdue tasks** raise one alert each (Telegram, if set up; and a badge on the Tasks tab). Move the time and it can alert again when late again.
- **Overview** shows drafts to approve, customers waiting, open and late tasks, your median first-reply time over 7 days, and **Needs attention**: failed
  or unconfirmed replies, overdue tasks, reply windows closing within two hours and drafts waiting more than 30 minutes.
- The summary and tasks cost one small model call per reply. **Turn AI off** in Settings and they stop too (they catch up on the next reply after you turn
  it back on).

## Analytics

**Analytics** (7, 30 or 90 days, in your time zone) answers one question first: *how close are the drafts to what you send?* The chart is the
**edit distance** between each draft and the reply you finally sent (0 = sent exactly as drafted, 1 = completely rewritten), as a median and a 75th
percentile per day, with the autopilot threshold drawn as a line: it is the number that decides whether autopilot may ever be switched on. Below it:
messages per day, your **median first-reply time** (from a customer's message to your next accepted reply; imports, reactions and failed sends do not
count), what happened to every draft (sent as written, edited, rejected, replaced, failed), tasks by kind, and model usage. Every chart has a
**Show the numbers** table. **Cost** appears only if you set `AI_PRICE_PER_MTOK_JSON` (your own prices per million tokens, copied from Groq's pricing
page): the app has no built-in prices, so without it you see tokens, never an invented cost.

## Autopilot

Autopilot is **off**, and the app will not let you turn it on until it has measured itself against *your* replies. What keeps it safe is the gate, the
rules and the checking model below. The countdown that lets you cancel is a second chance, not a guarantee: it only helps if you are looking at your
phone within the delay, so do not count on it for anything the rules should have caught.

**The gate.** Settings -> Autopilot shows nine checks with their numbers, live: the latest evaluation (`pnpm eval:drafts`) must be at most 30 days old,
use at least 50 of your replies, have been run with the prompt, model and style guide in use *now*, have a median edit distance at or below
`AUTOPILOT_MAX_EDIT_DISTANCE` (0.30) and **no invented facts**; and in the last 30 days you must have approved at least **200** drafts with a median at or
below the same threshold and a 75th percentile at or below 0.50. If a check fails later (the evaluation gets old, you change the model) autopilot stops
sending and every reply comes back to you.

**Per customer.** Even with the gate passing and the switch on, nothing happens until you switch a *conversation* to autopilot (the reply-mode panel at
the top of its page; for 24 hours, 7 or 30 days, or until you turn it off). Going back to approval is always one press.

**What it decides.** For a draft in a conversation on autopilot: the rules (the kind of reply is on your allowed list; no risk flag, missing fact or
`[[placeholder]]`; the 24-hour window has more than 10 minutes left; under your per-customer, per-day and in-a-row limits; not quiet hours; you have
written to this customer at least three times; it is not an answer to a voice note) and then a **separate checking model** that never sees the drafting
instructions and fails the reply for any unsupported fact, any promise, a reply that does not answer, or a risky tone. Any doubt, and any error in the
check itself, means *the reply comes to you*. A complaint, an angry customer or a request for a person is never answered automatically and takes the
conversation off autopilot.

**The countdown.** A reply that passes becomes "scheduled": you get a Telegram message with the reply and **Cancel** / **Send now** buttons (the same two
buttons are in Approvals, on the conversation and under Settings -> Autopilot, so a muted Telegram never leaves you without a way to stop it), and it is
sent after your delay (default 2 minutes). Just before it goes, the state-dependent rules are asked again; if anything changed it goes back to Approvals
with the reason. The first automatic reply in any 24 hours ends with your disclosure line (default "(sent by my assistant)"; it cannot be empty). If the
countdown is lost (Redis restarted), the reply is started once more after a minute and returned to you after a quarter of an hour: **nothing is ever sent
late on the autopilot's own initiative.**

**Afterwards.** Replies sent by autopilot are marked in the thread; **Mark bad** under one flags it and takes that customer off autopilot. A daily digest
(20:00 your time, only when autopilot did something or is on) lists what was sent, cancelled and handed to you, with the top reasons. Analytics has a card
for autopilot sent versus handed to you.

**Telegram buttons need a registered webhook.** After deploying (it must be reachable over https), run once:

```bash
pnpm telegram:webhook          # registers APP_URL/api/webhooks/telegram with TELEGRAM_WEBHOOK_SECRET
pnpm telegram:webhook --info   # what Telegram has now, and the last delivery error if there is one
```

Taps are accepted only with the secret header and only from your own chat (`TELEGRAM_CHAT_ID`). Without the webhook the buttons do nothing, but the
dashboard's Cancel / Send now still work.

## Settings

- **General**: the kill switches, the WhatsApp connection (when Meta last reached you, the backlog, history-import progress, recent alerts, the webhook
  URL and fields), the **background worker's status**, the token check, and Telegram alerts.
- **Business profile**: the only source of facts the assistant may state.
- **Autopilot**: the switch and the nine checks with their numbers, replies counting down (Cancel / Send now), conversations on autopilot, the rules
  (delay, limits, which kinds of message, the disclosure line) and the replies you marked bad.
- **Problems**: messages that failed or could not be confirmed, and **failed background jobs** (a draft, a summary, a download, an incoming event that the
  worker gave up on, kept 30 days). **Retry** runs a job again where that is safe; for a send that may already have reached a customer it is disabled and
  says why (check your phone from the conversation instead). **Dismiss** only clears the record.
- **Audit log**: every change made through the dashboard (who, what, which record, when), newest first, filterable. It holds ids and kinds, never what a
  message said, and the database does not allow editing or deleting it.

## Production

`docker-compose.prod.yml` runs Caddy (automatic HTTPS), the web app, the worker, Postgres 16 and Redis 7 on one server, with a one-shot migration step.
Start with **[docs/operations/production.md](docs/operations/production.md)** (deploy, update, health checks, hardening, a first-deploy checklist).

The app sends a strict **Content-Security-Policy** (scripts run only with a per-request nonce), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`,
`X-Content-Type-Options: nosniff` and, when `APP_URL` is https, HSTS. Health: `GET /api/health` (database + Redis) and `GET /api/health/worker` (200, or 503
once the worker's heartbeat is older than 45 seconds): point an uptime monitor at both.

## Backups

`scripts/backup.sh` writes a consistent snapshot of the database and the media directory, optionally encrypted (`age`) and copied off the server
(`rclone`); `scripts/restore.sh` restores it into an empty database and **proves** it by comparing every table's row count with the backup. A backup you
have never restored is a hope: rehearse monthly. Everything, including the monthly drill and what to do after losing the server, is in
**[docs/operations/backup-restore.md](docs/operations/backup-restore.md)**.

## Troubleshooting

| Symptom | Likely cause and what to do |
|---|---|
| Meta cannot verify the callback URL | The verify token in Meta's console differs from `WEBHOOK_VERIFY_TOKEN`, or the URL is not the public https address ending `/api/webhooks/whatsapp`. Open it in a browser: a `403` means the app is reachable and the token is wrong |
| Messages do not appear | Settings -> General says when Meta last reached you. Never: the callback URL or the subscribed fields (list under Settings) are wrong. Recently but nothing shows: is the **worker** running (General -> Background worker)? |
| "Background worker: Not running" | `docker compose -f docker-compose.prod.yml logs worker` (or your `pnpm worker` terminal). Usually Redis unreachable or an invalid environment variable: the log names it |
| A reply says "Not confirmed" | A timeout, or the worker stopped mid-send. Check your phone, then press **It arrived** or **It did not arrive: send again**. The system never resends by itself |
| No drafts appear | Settings -> General: is **AI** paused? Settings -> Problems: a failed draft job names the reason (a wrong or exhausted Groq key, a model Groq has retired: check `LLM_MODEL_*`) |
| "Too many attempts" at login | Five wrong tries per address per 15 minutes: wait 15 minutes. Behind a proxy that does not overwrite `X-Forwarded-For`, everyone shares one address: see the production doc |
| Lost your authenticator | On the server: `pnpm seed:owner --reset` (in Docker: `... run --rm web node_modules/.bin/tsx --conditions=react-server scripts/seed-owner.ts --reset`) |
| A blank page or broken buttons, and the browser console mentions "Content Security Policy" | A script or style was blocked: report the exact message (the policy is meant to have zero violations) |
| The disk is filling | `data/media` and `backups/` grow; Postgres stops when the disk is full. Delete old local backups (`BACKUP_KEEP`) and check `df -h` |

## Testing against the real model

`pnpm test:ai` asks the real draft model a handful of adversarial and fact-checking questions (an injection, a request for its instructions, "are you a
bot?", a price it was not given) and the real analysis model a few note-taking ones ("call me tomorrow at 3pm" must become 15:00 tomorrow in your
zone) and the autopilot's **checking model** a few review ones (an invented stock level, a wrong price, a promise, a defensive tone, a reply that dodges the
question, an instruction hidden in the reply or in the customer's message: every one must be failed), three times each, and prints how many times each rule
held. It needs `GROQ_API_KEY`, `LLM_MODEL_DRAFT`, `LLM_MODEL_ANALYSIS` and `LLM_MODEL_VERIFY` (in the environment or in `.env`), costs a few cents, sends invented text only, and is never run by CI. A pass at 3/3 and a pass at 2/3 are different news:
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
| `pnpm telegram:webhook` | Register the Telegram webhook for the autopilot buttons (`--info` to inspect, `--delete` to remove) |
| `pnpm seed:owner` | Create the owner and enroll TOTP (`--help`; `--reset` after losing your authenticator) |
| `scripts/backup.sh [config]` | Back up the database and media (snapshot, optional `age` encryption and `rclone` upload). See `docs/operations/backup-restore.md` |
| `scripts/restore.sh <folder> [config]` | Restore a backup into an EMPTY database and verify it row by row |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit` / ESLint |
| `pnpm test` | Unit tests (no services needed) |
| `pnpm test:integration` | Integration tests against real Postgres + Redis (database must end in `_test`, Redis db 15) |
| `pnpm test:ai` | Opt-in: behaviour of the REAL draft, analysis and checking models (needs `GROQ_API_KEY`, `LLM_MODEL_DRAFT`, `LLM_MODEL_ANALYSIS`, `LLM_MODEL_VERIFY`; a few cents) |

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
| 5 | Summaries, tasks, follow-ups | done (real-model checks: `docs/ACCEPTANCE.md`) |
| 6 | Analytics, hardening, production deploy, backups | done (a real deploy and a real restore drill: `docs/ACCEPTANCE.md`) |
| 7 | Autopilot (gated by measured quality; ships off) | done (a real model, a real Telegram and a real phone: `docs/ACCEPTANCE.md`) |
