# WhatsApp Assistant

A single-owner assistant for one WhatsApp Business number. Customer messages arrive through the WhatsApp Cloud API webhook;
the system drafts replies in the owner's own writing style, keeps a rolling summary per conversation, tracks follow-ups the
owner owes, and shows everything on a real-time, mobile-first dashboard. Nothing is sent without the owner's explicit action
(autopilot is a later, opt-in, gated phase).

> **Status: Phase 0 of 8.** The foundation is in place: schema, auth with mandatory TOTP, the dashboard shell, the worker
> runtime, and the pure state machines. Ingesting real WhatsApp messages starts in Phase 1. See
> [`docs/phase-reports/phase-0.md`](docs/phase-reports/phase-0.md) for what is and is not done, and
> [`DECISIONS.md`](DECISIONS.md) for every place this build deliberately differs from the original spec.

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
Until you have a Meta app, Groq key and Telegram bot, any non-empty placeholder in `.env` is enough for Phase 0.

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
| 1 | WhatsApp webhook ingest (incl. Coexistence echoes/history), media, live read-only dashboard | next |
| 2 | Manual send path, templates, kill switches, Telegram notifications | |
| 3 | Chat import, style extraction, few-shot retrieval, evaluation harness | |
| 4 | Drafting + `/approvals` | |
| 5 | Summaries, tasks, follow-ups | |
| 6 | Analytics, hardening, production deploy, backups | |
| 7 | Autopilot (gated by measured quality) | |

Not yet documented here (written in the phase that needs it): Meta app / System User token / webhook registration,
Telegram bot setup, production deployment, backup and restore.
