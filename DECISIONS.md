# DECISIONS

Short entries: decision, alternatives considered, reason. Newest last within a phase. Entries marked **[approved]** were
explicitly approved by the owner during planning; **[logged]** are judgment calls made and recorded per spec 0.2;
**[pending]** are agreed deviations that land in a later phase.

Where this file and the spec disagree, this file wins.

## Phase 0 (2026-10-04)

### Stack and tooling

**D-001 [approved] AI SDK v7 + Node 24 LTS.** Spec said "AI SDK v6" and "Node 22 LTS". `ai@latest` is 7.0.x (v6 is only the
`ai-v6` dist-tag) and v7's own migration guide says Node 22 left maintenance on 2026-04-30. Alternatives: pin v6 (matches the
text, buys an immediate migration), v7 on Node 22 (unsupported runtime in prod). Built on `ai@7` + `@ai-sdk/groq@4`; Docker on
`node:24-slim`; `engines.node >=22` (tests also run on 22.22). v7 deltas to honor: `system`->`instructions`, result metadata under
`finalStep`, `transcribe` (no `experimental_`), ESM-only (`"type":"module"`). `generateText` + `Output.object` + `result.output` are unchanged.
Installed from Phase 1 (first needed for transcription).

**D-002 [approved] Worker runs under `tsx --conditions=react-server`.** Spec said `node worker/index.ts (compiled)`. Two things break
that: the `@/` alias does not resolve in plain Node, and `import 'server-only'` (required by spec 11) THROWS outside Next unless Node
runs with `--conditions=react-server` (verified: it crashes without the flag). Alternatives: esbuild bundle (two tools), native Node
type-stripping (bans enums, forces `.ts` import extensions, fragile with Drizzle/Zod). tsx is a runtime dependency (prod too). Vitest aliases
`server-only` to an empty stub.

**D-003 [logged] TypeScript 5.9, ESLint 9.** npm `latest` is TypeScript 7 (native port) and ESLint 10, but `typescript-eslint` supports
`<6.1` and `eslint-plugin-react` (via `eslint-config-next`) does not support ESLint 10. Pinned to the newest versions the toolchain
supports. ESLint 9 is marked deprecated on npm; revisit when `eslint-config-next` supports 10. `next lint` no longer exists: `pnpm lint` runs ESLint directly (flat config).

**D-004 [logged] Hand-written shadcn-style primitives.** `ui.shadcn.com` is unreachable from the build sandbox, so `shadcn add` cannot run.
Button/Badge/Card/Input/Label/Skeleton are written in the shadcn conventions (cva + `cn`); `components.json` is present so
`shadcn add` works later. System font stack (`next/font/google` would fetch at build time).

**D-005 [logged] pnpm `onlyBuiltDependencies`** = `@tailwindcss/oxide, esbuild, sharp, unrs-resolver`. `msgpackr-extract` (an optional native speedup
for BullMQ) is left unbuilt; BullMQ falls back to pure JS.

**D-006 [logged] Spec reference error.** Spec 0.2 asks `CLAUDE.md` to condense "section 3.3", which does not exist; section 3.2 (what is NOT used,
and why) was condensed instead.

### Data model

**D-007 [approved] Contact identity (A1).** `contacts.wa_user_id NOT NULL UNIQUE` cannot represent name-only imported contacts, so imported
history and the live thread would split permanently; BSUIDs also change on phone-number change. Now `bsuid` (unique, null), `phone_e164` (unique, null),
`source` enum(`webhook`,`import_phone`,`import_name`), `CHECK (bsuid IS NOT NULL OR phone_e164 IS NOT NULL OR source='import_name')`. Match bsuid then phone;
`user_id_update` rewrites bsuid; a transactional merge joins an imported contact to a live one on phone match (Phase 1). Outbound recipient: phone if present
(`to`), else BSUID via `recipient` with `to` omitted (per secondary sources; verify in Phase 2). Possible "parent BSUID" field: verify in Phase 1.

**D-008 [approved] Send path fixes (A + A2).** (A) Spec 6.5 claimed the draft BEFORE pre-send checks, stranding it `approved` on a failed check: claim + precheck + insert are now one
transaction (`SELECT ... FOR UPDATE`; failure rolls back, draft stays pending). (A2) A worker dying after Meta accepts but before `wamid` is stored would be re-run by BullMQ
stalled recovery and send twice (Cloud API has no idempotency key): added `messages.send_started_at`, stamped atomically before the HTTP call; a re-run that finds it
set without a wamid marks the message `unknown` and never resends; outbound worker `maxStalledCount: 0`. **Proven empirically** (`test/integration/bullmq-spike.test.ts`, SIGKILL mid-job): with 0 the crashed job is failed as stalled and not re-run; BullMQ's default (1) re-runs it, which would have sent twice.

