# CLAUDE.md: standing memory for this repo

Single-owner WhatsApp Business reply assistant: webhook ingest -> style-matched drafts -> owner approval -> send ->
summaries/tasks -> (later, gated) autopilot. One owner, one number, <500 msgs/day, one instance of each process.
No horizontal scaling, no multi-tenancy. Every abstraction must justify itself against that.

Authority: the build spec (phases 0-7), amended by `DECISIONS.md`. Read `DECISIONS.md` first: it records where this repo
deliberately differs from the spec and why. **Phases 1-7 were authorized to run continuously** (owner request, D-030): finish
a phase, run acceptance, write the phase report (`docs/phase-reports/`), push, continue. Stop only for something the owner must supply.

## Commands
```
docker compose up -d              # Postgres 16 + Redis (no Docker? native pg/redis work: see README "Without Docker")
pnpm install && pnpm db:migrate   # migrations run as the migrator role, never during `next build`
pnpm seed:owner                   # creates the owner, enrolls TOTP (prompts; --help for flags)
pnpm dev / pnpm dev:worker        # web / worker (tsx --conditions=react-server)
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
scripts/backup.sh [config] / scripts/restore.sh <folder> [config]   # production backups; docs/operations/
```
Gate commits on REAL exit codes. Never pipe a gate through `tail`/`grep` and then commit: that hides failures.

## Standing rules (spec section 0.3)
1. **Training data is stale for this stack.** Read current docs before using a library/API. They ship in `node_modules`:
   `node_modules/next/dist/docs`, `node_modules/ai/docs`, `node_modules/@ai-sdk/groq/docs`. Log differences in DECISIONS.md.
2. No dependency beyond the stack without asking. Small utilities are written, not installed.
3. No placeholders in shipped code (`TODO: implement`, fake data outside tests/seeds, commented-out logic).
4. **Ask before deciding** anything touching the data model, the send path, autopilot policy or security. UI/naming: decide and log.
5. Tests ship with the feature; a phase with failing or missing required tests is not done.
6. TypeScript `strict` + `noUncheckedIndexedAccess`; no `any` (use `unknown` + Zod); no non-null assertions on external data.
7. Every external input is Zod-validated at the boundary: env, webhooks, action inputs, AI output, Telegram, imports.
8. Simple and explicit over abstract. Log every unsettled judgment call in DECISIONS.md.

## Stack (fixed; see DECISIONS.md for version choices)
Next 16 App Router + `proxy.ts` (not middleware) - Node 24 target - pnpm - Postgres 16 + Drizzle (postgres.js) - BullMQ 6 +
ioredis - SSE over Redis pub/sub - AI SDK **v7** + `@ai-sdk/groq` (`generateText` + `Output.object`; `generateObject` is
forbidden) - Zod 4 - Better Auth (+ TOTP) - Tailwind v4 CSS-first + hand-written shadcn-style primitives - pino - Vitest.
Models come ONLY from env (`LLM_MODEL_*`). **Not used**: LangChain/LangGraph (every AI step is one structured call; autopilot
is a deterministic policy function), Socket.io, Prisma, NextAuth, TanStack Query, vector DBs, unofficial WhatsApp clients (ban risk).

## Architecture rules enforced by lint/tests
- `src/lib/**` and `worker/**` must not import `next/*` or `react`. Framework code lives in `src/app`, `src/actions`,
  `src/components`, `src/server`. Modules with secrets `import 'server-only'` (tests alias it; the worker runs with `--conditions=react-server`).
- `process.env` is read only in `src/lib/env.ts` (plus `src/instrumentation.ts` for `NEXT_RUNTIME`, configs, tests).
- `proxy.ts` only redirects and sets the page security headers (CSP nonce): it authorizes nothing. **Every page, server action and route handler verifies the session itself**
  (`requireOwnerPage`, `ownerAction`, `checkOwner`); a valid session = configured owner AND TOTP enrolled.
