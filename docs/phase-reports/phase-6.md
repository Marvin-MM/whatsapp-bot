# Phase 6 report: analytics and production hardening

Date: 2026-10-05. Branch `claude/whatsapp-reply-assistant-bb49ug`. Spec phase 6 (+ D-082..D-091 in `DECISIONS.md`).

## Verdict

Phase 6 is **built and verified against everything a sandbox can verify**, and **not run on a real server.** The dashboard now answers "are the drafts
good enough to trust?" (Analytics: the edit-distance chart with the autopilot threshold on it), shows what has gone wrong and lets the owner act on it
safely (Settings -> Problems, Audit log), tells the owner when the worker stops (heartbeat endpoint and status), sends a strict Content-Security-Policy
that the whole app runs under with zero violations, and ships a production stack and **backups whose restore is proven by the restore itself** (every
table's row count is compared with the backup). What does **not** exist is evidence from a real Docker host: the compose file, the Caddyfile, a real
certificate, HSTS in a browser and a real `rclone` remote have never been exercised. The first deploy is the first real run; `docs/operations/production.md`
ends with the checklist, and `docs/ACCEPTANCE.md` steps 30-34 are yours.

## What was built

| Area | What it does | Where |
|---|---|---|
| Analytics queries | Owner-calendar-day buckets, zero-filled; volume, median first reply, draft outcomes, edit distance (median / p75 / edited share), tasks by kind, AI usage (+ cost only with owner-supplied prices) | `src/lib/metrics/analytics.ts`, `chart-format.ts`, `env.ts` (`AI_PRICE_PER_MTOK_JSON`) |
| Analytics page | Edit distance first, with the autopilot threshold line; every chart has its definition and a "Show the numbers" table; 7 / 30 / 90 days | `src/app/(dashboard)/analytics`, `src/components/analytics/*` |
| Failed jobs | List, Retry (only where it cannot double-send), Dismiss; audited by ids; stale clicks explained | `src/lib/ops/failed-jobs.ts`, `src/actions/jobs.ts`, `src/components/settings/failed-job-row.tsx` |
| Audit viewer | Newest first, keyset pages, filters (action / record / actor / dates), entity links, no text | `src/lib/ops/audit-view.ts`, `audit-present.ts`, `/settings/audit` |
| Worker health | 15 s heartbeat, 45 s staleness, `GET /api/health/worker` 200/503, status in Settings | `src/lib/ops/worker-health.ts`, `worker/runtime.ts`, `src/app/api/health/worker` |
| Settings | Four sections: General, Business profile, Problems, Audit log | `src/app/(dashboard)/settings/*`, `settings-nav.tsx` |
| Security headers | Per-request nonce CSP, `X-Frame-Options`, `Referrer-Policy`, `nosniff`, `Permissions-Policy`, HSTS on https; fixed headers on `/api` via `next.config.ts` | `src/proxy.ts`, `src/lib/security/headers.ts`, `next.config.ts`, `not-found.tsx`, `browser-setup.tsx` |
| Production stack | Caddy + web + worker + one-shot migrate + Postgres + Redis; explicit env pass-through; production role bootstrap | `docker-compose.prod.yml`, `deploy/Caddyfile`, `scripts/db-init-prod/01-roles.sh`, `Dockerfile` |
| Backups | Snapshot-consistent dump + row counts, checksums, `age`, `rclone`, retention, loud warnings; restore into an empty target and verify | `scripts/backup.sh`, `scripts/restore.sh` |
| Docs | Deploy, update, health, hardening, first-deploy checklist; backups, the monthly rehearsal, disaster recovery; README sections and troubleshooting | `docs/operations/*`, `README.md`, `CLAUDE.md` |

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| `pnpm test` (unit) | **1,031 passed** (53 files) |
| `pnpm test:integration` (real Postgres 16 + Redis 7) | **829 passed** (44 files) |
| **Fresh clone** of the pushed branch, fresh Postgres cluster bootstrapped with the production role script, different passwords | install (frozen lockfile), migrate an EMPTY database, typecheck, lint, 1,031 unit, 829 integration all exit 0; production build with an EMPTY environment exit 0; web + worker start, `/api/health` and `/api/health/worker` 200, owner seeded |
| Analytics | 12 integration + 21 unit tests: queries against hand-computed seeded data (bucket edges in Kampala time, medians, p75, outcomes, units); in Chromium the volume table equals SQL run independently over the same 30 days, and "drafts sent" equals the database |
| Failed jobs / audit / worker health | 17 + 10 + 4 integration tests and 5 + 4 + 5 unit tests; in Chromium with real failed jobs: Retry enabled/disabled per the rule, Dismiss removes the job from Redis, a stale click is explained and writes no audit entry, audit paging continues without repeating, filters and entity links work |
| **CSP** | Chromium on the production build, **every page, zero `securitypolicyviolation` events and no console errors**: desktop on the sandbox data, desktop and phone on the fresh clone's empty database; the nonce on every `<script>` tag equals the response's; login form hydrates and a server-action round trip works; chart tooltips and details work; media keeps its own sandbox CSP; SSE still streams |
| Compose / Caddyfile | `docker compose config` valid; the rendered web and worker environments parsed by the REAL env schema; static tests (explicit env, role separation, loopback Postgres, Redis password + `noeviction`, `X-Forwarded-For` overwritten, no compression of the event stream) |
| **Restore drill** | fresh cluster bootstrapped by `db-init-prod`; the sandbox database (19 tables, 1,352 rows, 2 media files) dumped (encrypted, stand-in `rclone`) and restored: row counts equal, `messages` md5-identical, runtime role still append-only and DDL-less, migrations a no-op; refusals (non-empty target/media, tampered file, wrong/missing key, mismatched counts, unencrypted upload, bad URL, missing media dir); **three backups taken while rows were being inserted all restored exactly**; the same scripts without `--snapshot` failed verification 4 of 4 |
| `test/integration/backup-restore.test.ts` | 16 tests run both scripts for real against `wab_test` / `wab_restore_test` (encryption tests skip only if the `age` tool is absent) |
| **Mutation checks** | CSP builder, proxy, API headers: 20 (all killed, one first survivor closed); inline-style guard: 1; `backup.sh`: 13 runs; `restore.sh`: 8 (two judged equivalent, see D-091) |

## NOT verified (and what that risks), most important first

1. **Docker and the production stack, end to end.** No Docker daemon here. A wrong volume permission, a Caddy directive that does not behave as I believe,
   a healthcheck that never goes green or the migrate-then-start ordering could all fail on first run. Risk: a failed first deploy, not data loss.
2. **The CSP behind the real Caddy over https, in your browser.** The test origin is `http://localhost`: `upgrade-insecure-requests` and HSTS are unit-tested
   but never seen in a browser, and the headers have never passed through Caddy.
3. **A restore on another machine or Postgres minor version; a real `rclone` remote.** The drill used two clusters on one machine and a stand-in `rclone`
   that checks the command line. Only your monthly rehearsal answers this, and it is the thing that matters most about a backup.
4. **Login rate limiting behind Caddy** (the `X-Forwarded-For` overwrite is configured and tested as text, never as behaviour).
5. **Anything on a real phone**, and every Phase 1-5 item in `docs/ACCEPTANCE.md` that needs a real Meta, Groq or Telegram.

## What is weak (my own critique)

- **The only person who can restore is the one holding the `age` secret key.** Lose it and every encrypted backup is noise; keep it on the server and
  encryption protects nothing. The docs say where it must live; nothing here can enforce it.
- **Postgres is published on the server's loopback.** Any process on that machine can try the password. A container-only network plus `docker exec`
  backups would avoid it, at the price of scripts that only work through Docker (and that I could not test without it).
- **Recharts still forces `style-src-attr 'unsafe-inline'`.** It is narrow (attributes cannot run script) and guarded, but it is a hole the strictest policy
  would not have, kept because the alternative is no charts or a chart library written here.
- **Retry on an "idempotent" queue is a belief about the handlers**, backed by tests for the send path and the analysis, not a proof for every queue.
- **The problem list shows 20 messages and the failed-jobs list 25 per queue**, no paging; fine for one owner and under 500 messages a day, not for a bad week.
- **The backup scripts are bash.** They are tested against real Postgres, but bash is a poor language for the failure handling they do; the tests are what
  make that tolerable, so a change to either script without the integration test is a regression waiting.
- **The Autopilot switch on Settings is confusing** (a disabled toggle with the knob at the right means "autopilot is paused"): Phase 7 replaces it with
  the gated reply-mode control, and I did not polish what is about to be removed.
- **The analytics medians are as good as the stored `edit_distance`**, which is computed once at approval; a change to the distance function later would
  make old and new days incomparable (D-082 notes the definition; there is no version column).

## Commands

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration       # needs the wab_restore_test database: psql -f scripts/db-init/01-roles.sql
docker compose -f docker-compose.prod.yml --env-file <your env> config   # validates the production stack without Docker running
scripts/backup.sh /etc/wab-backup.env                                    # then: scripts/restore.sh <folder> /etc/wab-restore.env  (docs/operations/backup-restore.md)
```

## Next

Phase 7 (autopilot, ships OFF): the eligibility gate with every check's numbers shown, the deterministic policy and the separate verifier, the delayed
`autopilot-send` job with its re-checks, the Telegram Cancel / Send-now webhook (and the script that registers it), demotion on complaint, "Mark bad",
the reply-mode control and its gate reasons, the daily digest, and analytics for sent-vs-routed. Autopilot stays unreachable until the gate passes on your real data.