**D-009 [logged] Further schema amendments (proposed in the plan, approved with it).** A3 `messages.edited_at`/`deleted_at` (spec 6.7 says edits "update the stored message" with nowhere to record it).
A4 `messages.transcription_status` (pending/done/failed/low_confidence) so `unreadable_media` is derived from data, not placeholder text. A5 `webhook_events.payload` nullable (purge nulls it, the row keeps its `dedupe_key`).
Also: `eval_runs.style_guide_version` and `ai_runs.prompt_version` nullable (eval can run cold; transcription has no prompt); `audit_log.entity_id` is text (settings uses `'1'`); `notifications.telegram_message_id` is text.

**D-010 [logged] Auth tables are hand-translated** from `getAuthTables()` of the installed Better Auth, not the CLI (`@better-auth/cli` is 1.4.x vs library 1.7.x). SQL names `auth_*` (avoid the reserved word `user` and app-table clashes),
text ids (we generate uuid v7 through `advanced.database.generateId`), plus `auth_rate_limit` for DB-backed rate limiting. `test/unit/auth-schema.test.ts` re-reads Better Auth's own definitions and fails if an upgrade adds or requires a field.

**D-011 [logged] Roles and env.** Added `DATABASE_MIGRATION_URL` (spec 11 requires a no-DDL app role but spec 14 had one URL) and `BULLMQ_PREFIX` (also namespaces the pub/sub channel: pub/sub ignores the Redis db index, so a shared Redis would cross-talk).
Roles `wab_migrator`/`wab_app` with dev-only passwords in `scripts/db-init/01-roles.sql` (idempotent). `0001_grants.sql` makes `audit_log` append-only for `wab_app` and **fails loudly** if the role is missing (a silent skip would leave the app role unrestricted).

**D-012 [logged] UUID v7** via a 15-line `src/lib/ids.ts` (Node has none, Postgres 16 has none). Timestamps `timestamptz`; `content_tsv` uses the `simple` config (multilingual content).

### Auth and security

**D-013 [logged] TOTP "required" is enforced by the guard.** Better Auth does not require 2FA by default. `checkOwner()` accepts a session only for `OWNER_EMAIL` AND `twoFactorEnabled`. `seed:owner` enrolls TOTP through Better Auth's real endpoints and **confirms with a real authenticator code**
(`--auto-verify` exists for tests/CI only). `--reset` rotates password and TOTP and revokes sessions. Min password 12 chars. The first-login enrollment page (plan B) was not needed: script-side enrollment works.
Residual: Better Auth's `trustDevice` option exists on the API; the UI never sends it.

**D-014 [logged] Rate limiting in Postgres** (5/15 min/IP on `/sign-in/email`, `/two-factor/verify-totp`, `/two-factor/verify-backup-code`) so a restart cannot reset the counter. The IP comes from forwarded headers: **deploy behind a proxy that overwrites `X-Forwarded-For`**
or the limit is bypassable by spoofing. The 2FA plugin adds its own account lockout (10 failures / 15 min).

**D-015 [logged] Authorization layers.** `proxy.ts` (Node runtime, verified in `next@16.3` docs) only redirects on a missing cookie and excludes `/api/*`; Server Functions skip proxy on excluded paths, so every page (`requireOwnerPage`), action (`ownerAction`) and route handler (`checkOwner`) authenticates itself.
Verified on the built server: a forged cookie passes the proxy and is bounced by the page. `ownerAction` order: authenticate -> Zod -> handler + audit in one transaction. The Next-bound part is split from `owner-action-core.ts` because `src/lib` may not import `next/*`.

### Spec inconsistencies found

**D-016 [logged] Owner may approve a scheduled draft.** Spec 6.5's claim query is `status IN ('pending','scheduled')` but the section 8 diagram has no owner arrow out of `scheduled`. Implemented 6.5 (an explicit owner action beats the autopilot timer; the caller must also remove the delayed job).

**D-017 [logged] Message machine extensions.** Webhook `failed` is accepted from `queued`, `sent`, `delivered` and `unknown` (spec listed `sent`/`delivered` only); a failure report is information and is a forward move. `read` and `failed` ignore later contradictory webhooks (successful no-op, `changed:false`).
`unknown --owner_resend--> failed`: the original row is closed, a NEW queued row carries the resend (so the dedupe job id never collides).