- Every mutation is an `ownerAction`: auth -> Zod -> handler + audit entry in ONE transaction (failure rolls back both).
- App DB role (`wab_app`) has DML only and is append-only on `audit_log`; migrations use `wab_migrator`.
- BullMQ job ids may not contain ":": pass the spec's keys (`msg:{wamid}`) through `enqueue()`/`toJobId`. Request handlers
  enqueue with a deadline (`enqueueOn`): `Queue.add` never fails fast on its own.
- Realtime events are Zod-strict: IDs and minimal fields only, never message bodies. Channel is `{BULLMQ_PREFIX}:dashboard`.

## Core invariants (spec section 6; do not weaken)
- **Webhook**: read raw body (cap 1 MB, check Content-Length first) -> verify `X-Hub-Signature-256` (HMAC-SHA256,
  `timingSafeEqual`, length check, never throw) -> 401 and NO DB write if bad -> validate envelope -> iterate EVERY
  entry/change/item -> `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING` + enqueue -> any DB/Redis error = 500 (Meta retries).
  No AI and no other work in the request. A sweeper re-enqueues unprocessed events.
- **Identity**: contacts keyed by `bsuid` OR `phone_e164` (both nullable); match bsuid then phone; `user_id_update` rewrites
  bsuid; imported name-only contacts merge transactionally when a live contact matches by phone. Never assume a phone exists.
- **24h window**: `window_expires_at = last_inbound_at + 24h`, set only by inbound customer messages (never by echoes).
  Checked immediately before every send; outside it only templates may be sent.
- **One send path** (`src/lib/send/send-message.ts` only): ONE transaction does `SELECT ... FOR UPDATE` draft -> `precheck()`
  -> claim + insert outbound row (a failed check rolls back; draft stays pending). Never hold a transaction across the HTTP
  call. Worker stamps `messages.send_started_at` atomically BEFORE calling Meta; a re-run that finds it set with no wamid
  marks the message `unknown` and NEVER resends. `outbound-send` runs `maxStalledCount: 0`. Ambiguous errors (timeout, reset
  after write) -> `unknown`, alert, no retry. Safe retries only: pre-send connection failure, 429, Meta rate-limit, 5xx with a Meta body.
- **No invented facts**: unknown facts become `[[placeholders]]` that block sending. Customer text is DATA (sanitize `<`/`>`,
  truncate 2,000). Never deny being AI when sincerely asked. Inbox works with AI disabled. Kill switches: `ai_paused`,
  `sending_paused`, `autopilot_paused` (default true).
- Statuses never move backward (`read` > `delivered` > `sent`); drafts/messages use the pure state machines in `src/lib/state`.
- Few-shot/style learning only from `owner_manual`, `owner_app_echo`, `imported`, `ai_edited`: never `ai_unedited`/`ai_autopilot`.

## Security and privacy (spec section 11)
Secrets server-side only (no `NEXT_PUBLIC_*` secrets); `WHATSAPP_ACCESS_TOKEN` is a System User token; sign-up disabled,
owner via `seed:owner`, TOTP required, login limited to 5/15min/IP (stored in Postgres; deploy behind a proxy that
OVERWRITES `X-Forwarded-For`); cookies httpOnly + secure(prod) + SameSite=Lax. Logs never contain message bodies, tokens or
full phone numbers (redaction list in `src/lib/logger.ts`, `maskPhone`). Customer messages are processed by Groq (say so in
README). Raw `webhook_events.payload` is purged after 30 days (row kept for dedupe). Media is served only via an authenticated route.

## Testing
Unit: `test/unit` (no services). Integration: `test/integration` against real Postgres + Redis; refuses any database not
ending `_test` and any Redis db other than 15. Mock external HTTP (Meta, Groq, Telegram) at the fetch layer. A guard test
that has never failed has proven nothing: mutation-check security tests. Real-model suite is opt-in (`pnpm test:ai`, Phase 4+).

## Hard-won rules (learned the expensive way; each has a test)
- **The 24h window has ONE definition**: `refreshConversationAggregates` (live customer messages only; never echoes, reactions, imports, history).
  Never write `window_expires_at` anywhere else. Send-path pre-checks use `isWindowOpen` from `src/lib/conversations/window.ts`.
