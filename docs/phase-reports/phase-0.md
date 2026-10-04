# Phase 0 report: scaffold and foundations

Branch `claude/whatsapp-reply-assistant-bb49ug` · 2026-10-04 · stopping here until you give the go-ahead for Phase 1.

## Verdict

**Phase 0 is done, with two things I could not verify from the build sandbox (Docker, and anything needing Meta/Groq/Telegram).**
Everything else was verified on a **fresh clone** of the committed code against a brand-new database: `pnpm install --frozen-lockfile`,
`db:migrate`, `seed:owner`, typecheck, lint, **270 unit + 70 integration tests**, `next build` with an *empty* environment (0 warnings),
`next start`, HTTP smoke checks, and a Chromium run through the real login form.

## Acceptance (spec 13, Phase 0)

| Criterion | Result | How verified |
|---|---|---|
| `docker compose up -d` | **Not run: no Docker daemon in the sandbox.** Compose file validates client-side. | You run it (below). Native Postgres 16.14 + Redis 7.0.15 stood in for the tests. |
| `pnpm db:migrate` | pass | fresh DB, 3 migrations |
| `pnpm typecheck` / `pnpm lint` | pass | `tsc --noEmit` strict + `noUncheckedIndexedAccess`; ESLint 9, 0 warnings |
| `pnpm test` | pass, 270 tests | 15 files |
| `pnpm test:integration` | pass, 70 tests | 6 files, real Postgres + Redis |
| Missing env var exits naming it | pass (web **and** worker) | `unset META_APP_SECRET` -> exit 1, stderr `META_APP_SECRET`; also unit-tested for all 22 required vars |
| `/` unauthenticated -> `/login` | pass | built server: `307 Location: /login`; `/approvals` keeps `?next=%2Fapprovals` |
| Login needs password **and** TOTP | pass | Chromium drove the real form: wrong password, wrong code, right code, redirect, reload, sign-out |
| Server action without a session is rejected | pass | integration test on the real `setKillSwitch`; no row, no audit entry |
| State-machine transitions | pass | every (status x event) pair against an allowed set written from the spec; exhaustive 4-webhook orderings |

## What was built

- **Schema**: all 12 spec tables + 6 Better Auth tables, 3 migrations (`0000_init`, `0001_grants` hand-written, `0002_auth`). Partial indexes, generated `tsvector`, singleton `settings`, one-active-style-guide enforced by a partial unique index.
- **Least privilege**: app role `wab_app` cannot UPDATE/DELETE/TRUNCATE `audit_log` or run any DDL; later migrations auto-grant it DML. Tested.
- **Auth**: Better Auth, sign-up disabled, TOTP *enforced* by the guard (the library only makes it opt-in), login limited to 5/15 min/IP in Postgres, `seed:owner` with hidden password entry and authenticator confirmation, `--reset` for a lost phone.
- **Actions**: `ownerAction` = authenticate -> Zod -> handler + audit in one transaction; first real action `setKillSwitch`.
- **Worker runtime**: queue catalog from spec 5.3, fail-fast producer vs worker connections, heartbeat, graceful SIGTERM (exit 0), scheduler registry.
- **Realtime**: Zod-strict event union (no message bodies can ride SSE) + publisher.
- **State machines**: drafts and outbound messages, pure.
- **Dashboard shell**: sidebar on desktop, bottom tab bar + "More" on phones, kill-switch badges and alert counter in one header row at 390px, light/dark, skeleton + inline error states, an empty state per page, `/api/health`.
- **Docs**: `CLAUDE.md` (86 lines), `DECISIONS.md` (29 entries), README, `.env.example` (drift-tested), Dockerfile, compose.

## Findings that changed the plan (all logged in DECISIONS.md)

1. **The spec's job ids are unbuildable.** BullMQ 6 rejects `:` in custom job ids; every spec key (`msg:{wamid}`, `send:{id}`...) contains one. Fixed with `toJobId`.
2. **`Queue.add` never fails fast.** Against an unreachable Redis it hangs forever, so "Redis down -> webhook returns 500" would have been a hang. Fixed with `enqueueOn` (3 s deadline).
3. **My S3 premise was wrong.** Debounce does *not* drop a message that arrives mid-generation; it makes a second job. But the older generation can finish *last*, so the post-completion staleness check stays mandatory.
4. **The double-send hazard is real, and the fix works.** SIGKILL a worker mid-job: with BullMQ's default the job re-runs (would send twice); with `maxStalledCount: 0` it is failed as stalled. Both cases are permanent tests.
5. **Spec 6.5 vs 8 disagree** on whether the owner can approve a `scheduled` draft; I followed 6.5.
6. Stack: `ai` is v7 not v6, Node 22 is out of maintenance, TypeScript 7 / ESLint 10 exist but the lint toolchain does not support them yet.

## Honest limitations

- **Docker is unverified.** The `Dockerfile` and `--profile full` containers were never built or run. Compose passes client-side validation only.
- **Nothing touching Meta, Groq or Telegram ran**: those hosts are blocked from the sandbox. Phase 0 has no such code yet; Phase 1+ will be mock-tested here and **verified by you** on your laptop.
- **Secure cookies on plain http.** In a production build (`NODE_ENV=production`) the session cookie is `Secure`. Chromium accepts that on `http://localhost`; Safari may not. For local work use `pnpm dev`; for real use put it behind HTTPS.
- **`X-Forwarded-For` is trusted** for the login rate limit. Behind a proxy that does not overwrite it, the limit is bypassable. Documented in README and DECISIONS.
- **The login form is browser-verified by hand**, not by an automated test (Playwright is outside the approved dependency list).
- `next start` prints "Ready" a few milliseconds *before* the env check exits the process; no real traffic can land in that window, but it is not literally "before ready".
- ESLint 9 is flagged deprecated on npm (D-003). One early commit shipped with a failing `tsc` because I piped a gate through `tail`; fixed in the next commit and the rule is now in CLAUDE.md.
- Dev database passwords (`wab_*_dev`) are intentionally public in the repo; production must use real ones.

## Please run these on your laptop

```bash
git pull && cp .env.example .env     # fill BETTER_AUTH_SECRET (openssl rand -base64 32), OWNER_EMAIL; other vars may be placeholders for now
docker compose up -d                  # expect: postgres + redis healthy
pnpm install --frozen-lockfile && pnpm db:migrate
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration     # expect: all green (270 + 70)
pnpm seed:owner                       # interactive: pick a password, scan the setup key, type the 6-digit code
pnpm dev                              # then open http://localhost:3000 and sign in with password + code
docker compose --profile full build   # optional: this is the one thing I could not run
```

If any of these fail, paste the output and I will fix it before Phase 1.

## Needed before / at the start of Phase 1

1. **Real Meta webhook samples.** I cannot read Meta's docs from here. In your Meta app's webhook test tool, copy real sample payloads (a text message, an image, a voice note, a status, and if you can, a Coexistence echo and a history batch) into `test/fixtures/webhooks/`. Otherwise my fixtures stay marked `unverified`. Alternative: allow `developers.facebook.com` in the cloud environment's network settings (docs only, never the API hosts).
2. **A Cloudflare tunnel** (`cloudflared`) on your laptop for the live-message acceptance step, and confirmation that your number really is onboarded with **Coexistence** (it requires Meta's Embedded Signup flow).
3. No blocking questions. Owner name is entered at `seed:owner`; business name is seeded as `agent_47`.