**D-018 [logged] Spec job ids are unbuildable.** BullMQ 6 rejects custom job ids containing ":" ("Custom Id cannot contain :"), but every spec key is `msg:{wamid}`, `send:{id}`, `autopilot:{id}`... `toJobId` percent-encodes (injective, readable); callers keep passing the spec's keys. A canary test fails if BullMQ ever lifts the restriction. Dedupe ids for debounce may contain ":" (verified).

**D-019 [logged] `Queue.add` against an unreachable Redis never settles** (verified). Connection-level `maxRetriesPerRequest` does not help, so request handlers use `enqueueOn` (3 s deadline -> `QueueUnavailableError` -> HTTP 500 so Meta retries). Producers use fail-fast connections; workers use `maxRetriesPerRequest: null` (BullMQ requires it; verified it throws otherwise).

**D-020 [logged] S3 premise corrected.** The plan feared debounce could drop a message arriving while a draft job is running. Verified: it does NOT; it creates a second job. But with concurrency 2 the older generation can finish LAST, so `generate-draft` (Phase 4) must still re-check at completion whether newer inbound messages exist and discard if so. Test pins both facts.

**D-021 [logged] BullMQ does not close connections it is handed** (verified); the worker runtime owns and quits its connections. `registerSchedulers` makes Redis match code exactly (stale schedulers removed). Cron patterns accept `tz` (20:00 Africa/Kampala fires 17:00 UTC, tested). Failed jobs are kept 30 days (`removeOnFail.age`); completed jobs 1 day / 1000 (`removeOnComplete`; spec silent).

**D-022 [logged] Realtime.** Events are `z.strictObject`s: a stray `body`/`content` field is rejected at publish time. Channel `{BULLMQ_PREFIX}:dashboard` (spec said `dashboard`).

**D-023 [logged] Instrumentation.** Next compiles `instrumentation.ts` for Edge too; the Node-only env check (`process.exit`) sits behind a literal `NEXT_RUNTIME` check in `instrumentation-node.ts`. This is the only non-env file allowed to read `process.env`. `next build` needs no runtime secrets and emits no warnings.

### Environment and testing

**D-024 [logged] Test environment.** No Docker daemon in the build sandbox; integration tests ran against native Postgres 16.14 and Redis 7.0.15 (the same URLs the compose stack exposes). `docker-compose.yml` and the Dockerfile are **written but not run here** (compose validates client-side). Tests refuse any database not ending `_test` and any Redis db other than 15.
External hosts (Groq, Meta, Telegram, most docs sites) are blocked from the sandbox: all external HTTP is mocked at the fetch layer. Library docs are read from `node_modules` (`next/dist/docs`, `ai/docs`, `@ai-sdk/groq/docs`); Better Auth ships none, so its API was read from type definitions and proven by tests.

**D-025 [logged] Mutation-checked guards.** The audit-log immutability test, the "TOTP required" guard test and the "status never moves backward" tests were each verified to FAIL when the protection is removed. A security test that has never failed has proven nothing.

**D-026 [logged] Process slip.** One commit (`0d760a5`) shipped with a failing `tsc` because a gate was piped through `tail`, hiding the exit code; fixed in the next commit. Gates now run on real exit codes (see CLAUDE.md).

### Pending (implemented in later phases)

**D-027 [pending] Proposed fixes S4-S13** from the plan, each landing in the phase that builds the affected code: S4 webhook body cap via `Content-Length` then a byte-capped stream read (Phase 1); S6 Whisper does not support Luganda (to verify on a real note), so low language confidence/unsupported language ->
`transcription_status='low_confidence'` -> `unreadable_media` (Phase 1); S7 invented-fact detector covers `50k`/`UGX 50,000`/separators/month names, numbers-in-words is a documented blind spot (Phase 3); S8 eval reports p25/p75 and a paired-bootstrap CI and the ship rule uses the CI (Phase 3);
S9 the draft prompt/call land in Phase 3 because the eval needs them; S10 import date-order detection and U+202F/LRM handling (Phase 3); S11 coexistence kinds `smb_app_state_sync` and `account_update` (Phase 1); S13 edit distance = normalized Levenshtein over NFC code points (Phase 2).

**D-028 [pending] Unverified from the sandbox**, to confirm on your machine or when docs are reachable: Meta payload shapes and error-code table, latest Graph version, Groq production model list (`.env.example` candidates are marked VERIFY), Groq strict JSON-schema support per model.

**D-029 [pending] Phase 7 gate.** Spec 10.1 gates autopilot on median edit distance <= 0.30 over ~50 samples with 0 invented facts. That is weak evidence (0/50 does not bound the true rate under ~6% at 95% confidence). Proposal for Phase 7: also gate on p75, require >= 200 approved drafts, and show unedited rate. To be asked at the start of Phase 7.