- **Raw `db.execute(sql...)` returns timestamps as STRINGS** (Drizzle disables date parsing). Convert with `toDate`; a `Date` inside a
  `sql` fragment must be an ISO string with `::timestamptz`. Typed builders are fine.
- **Never guess an identity.** Unresolvable echo/history/identity -> park + `raiseAlert`, never file under a guess. Merge two contacts only
  when nothing contradicts it. A phone number is only FILLED when blank (late retried webhooks carry older numbers).
- **Untrusted text never reaches a model unless it is trustworthy**: unreliable transcripts are discarded, customer-deleted messages are
  blanked, transcripts are labelled machine-made.
- **Media is untrusted bytes**: MIME allowlist, type must match the message, extension from the verified MIME, atomic write, realpath
  containment when serving, `nosniff` + CSP sandbox. The Graph download URL must be public https.
- **Dedupe keys of id-less events include `entry.time`**; BullMQ ignores `add` for an existing job id (remove the failed/completed job first).
- **Effects happen after commit** (`runEffects`); `processed_at` is stamped last; handlers are idempotent; SSE is best-effort.
- Postgres cannot store U+0000: strip before storage (`stripNulChars`).
- **Send path (Phase 2)**: `queueMessage` (inside the caller's transaction: lock conversation -> idempotency -> pre-check -> insert `queued`
  -> claim draft; a refusal THROWS and rolls everything back) and `performSend` (worker: stamp `send_started_at` atomically, HTTP outside any
  transaction, outcome in a second one; effects after commit). Only `send-message.ts` may import `whatsapp/send-api.ts` or queue an outbound
  row (a static test enforces it). Retry only when Meta definitively did not send; timeout / reset / unreadable / 5xx-without-body =
  `unknown`, never retried, never resent by code (the owner marks it sent or resends). Enqueue after commit through `afterCommit`.
  A server action never makes a network call inside its transaction (templates are read from the Redis cache the picker warmed).
- **Style and drafting (Phase 3)**: learning reads ONLY the owner's own words (`ELIGIBLE_OWNER_PROVENANCE` in `fewshot-sql.ts`: never `ai_unedited` /
  `ai_autopilot`); every person-written or model-written string put in a prompt goes through `sanitizeForPrompt`; stage rules live in `stages.ts` AND
  `fewshot-sql.ts` (a parity test keeps them equal: change both); the draft prompt is versioned (`DRAFT_PROMPT_VERSION`): any change to it, the
  model or the style guide requires `pnpm eval:drafts` and a note in DECISIONS.md; imported messages are provenance `imported` on BOTH sides and
  can never open the 24h window.
- **Drafts and approvals (Phase 4)**: ONE `generate-draft` job per conversation (debounce via deduplication `replace`+`extend`); the job answers the
  unanswered set (`loadUnanswered`) and re-checks under the conversation lock at completion (discard when the set changed, the owner replied, or
  another generation covered it). A draft decision is an `ownerAction` through `queueMessage` (`src/lib/drafts/decide.ts`): "edited" is decided on
  TRIMMED text exactly as the send path decides provenance, so provenance, draft status, audit action and the answer cannot disagree; audit entries
  never carry the text. The pipeline adds the `prompt_injection` flag itself (`ai/injection.ts`: a warning, never a gate, narrow on purpose: add
  both an attack and an ordinary-chat case to `test/unit/prompt-injection.test.ts` when touching it). The Approvals badge, the Overview card and the
  queue count the same set (`countOpenDrafts`). A `noReplyNeeded` draft still has a non-empty acknowledgement (the schema demands it). Opt-in real
  model suite: `pnpm test:ai` (reads only `GROQ_API_KEY` and `LLM_MODEL_DRAFT` from `.env`: the suite truncates the `_test` database).
- **Summaries and tasks (Phase 5)**: `analyzeAfterMessage` (job per ACCEPTED outbound message: dashboard send once Meta has it, or a phone echo). The
  model call holds no transaction; the plan is applied under the conversation lock against the tasks as they are THEN. The model PROPOSES, code
  decides (`planOperations`: ids must be open tasks of this conversation, due dates not more than a day past, no duplicates, no no-op updates). Task
  text never goes in an audit entry or an alert (it comes from customer messages). Owner task changes are conditional updates; owner-typed times are
  `OWNER_TIMEZONE` wall clock (`parseLocalDateTime`). An overdue alert's key carries the due time. The `alerts-scan` analysis requeue is bounded to
  24 hours on purpose (D-077): never let a safety net replay history through a model.
- **Analytics and operations (Phase 6)**: day buckets are the owner's calendar days (`buildRange`, `AT TIME ZONE`, date arithmetic on date strings, never
  on instants); edit distance is grouped by `approved_at` and counts only drafts the owner approved; cost exists only with `AI_PRICE_PER_MTOK_JSON` (no
  built-in prices, ever). A failed-jobs "Retry" is allowed for an `outbound-send` job ONLY when its message is `queued` and was never stamped
  (`retryVerdict`); an `unknown`/stamped send and any `autopilot-send` are never retried from the panel. The worker heartbeat is judged by age
  (`judgeHeartbeat`: alive up to 45 s). The audit viewer shows ids and kinds, never text.
- **Security headers and the CSP (Phase 6)**: `proxy.ts` sets a per-request nonce CSP (`src/lib/security/headers.ts`) and keeps `/api` OUT of its matcher,
  because a proxy makes Next buffer request bodies (10 MB) and would undo the webhook's own 3 MiB cap; API routes get their fixed headers from
  `next.config.ts` (a test keeps both in step). Every page must render dynamically (a prerendered page has no nonce): `not-found.tsx` calls
  `connection()`. No `style={...}` in `src` (a test enforces it: the policy allows style ATTRIBUTES only for Recharts' wrapper; use Tailwind classes or
  SVG). Nothing in the browser may need `eval` (Zod's JIT probe is disabled in `browser-setup.tsx`). Check a UI change for CSP violations in Chromium
  on the production build (`securitypolicyviolation` events), not just in tests.
- **Production and backups (Phase 6)**: `docker-compose.prod.yml` passes containers ONLY the variables it lists (no `env_file`; a test requires every env
  schema key to be listed), and web/worker never receive the migration role's password. The images start `next`/`tsx` directly, not through pnpm.
  `scripts/backup.sh` and `restore.sh` are exercised by `test/integration/backup-restore.test.ts` (needs the `wab_restore_test` database from
  `scripts/db-init/01-roles.sql`): a backup is one snapshot (dump + row counts), a failed backup leaves nothing, uploads are refused unencrypted, and a
  restore goes only into an EMPTY database and prints `RESTORE VERIFIED` only when every row count matches. Never weaken those refusals; rehearse a
  restore after changing either script.
- **Notifications**: alerts go through `raiseAlert` (deduped); the Telegram sink is registered in the worker only; `info` alerts are
  dashboard-only; quiet hours silence everything but critical; no message bodies in any notification or audit entry.
- **Test infra**: `setupIngestHarness()` for ingest tests (not `use*`: the React-hooks lint rule trips on the prefix). Every guard test is
  mutation-checked (`scratchpad` script pattern: break the code, watch the right test fail, restore). Verify UI in Chromium against
  `pnpm build`, not only in tests (Phase 1 found five real defects that way, Phase 4 five more), and LOOK at the screenshots: an assertion that
  `scrollWidth <= innerWidth` passed while the page was visibly clipped, because the browser had zoomed out to hide the overflow. Check element boxes.

## Layout
`src/app` routes - `src/actions` server actions - `src/components` UI - `src/server` framework-bound server helpers -
`src/lib` framework-free domain (db, state, queue, realtime, auth, ai, send, whatsapp, notify, ops, ...) - `worker` BullMQ workers +
schedulers - `scripts` seed/migrate/import/eval/backup/restore (+ `db-init`, `db-init-prod`) - `drizzle` SQL migrations (generated + hand-written grants) -
`deploy` Caddyfile - `docs/operations` production + backup guides - `docs/phase-reports` - `test`.
