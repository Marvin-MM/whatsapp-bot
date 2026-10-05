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

**D-027 [pending, partly done] Proposed fixes S4-S13** (S4, S6 and S11 landed in Phase 1: see D-032, D-044, D-031) from the plan, each landing in the phase that builds the affected code: S4 webhook body cap via `Content-Length` then a byte-capped stream read (Phase 1); S6 Whisper does not support Luganda (to verify on a real note), so low language confidence/unsupported language ->
`transcription_status='low_confidence'` -> `unreadable_media` (Phase 1); S7 invented-fact detector covers `50k`/`UGX 50,000`/separators/month names, numbers-in-words is a documented blind spot (Phase 3); S8 eval reports p25/p75 and a paired-bootstrap CI and the ship rule uses the CI (Phase 3);
S9 the draft prompt/call land in Phase 3 because the eval needs them; S10 import date-order detection and U+202F/LRM handling (Phase 3); S11 coexistence kinds `smb_app_state_sync` and `account_update` (Phase 1); S13 edit distance = normalized Levenshtein over NFC code points (Phase 2).

**D-028 [pending] Unverified from the sandbox**, to confirm on your machine or when docs are reachable: Meta payload shapes and error-code table, latest Graph version, Groq production model list (`.env.example` candidates are marked VERIFY), Groq strict JSON-schema support per model.

**D-029 [approved, see D-049] Phase 7 gate.** Spec 10.1 gates autopilot on median edit distance <= 0.30 over ~50 samples with 0 invented facts. That is weak evidence (0/50 does not bound the true rate under ~6% at 95% confidence). Proposal for Phase 7: also gate on p75, require >= 200 approved drafts, and show unedited rate. To be asked at the start of Phase 7.

## Phase 1 (2026-10-04): ingest, media, live dashboard

### Process

**D-030 [approved] Phases 1-7 are built continuously.** The owner asked for every remaining phase "without stopping", which overrides the spec's and `CLAUDE.md`'s
"one phase per session, stop and wait" rule. What still binds: gates on real exit codes per commit, a phase report per phase (`docs/phase-reports/`), a push per phase, ask-before-deciding on data model / send path / autopilot / security
(the open items were asked up front: D-032, D-033, D-049). Everything that cannot be run from the build sandbox (Docker, Meta, Groq, Telegram, a real Luganda voice note) accumulates in `docs/ACCEPTANCE.md` for the owner's laptop instead of blocking.

**D-031 [logged] Meta's webhook documentation was unreachable; shapes were reconstructed and are marked unverified.** The three links given (Graph webhooks, sample apps, and a page that is the **Messenger** platform, not WhatsApp) are blocked by the sandbox's egress proxy.
Shapes come from type definitions and fixtures shipped in maintained npm packages (`@whatsapp-cloudapi/types`, `@better-zap/fixtures` Coexistence fixtures, `whatsapp-api-js`, `@great-detail/whatsapp`) plus search summaries.
Every fixture in `test/fixtures/webhooks/index.json` states its confidence (`sdk-types`, `oss-fixture`, `constructed`). Parsing is therefore tolerant (`looseObject`: unknown fields are kept, never rejected) and an unrecognised shape is stored and alerted, never dropped or guessed.
**Biggest residual risks** (each has a defensive path and a test): the echo shape (official `message_echoes[]` with `to` vs the open-source `messages[]` without it), the history shape (flat vs `threads[]`; D-040), and how edits and deletes are expressed (D-041).
Drop 5-6 real payloads from Meta's webhook test tool into `test/fixtures/webhooks/real/` and the contract tests absorb them (`docs/ACCEPTANCE.md` step 4).

### Webhook intake

**D-032 [approved] Body cap 3 MiB (spec: 1 MB).** One POST may batch ~1000 updates. The cap is enforced via `Content-Length` first, then a byte-capped stream read (a lying header cannot exhaust memory). Over the cap: 413, nothing stored.

**D-033 [approved] Schema additions (migration 0003).** `contacts.username` (a username user may have a BSUID and no phone) and `messages.marked_bad_at` (Phase 7 "Mark bad").

**D-034 [logged] Response policy.** Order: size cap -> HMAC-SHA256 over the RAW bytes (`timingSafeEqual`, length-checked, never throws; a re-serialised body fails) -> 401 and NO database write if bad -> JSON (400 if not) -> envelope.
A signed payload for another `object` is ignored with 200. A signed payload with the right `object` but an unparseable shape is stored as an `other` event, alerted, and answered **200**: a 4xx would make Meta retry it for ~36 h for nothing.
Any database or Redis failure answers 500 so Meta retries. Items for a different `phone_number_id` are not ours: settled and ignored. NUL (U+0000) is stripped before storage: Postgres cannot store it, and one such message would otherwise put Meta in a retry loop that also blocks the rest of its batch.

**D-035 [logged] Dedupe keys and the sweeper.** `msg:{wamid}[:edited|:revoked]`, `status:{id}:{status}`, `echo:{id}[...]`, `history:{request}:{phase}:{sha256(chunk)}`, `uidupd:{previous}:{current}`, and for events with no natural id (account state, app-state sync, preferences) a hash of the payload **plus the entry's `time`**:
Meta retries resend the same entry (same time) so replays still collapse, but a state that legitimately recurs (quality GREEN -> YELLOW -> GREEN -> YELLOW; a contact renamed back to its old name) is processed again. The sweeper (every 5 min) re-enqueues events unprocessed after 2 min, removes a failed/completed job first (BullMQ ignores an add for an existing id), counts an attempt only on a real re-enqueue, and alerts once at 10.

### Processing

**D-036 [logged] Persist, then process.** `process-webhook-event` validates the stored item, runs the handler in ONE transaction, runs side effects (enqueue, dashboard event, alert) AFTER commit, and stamps `processed_at` LAST. Handlers are idempotent (`messages.wamid` UNIQUE, conditional state machines), so a crash anywhere is repaired by retry or the sweeper.
An effect that must not be lost (a media download) is re-derived from database state on replay; dashboard events are best-effort (the dashboard also refreshes on reconnect). A status for a message we do not hold yet retries with backoff (5 attempts, ~30 s) and then settles with a note and NO alert (statuses for messages sent before we connected are normal). Concurrent webhooks for one customer are serialised with advisory locks.

**D-037 [logged] The 24h window has exactly one definition** (`refreshConversationAggregates`): the latest LIVE customer message (inbound, provenance `customer`, not a reaction) + 24 h. Echoes, reactions, imports and history can never open or extend it, and history cannot move it backward. A message timestamp more than 5 minutes in the future is clamped to now: a wrong clock must not extend the right to send free text.
Reactions and system notices never change the window, the status or the list order. Status: a customer message -> `waiting_on_me`; an echo -> `waiting_on_customer`; history leaves an existing status alone (new history conversations are created `resolved`).

**D-038 [logged] Identity.** BSUID first, then phone. Two records are merged only when nothing contradicts that they are one person; otherwise they are kept apart, the owner is alerted once (`identity_conflict`), and the message goes to the BSUID record. A phone is only FILLED when blank: webhooks are retried for ~36 h and arrive out of order, so a message may carry an OLDER number than the one on file, and following it would point replies at a number that may now belong to someone else; only an explicit `user_changed_number` notice replaces one.
A BSUID that was replaced (`user_id_update`) is recognised from the stored `uidupd:` events (up to 3 renames, no extra table) so a late message from the old id joins the same person instead of creating a phantom contact. `user_id_update` rewrites the BSUID, or merges when a message under the new id raced ahead. Names: owner-saved (app-state sync) > existing > WhatsApp profile; an imported label beats a profile name on merge; a contact removed in the phone app is left alone. We never merge by name.

**D-039 [logged] Echoes (messages the owner sends from the phone).** Stored outbound with provenance `owner_app_echo`, status `sent`. They reset `consecutive_auto_replies`, supersede every open draft (through the draft state machine's `new_inbound`), and never touch the window. An echo that names no recipient (`to`/`to_user_id`/`recipient_*`) is parked with an alert: filing the owner's words in a guessed thread is worse than not filing them.

**D-040 [logged] History import.** Direction = `from` is our own number (`metadata.display_phone_number`). Customer = the thread id (`threads[]`) or the sender/recipient. **An owner-side message in a flat chunk that names no recipient is NOT imported** (counted, alerted `history_unattributed`): the open-source fixtures have exactly that shape, so if real Meta is flat the owner-side import stays empty until a real payload shows how to attribute it. This is the largest unverified assumption in Phase 1.
Provenance: customer messages `customer` (spec said `imported` for all), owner-side `imported` (what style learning reads). Quiet: no drafts, no per-message dashboard events. Reply links are not resolved. Media past Meta's ~14-day window arrives without an id and is shown as "[Image unavailable]", or its caption.

**D-041 [logged] Edits and deletes by the customer.** The target is looked up by `context.id`, then by the message's own id (the exact shape is unconfirmed). A delete blanks the text and transcript but keeps the row (thread order and reply links), sets `deleted_at`, and the media is no longer served: the customer took it back and we do not keep showing it, searching it, or feeding it to a model. An edit replaces the content and sets `edited_at`; drafts written for the old text are superseded. If the target has not been processed yet the job waits (Meta does not guarantee order); on the last attempt an edit is kept as the customer's words and a delete is settled.

**D-042 [logged] Message types.** Every known type has a readable rendering; an unknown type becomes `unsupported` with a safe token (letters/digits/underscore, 32 chars). `order` is stored as `interactive`. `system` notices feed identity and are never stored as messages. Group messages are ignored (spec 16).

### Media and AI

**D-043 [logged] Media.** Only an allowlist of MIME types is stored (no HTML, SVG or executables), the message type must agree with the file's type, the extension comes from the verified MIME (never a filename), the path is `{yyyy}/{mm}/{message-id}.{ext}`, writes are atomic (temp + rename, mode 0640), and the SHA-256 Meta reports is checked (accepted as hex or base64: Meta is inconsistent). We do NOT sniff magic bytes: a mislabelled file is harmless because it is served with the verified type, `nosniff`, `Content-Security-Policy: sandbox`, `no-store`, and documents as attachments. The download URL must be public https (the access token never goes to an internal host); the size cap is enforced while streaming.
A file that will never arrive (gone, unacceptable) settles as unavailable and clears `media_id` (so nothing re-enqueues it and the UI can tell "gone" from "downloading"); a rejected token raises one critical alert per day. `/api/media/[id]` verifies the session itself and refuses (404) deleted messages, bad paths and symlinks that leave the directory.

**D-044 [logged] Voice notes.** Whisper has **no Luganda** and, given speech it does not know, produces fluent nonsense (often labelled Swahili or English). A transcript is trusted only when it is plausible English by language, Whisper's own thresholds (avg_logprob < -1.0, compression_ratio > 2.4, no_speech_prob > 0.6) and phrase-loop detection. **An unreliable transcript's text is discarded**: never stored, shown, or sent to a model; the message tells the owner to listen. Trusted transcripts are always labelled "auto-transcribed". (Phase 7 adds: a machine-transcript trigger always routes to approval.)
The per-segment numbers are read from the provider's raw response body (`responses[0].body`), which the SDK returns at runtime but does not declare in its types: an integration test fails first if that ever stops, and the text heuristics still apply.

**D-045 [logged] AI wrapper (spec 9.1).** `generateText` + `Output.object` (never `generateObject`), `instructions` not `system`, 30 s per call, SDK `maxRetries: 1` (the queue owns the rest, so a stuck provider cannot hold a worker inside one job), one `ai_runs` row per call, ONE corrective retry that names the broken fields but never their values, and a one-time per-model fall back from strict JSON-schema decoding when Groq answers 400. Errors stored and logged are content-free. Model ids come only from the environment. `.env.example` corrected: the Phase 0 file suggested `llama-3.3-70b-versatile` and `llama-3.1-8b-instant`, which Groq retires 2026-08-16; defaults are `openai/gpt-oss-120b` (draft, analysis), `openai/gpt-oss-20b` (verify), `whisper-large-v3`; Graph `v26.0`.

### Dashboard

**D-046 [logged] Realtime.** One Redis subscriber per web process fans out to all SSE streams and RE-VALIDATES every event against the strict schema (a message body cannot ride the stream even if something else publishes one). Cap 20 open streams (503 + Retry-After), heartbeat 25 s, a slow reader is dropped rather than buffered, the session is re-checked every 5 min. The client reconnects manually with jittered backoff (the browser gives up for good on 401/503), refreshes once on every reconnect and when a background tab returns, and debounces bursts (300 ms). Measured in Chromium: ~440 ms from POST to screen.

**D-047 [logged] Lists and search.** Keyset pagination on `(last_message_at, id)` with MICROsecond cursors (a millisecond cursor skips or repeats tied rows). Search: names and usernames (`ILIKE`, wildcards escaped), phone digits (the local form "0700 123" and E.164 both match), and message words with prefix matching through a `simple` tsquery built only from letter/digit runs (no syntax injection). Raw `db.execute` returns timestamps as strings (Drizzle disables the driver's date parsing): every raw timestamp goes through `toDate` and is asserted in tests. Times are formatted in `OWNER_TIMEZONE`. Status, delivery and window are always text as well as colour.

### Verification

**D-048 [logged] What was verified how.** 605 unit and 396 integration tests on real Postgres 16 and Redis 7 (every fixture replayed through the real pipeline, plus a real BullMQ worker end to end); ~55 mutation checks on the guards (window, identity, echo, history, status, NUL, clamp, route auth, symlink containment, hash, MIME, SSRF, size cap, transcript discard, deletion race, SSE auth/validation/cap, pagination, search escaping, deleted-message privacy), all killed except 3 redundant defensive clauses (equivalent mutants: the `direction` clause beside the `provenance` clause of the window, the identity null-guard beside `resolveContact`'s own, the `..` check beside the `relative()` containment check). Weak tests found this way were strengthened.
The production build was driven in Chromium (login, signed webhooks, live updates, media through the authenticated route, security headers, no console errors, no horizontal scroll at 320-1280 px) and **several real defects were found only there** (raw timestamps as strings crashing the pages; a sticky header hidden under the app header on narrow phones; a sidebar that scrolled away; bubbles showing through a translucent header; the newest message hidden under the bottom nav): see the phase report.
One intermittent failure class in the Playwright script (the Settings assertions) was observed twice, right after a server restart, and could not be reproduced with diagnostics on; the script now waits for the page itself. Cause unconfirmed. (A third failure was the script's own test data and is fixed.)

**D-049 [approved] Phase 7 gate (answers D-029).** Autopilot may be enabled only when ALL hold over the last 30 days of approved drafts: median edit distance <= 0.30 AND p75 <= 0.50, at least 200 approved drafts, and the latest eval run (>= 50 samples, <= 30 days old, matching the active prompt, model and style guide) shows 0 invented facts. Autopilot is OFF by default (`autopilot_paused = true`).

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

**D-027 [pending, partly done] Proposed fixes S4-S13** (S4, S6 and S11 landed in Phase 1: see D-032, D-044, D-031) from the plan, each landing in the phase that builds the affected code: S4 webhook body cap via `Content-Length` then a byte-capped stream read (Phase 1); S6 Whisper does not support Luganda (to verify on a real note), so low language confidence/unsupported language ->
`transcription_status='low_confidence'` -> `unreadable_media` (Phase 1); S7 invented-fact detector covers `50k`/`UGX 50,000`/separators/month names, numbers-in-words is a documented blind spot (Phase 3); S8 eval reports p25/p75 and a paired-bootstrap CI and the ship rule uses the CI (Phase 3);
S9 the draft prompt/call land in Phase 3 because the eval needs them; S10 import date-order detection and U+202F/LRM handling (Phase 3); S11 coexistence kinds `smb_app_state_sync` and `account_update` (Phase 1); S13 edit distance = normalized Levenshtein over NFC code points (Phase 2).

**D-028 [pending] Unverified from the sandbox**, to confirm on your machine or when docs are reachable: Meta payload shapes and error-code table, latest Graph version, Groq production model list (`.env.example` candidates are marked VERIFY), Groq strict JSON-schema support per model.

**D-029 [approved, see D-049] Phase 7 gate.** Spec 10.1 gates autopilot on median edit distance <= 0.30 over ~50 samples with 0 invented facts. That is weak evidence (0/50 does not bound the true rate under ~6% at 95% confidence). Proposal for Phase 7: also gate on p75, require >= 200 approved drafts, and show unedited rate. To be asked at the start of Phase 7.

## Phase 1 (2026-10-04): ingest, media, live dashboard

### Process

**D-030 [approved] Phases 1-7 are built continuously.** The owner asked for every remaining phase "without stopping", which overrides the spec's and `CLAUDE.md`'s
"one phase per session, stop and wait" rule. What still binds: gates on real exit codes per commit, a phase report per phase (`docs/phase-reports/`), a push per phase, ask-before-deciding on data model / send path / autopilot / security
(the open items were asked up front: D-032, D-033, D-049). Everything that cannot be run from the build sandbox (Docker, Meta, Groq, Telegram, a real Luganda voice note) accumulates in `docs/ACCEPTANCE.md` for the owner's laptop instead of blocking.

**D-031 [logged] Meta's webhook documentation was unreachable; shapes were reconstructed and are marked unverified.** The three links given (Graph webhooks, sample apps, and a page that is the **Messenger** platform, not WhatsApp) are blocked by the sandbox's egress proxy.
Shapes come from type definitions and fixtures shipped in maintained npm packages (`@whatsapp-cloudapi/types`, `@better-zap/fixtures` Coexistence fixtures, `whatsapp-api-js`, `@great-detail/whatsapp`) plus search summaries.
Every fixture in `test/fixtures/webhooks/index.json` states its confidence (`sdk-types`, `oss-fixture`, `constructed`). Parsing is therefore tolerant (`looseObject`: unknown fields are kept, never rejected) and an unrecognised shape is stored and alerted, never dropped or guessed.
**Biggest residual risks** (each has a defensive path and a test): the echo shape (official `message_echoes[]` with `to` vs the open-source `messages[]` without it), the history shape (flat vs `threads[]`; D-040), and how edits and deletes are expressed (D-041).
Drop 5-6 real payloads from Meta's webhook test tool into `test/fixtures/webhooks/real/` and the contract tests absorb them (`docs/ACCEPTANCE.md` step 4).

### Webhook intake

**D-032 [approved] Body cap 3 MiB (spec: 1 MB).** One POST may batch ~1000 updates. The cap is enforced via `Content-Length` first, then a byte-capped stream read (a lying header cannot exhaust memory). Over the cap: 413, nothing stored.

**D-033 [approved] Schema additions (migration 0003).** `contacts.username` (a username user may have a BSUID and no phone) and `messages.marked_bad_at` (Phase 7 "Mark bad").

**D-034 [logged] Response policy.** Order: size cap -> HMAC-SHA256 over the RAW bytes (`timingSafeEqual`, length-checked, never throws; a re-serialised body fails) -> 401 and NO database write if bad -> JSON (400 if not) -> envelope.
A signed payload for another `object` is ignored with 200. A signed payload with the right `object` but an unparseable shape is stored as an `other` event, alerted, and answered **200**: a 4xx would make Meta retry it for ~36 h for nothing.
Any database or Redis failure answers 500 so Meta retries. Items for a different `phone_number_id` are not ours: settled and ignored. NUL (U+0000) is stripped before storage: Postgres cannot store it, and one such message would otherwise put Meta in a retry loop that also blocks the rest of its batch.

**D-035 [logged] Dedupe keys and the sweeper.** `msg:{wamid}[:edited|:revoked]`, `status:{id}:{status}`, `echo:{id}[...]`, `history:{request}:{phase}:{sha256(chunk)}`, `uidupd:{previous}:{current}`, and for events with no natural id (account state, app-state sync, preferences) a hash of the payload **plus the entry's `time`**:
Meta retries resend the same entry (same time) so replays still collapse, but a state that legitimately recurs (quality GREEN -> YELLOW -> GREEN -> YELLOW; a contact renamed back to its old name) is processed again. The sweeper (every 5 min) re-enqueues events unprocessed after 2 min, removes a failed/completed job first (BullMQ ignores an add for an existing id), counts an attempt only on a real re-enqueue, and alerts once at 10.

### Processing

**D-036 [logged] Persist, then process.** `process-webhook-event` validates the stored item, runs the handler in ONE transaction, runs side effects (enqueue, dashboard event, alert) AFTER commit, and stamps `processed_at` LAST. Handlers are idempotent (`messages.wamid` UNIQUE, conditional state machines), so a crash anywhere is repaired by retry or the sweeper.
An effect that must not be lost (a media download) is re-derived from database state on replay; dashboard events are best-effort (the dashboard also refreshes on reconnect). A status for a message we do not hold yet retries with backoff (5 attempts, ~30 s) and then settles with a note and NO alert (statuses for messages sent before we connected are normal). Concurrent webhooks for one customer are serialised with advisory locks.

**D-037 [logged] The 24h window has exactly one definition** (`refreshConversationAggregates`): the latest LIVE customer message (inbound, provenance `customer`, not a reaction) + 24 h. Echoes, reactions, imports and history can never open or extend it, and history cannot move it backward. A message timestamp more than 5 minutes in the future is clamped to now: a wrong clock must not extend the right to send free text.
Reactions and system notices never change the window, the status or the list order. Status: a customer message -> `waiting_on_me`; an echo -> `waiting_on_customer`; history leaves an existing status alone (new history conversations are created `resolved`).

**D-038 [logged] Identity.** BSUID first, then phone. Two records are merged only when nothing contradicts that they are one person; otherwise they are kept apart, the owner is alerted once (`identity_conflict`), and the message goes to the BSUID record. A phone is only FILLED when blank: webhooks are retried for ~36 h and arrive out of order, so a message may carry an OLDER number than the one on file, and following it would point replies at a number that may now belong to someone else; only an explicit `user_changed_number` notice replaces one.
A BSUID that was replaced (`user_id_update`) is recognised from the stored `uidupd:` events (up to 3 renames, no extra table) so a late message from the old id joins the same person instead of creating a phantom contact. `user_id_update` rewrites the BSUID, or merges when a message under the new id raced ahead. Names: owner-saved (app-state sync) > existing > WhatsApp profile; an imported label beats a profile name on merge; a contact removed in the phone app is left alone. We never merge by name.

**D-039 [logged] Echoes (messages the owner sends from the phone).** Stored outbound with provenance `owner_app_echo`, status `sent`. They reset `consecutive_auto_replies`, supersede every open draft (through the draft state machine's `new_inbound`), and never touch the window. An echo that names no recipient (`to`/`to_user_id`/`recipient_*`) is parked with an alert: filing the owner's words in a guessed thread is worse than not filing them.

**D-040 [logged] History import.** Direction = `from` is our own number (`metadata.display_phone_number`). Customer = the thread id (`threads[]`) or the sender/recipient. **An owner-side message in a flat chunk that names no recipient is NOT imported** (counted, alerted `history_unattributed`): the open-source fixtures have exactly that shape, so if real Meta is flat the owner-side import stays empty until a real payload shows how to attribute it. This is the largest unverified assumption in Phase 1.
Provenance: customer messages `customer` (spec said `imported` for all), owner-side `imported` (what style learning reads). Quiet: no drafts, no per-message dashboard events. Reply links are not resolved. Media past Meta's ~14-day window arrives without an id and is shown as "[Image unavailable]", or its caption.

**D-041 [logged] Edits and deletes by the customer.** The target is looked up by `context.id`, then by the message's own id (the exact shape is unconfirmed). A delete blanks the text and transcript but keeps the row (thread order and reply links), sets `deleted_at`, and the media is no longer served: the customer took it back and we do not keep showing it, searching it, or feeding it to a model. An edit replaces the content and sets `edited_at`; drafts written for the old text are superseded. If the target has not been processed yet the job waits (Meta does not guarantee order); on the last attempt an edit is kept as the customer's words and a delete is settled.

**D-042 [logged] Message types.** Every known type has a readable rendering; an unknown type becomes `unsupported` with a safe token (letters/digits/underscore, 32 chars). `order` is stored as `interactive`. `system` notices feed identity and are never stored as messages. Group messages are ignored (spec 16).

### Media and AI

**D-043 [logged] Media.** Only an allowlist of MIME types is stored (no HTML, SVG or executables), the message type must agree with the file's type, the extension comes from the verified MIME (never a filename), the path is `{yyyy}/{mm}/{message-id}.{ext}`, writes are atomic (temp + rename, mode 0640), and the SHA-256 Meta reports is checked (accepted as hex or base64: Meta is inconsistent). We do NOT sniff magic bytes: a mislabelled file is harmless because it is served with the verified type, `nosniff`, `Content-Security-Policy: sandbox`, `no-store`, and documents as attachments. The download URL must be public https (the access token never goes to an internal host); the size cap is enforced while streaming.
A file that will never arrive (gone, unacceptable) settles as unavailable and clears `media_id` (so nothing re-enqueues it and the UI can tell "gone" from "downloading"); a rejected token raises one critical alert per day. `/api/media/[id]` verifies the session itself and refuses (404) deleted messages, bad paths and symlinks that leave the directory.

**D-044 [logged] Voice notes.** Whisper has **no Luganda** and, given speech it does not know, produces fluent nonsense (often labelled Swahili or English). A transcript is trusted only when it is plausible English by language, Whisper's own thresholds (avg_logprob < -1.0, compression_ratio > 2.4, no_speech_prob > 0.6) and phrase-loop detection. **An unreliable transcript's text is discarded**: never stored, shown, or sent to a model; the message tells the owner to listen. Trusted transcripts are always labelled "auto-transcribed". (Phase 7 adds: a machine-transcript trigger always routes to approval.)
The per-segment numbers are read from the provider's raw response body (`responses[0].body`), which the SDK returns at runtime but does not declare in its types: an integration test fails first if that ever stops, and the text heuristics still apply.

**D-045 [logged] AI wrapper (spec 9.1).** `generateText` + `Output.object` (never `generateObject`), `instructions` not `system`, 30 s per call, SDK `maxRetries: 1` (the queue owns the rest, so a stuck provider cannot hold a worker inside one job), one `ai_runs` row per call, ONE corrective retry that names the broken fields but never their values, and a one-time per-model fall back from strict JSON-schema decoding when Groq answers 400. Errors stored and logged are content-free. Model ids come only from the environment. `.env.example` corrected: the Phase 0 file suggested `llama-3.3-70b-versatile` and `llama-3.1-8b-instant`, which Groq retires 2026-08-16; defaults are `openai/gpt-oss-120b` (draft, analysis), `openai/gpt-oss-20b` (verify), `whisper-large-v3`; Graph `v26.0`.

### Dashboard

**D-046 [logged] Realtime.** One Redis subscriber per web process fans out to all SSE streams and RE-VALIDATES every event against the strict schema (a message body cannot ride the stream even if something else publishes one). Cap 20 open streams (503 + Retry-After), heartbeat 25 s, a slow reader is dropped rather than buffered, the session is re-checked every 5 min. The client reconnects manually with jittered backoff (the browser gives up for good on 401/503), refreshes once on every reconnect and when a background tab returns, and debounces bursts (300 ms). Measured in Chromium: ~440 ms from POST to screen.

**D-047 [logged] Lists and search.** Keyset pagination on `(last_message_at, id)` with MICROsecond cursors (a millisecond cursor skips or repeats tied rows). Search: names and usernames (`ILIKE`, wildcards escaped), phone digits (the local form "0700 123" and E.164 both match), and message words with prefix matching through a `simple` tsquery built only from letter/digit runs (no syntax injection). Raw `db.execute` returns timestamps as strings (Drizzle disables the driver's date parsing): every raw timestamp goes through `toDate` and is asserted in tests. Times are formatted in `OWNER_TIMEZONE`. Status, delivery and window are always text as well as colour.

### Verification

**D-048 [logged] What was verified how.** 605 unit and 396 integration tests on real Postgres 16 and Redis 7 (every fixture replayed through the real pipeline, plus a real BullMQ worker end to end); ~55 mutation checks on the guards (window, identity, echo, history, status, NUL, clamp, route auth, symlink containment, hash, MIME, SSRF, size cap, transcript discard, deletion race, SSE auth/validation/cap, pagination, search escaping, deleted-message privacy), all killed except 3 redundant defensive clauses (equivalent mutants: the `direction` clause beside the `provenance` clause of the window, the identity null-guard beside `resolveContact`'s own, the `..` check beside the `relative()` containment check). Weak tests found this way were strengthened.
The production build was driven in Chromium (login, signed webhooks, live updates, media through the authenticated route, security headers, no console errors, no horizontal scroll at 320-1280 px) and **several real defects were found only there** (raw timestamps as strings crashing the pages; a sticky header hidden under the app header on narrow phones; a sidebar that scrolled away; bubbles showing through a translucent header; the newest message hidden under the bottom nav): see the phase report.
One intermittent failure class in the Playwright script (the Settings assertions) was observed twice, right after a server restart, and could not be reproduced with diagnostics on; the script now waits for the page itself. Cause unconfirmed. (A third failure was the script's own test data and is fixed.)

**D-049 [approved] Phase 7 gate (answers D-029).** Autopilot may be enabled only when ALL hold over the last 30 days of approved drafts: median edit distance <= 0.30 AND p75 <= 0.50, at least 200 approved drafts, and the latest eval run (>= 50 samples, <= 30 days old, matching the active prompt, model and style guide) shows 0 invented facts. Autopilot is OFF by default (`autopilot_paused = true`).


## Phase 2 (2026-10-05)

### The send path

**D-050 [logged] One send path, two halves (builds on the approved D-008).** `queueMessage` runs INSIDE the caller's transaction: lock the conversation (`FOR UPDATE`), return the existing message for a repeated idempotency key, read `sending_paused` and the window, run the pure `precheck()`, insert the row as `queued`, and (for a draft) claim the draft with a conditional UPDATE in the same transaction, then refresh the aggregates and supersede the other open drafts. A refused check THROWS, so everything rolls back and the draft stays `pending`. The job is enqueued only AFTER commit (`afterCommit` hook on `ownerAction`: it never runs on a rollback, and its failure does not fail an action whose change is already committed; `alerts-scan` re-enqueues a lost job). `performSend` (the worker) is two short transactions around the HTTP call: (1) lock the message, re-run the pre-check (the kill switch and the window can change while the job waits), and stamp `send_started_at` atomically; (2) record the outcome through the message state machine. Effects (dashboard events, alerts) leave the transaction as data and run after commit. A static test fails if any other file imports `whatsapp/send-api.ts`, builds a Graph `/messages` URL, or queues an outbound row.

**D-051 [logged] Failure classes.** A failure is retried ONLY when Meta definitively did not send: throttling codes, a 5xx that carries a Meta error body, a connection that was never made (refused, DNS, TLS handshake). A timeout, a connection reset after the write, a 2xx we cannot read, and a 5xx WITHOUT a Meta body are `ambiguous` -> `unknown`, never retried (the Cloud API has no idempotency key, so a retry of an ambiguous failure is a duplicate message to a customer). A retry clears the stamp and COMMITS that before throwing for BullMQ (throwing inside the transaction would roll the clear back). An error code the table does not know is permanent and shown raw. The table (`whatsapp/errors.ts`) is written from SDK knowledge and secondary documentation, NOT Meta's reference: **verify it against real errors** (listed in `docs/ACCEPTANCE.md`). Retries are capped by the queue (3 attempts, 5 s exponential); on the last one a retryable failure becomes a visible `failed`.

**D-052 [logged] `unknown` is the owner's call.** The message shows "We could not confirm this was sent. Check your phone" with two actions: "It arrived" (`unknown -> sent`) and "It did not arrive: send again" (the original closes as `failed`, one NEW queued message with the same text, key `resend:{original id}` so it cannot be created twice, through the normal pre-check: a closed window refuses it and the original stays `unknown`). Text only: a template's values are not stored on the row. A late "accepted" answer for a message `alerts-scan` had already parked as `unknown` makes it `sent`. A status webhook that beats our write of the wamid is matched through `biz_opaque_callback_data` (our message id) and the status never moves backward.

**D-053 [logged] Idempotency keys come from the client**, one per composed message and reused on retry (a double click, a slow network or a re-submitted form is one message); the allowed characters exclude `:` so a client can never forge a `resend:` key. Template components travel in the job data (no schema change). If the job is lost for a template, the message fails visibly (`template_job_lost`) rather than being sent with guessed values.

**D-054 [logged] Recipient.** `to` (phone digits) when the contact has a phone, else `recipient` (BSUID), never both. **The BSUID `recipient` field is unverified against Meta**; a BSUID-only customer is the first thing to test with a real account.

### Templates

**D-055 [logged] Templates (v1 subset).** Listed from the WABA, cached in Redis (refetched after 5 min, kept 1 h and served stale with a notice if Meta is down). An APPROVED template with a text body (positional `{{1}}` or named values), an optional text footer, a header without values and quick-reply / phone / static-link buttons is usable; everything else (media headers, buttons with values, carousels, limited-time offers, authentication, anything not APPROVED) is listed disabled with the reason. The send action reads only the cache (never the network inside a database transaction) and re-checks the owner's values against the template: nothing is guessed. Value rules (no line breaks or tabs, no runs of 4+ spaces, 1,024 characters) follow Meta's template error 132018 and are **unverified**.

### Notifications and safety nets

**D-056 [logged] Telegram is send-only in this phase** (the inbound bot for Cancel / Send now arrives with the autopilot). Plain text only (no `parse_mode`), never a message body, bot token only in the request URL and never logged or returned, a short `retry_after` is waited out once and a long one is not, and no failure ever throws into the caller. Alerts reach it through the alert sink registered in the worker: `info` alerts are dashboard-only, quiet hours (owner's time zone, default 22:00-07:00) silence everything except critical alerts, the owner's `notify_telegram` switch silences all of it, and an unreadable quiet-hours setting means "not quiet". The throttle / digest rules for draft notifications belong to Phase 4, where those notifications exist.

**D-057 [logged] Scheduled jobs.** `alerts-scan` every 5 min: a message stamped but unanswered for 3 min becomes `unknown` + alert (`SKIP LOCKED`, so a worker finishing its send is left alone); queued and never stamped for 5 min is re-enqueued (a failed job is removed first, BullMQ ignores a re-add of an existing id); a template whose job is gone fails; a customer still waiting whose window closes within 2 h gets ONE alert per window (the dedupe key carries the expiry). `token-health` daily 06:10 (and "Check now" in Settings): a rejected token is the one critical alert, an outage on either side is a quiet warning. `purge-payloads` daily 03:30: nulls the payload of PROCESSED events older than 30 days and keeps the row (dedupe); an unprocessed event keeps its payload however old (the sweeper needs it).

### Dashboard

**D-058 [logged] Composer and countdown.** The composer mirrors the rules (window, placeholder, length, paused) only so the owner learns WHY before typing; the server decides, again, in a transaction. The window badge ticks client-side from one shared 10-second clock (a thread left open for hours must not keep promising "23h left"), and when the window closes mid-typing the box is replaced by the template picker without a reload and the typed text is kept. The reply box is `sticky` above the phone tab bar, pinned to the bottom even on a short thread, capped at 55% of the screen (a tall template form scrolls inside itself), with a negative bottom margin that cancels the page's tab-bar padding so it sits in the same place stuck or scrolled. Status-webhook failures use the same readable wording as send-time failures; our own internal reasons (`resent`, `template_job_lost`) are never shown as "code".

**D-059 [logged] What was verified how (Phase 2).** 725 unit and 522 integration tests (real Postgres 16 and Redis 7; Meta Graph and Telegram mocked at the fetch layer). Mutation checks: 33 mutants over the send core (crash-after-accept, stamp, retry/ambiguous classes, pre-check at queue AND at send time, draft claim, double approval, idempotency, state machine, resend/mark-sent) and 24 over the scans, purge, token check and Telegram sink (plus 3 over the `afterCommit` / refusal hooks). Everything was killed except guards that are layered on purpose and only killable in combination (message lock + conditional stamp; conversation lock + draft lock + conditional draft claim; idempotency pre-check + insert conflict; the candidate query + the locked re-check in `alerts-scan`): each pair was killed once removed together. The sink's outer `catch` (a DB error while reading settings) is defensive and has no test. The production build was driven in Chromium against a fake Meta/Telegram (a `--require` preload in the scratchpad, not in the repository): 53 checks (send, double click, Ctrl+Enter, timeout -> unknown -> "it arrived" / "send again", Meta refusal, throttle retry, the window closing live, templates, kill switch, Telegram test, token check, geometry at 320/390/1280 px, no console errors). **Found only in the browser**: the countdown showed "24h left" for a message that arrived 5 s ago (a floor-quantised clock ran behind real time and over-promised), the reply box hid the newest message, floated mid-screen on a short thread and left a gap above the tab bar, a tall template form covered the thread, internal reasons appeared as "(code resent)". **Not verified: anything against the real Meta, Telegram or WhatsApp.**
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

**D-027 [pending, partly done] Proposed fixes S4-S13** (S4, S6 and S11 landed in Phase 1: see D-032, D-044, D-031) from the plan, each landing in the phase that builds the affected code: S4 webhook body cap via `Content-Length` then a byte-capped stream read (Phase 1); S6 Whisper does not support Luganda (to verify on a real note), so low language confidence/unsupported language ->
`transcription_status='low_confidence'` -> `unreadable_media` (Phase 1); S7 invented-fact detector covers `50k`/`UGX 50,000`/separators/month names, numbers-in-words is a documented blind spot (Phase 3); S8 eval reports p25/p75 and a paired-bootstrap CI and the ship rule uses the CI (Phase 3);
S9 the draft prompt/call land in Phase 3 because the eval needs them; S10 import date-order detection and U+202F/LRM handling (Phase 3); S11 coexistence kinds `smb_app_state_sync` and `account_update` (Phase 1); S13 edit distance = normalized Levenshtein over NFC code points (Phase 2).

**D-028 [pending] Unverified from the sandbox**, to confirm on your machine or when docs are reachable: Meta payload shapes and error-code table, latest Graph version, Groq production model list (`.env.example` candidates are marked VERIFY), Groq strict JSON-schema support per model.

**D-029 [approved, see D-049] Phase 7 gate.** Spec 10.1 gates autopilot on median edit distance <= 0.30 over ~50 samples with 0 invented facts. That is weak evidence (0/50 does not bound the true rate under ~6% at 95% confidence). Proposal for Phase 7: also gate on p75, require >= 200 approved drafts, and show unedited rate. To be asked at the start of Phase 7.

## Phase 1 (2026-10-04): ingest, media, live dashboard

### Process

**D-030 [approved] Phases 1-7 are built continuously.** The owner asked for every remaining phase "without stopping", which overrides the spec's and `CLAUDE.md`'s
"one phase per session, stop and wait" rule. What still binds: gates on real exit codes per commit, a phase report per phase (`docs/phase-reports/`), a push per phase, ask-before-deciding on data model / send path / autopilot / security
(the open items were asked up front: D-032, D-033, D-049). Everything that cannot be run from the build sandbox (Docker, Meta, Groq, Telegram, a real Luganda voice note) accumulates in `docs/ACCEPTANCE.md` for the owner's laptop instead of blocking.

**D-031 [logged] Meta's webhook documentation was unreachable; shapes were reconstructed and are marked unverified.** The three links given (Graph webhooks, sample apps, and a page that is the **Messenger** platform, not WhatsApp) are blocked by the sandbox's egress proxy.
Shapes come from type definitions and fixtures shipped in maintained npm packages (`@whatsapp-cloudapi/types`, `@better-zap/fixtures` Coexistence fixtures, `whatsapp-api-js`, `@great-detail/whatsapp`) plus search summaries.
Every fixture in `test/fixtures/webhooks/index.json` states its confidence (`sdk-types`, `oss-fixture`, `constructed`). Parsing is therefore tolerant (`looseObject`: unknown fields are kept, never rejected) and an unrecognised shape is stored and alerted, never dropped or guessed.
**Biggest residual risks** (each has a defensive path and a test): the echo shape (official `message_echoes[]` with `to` vs the open-source `messages[]` without it), the history shape (flat vs `threads[]`; D-040), and how edits and deletes are expressed (D-041).
Drop 5-6 real payloads from Meta's webhook test tool into `test/fixtures/webhooks/real/` and the contract tests absorb them (`docs/ACCEPTANCE.md` step 4).

### Webhook intake

**D-032 [approved] Body cap 3 MiB (spec: 1 MB).** One POST may batch ~1000 updates. The cap is enforced via `Content-Length` first, then a byte-capped stream read (a lying header cannot exhaust memory). Over the cap: 413, nothing stored.

**D-033 [approved] Schema additions (migration 0003).** `contacts.username` (a username user may have a BSUID and no phone) and `messages.marked_bad_at` (Phase 7 "Mark bad").

**D-034 [logged] Response policy.** Order: size cap -> HMAC-SHA256 over the RAW bytes (`timingSafeEqual`, length-checked, never throws; a re-serialised body fails) -> 401 and NO database write if bad -> JSON (400 if not) -> envelope.
A signed payload for another `object` is ignored with 200. A signed payload with the right `object` but an unparseable shape is stored as an `other` event, alerted, and answered **200**: a 4xx would make Meta retry it for ~36 h for nothing.
Any database or Redis failure answers 500 so Meta retries. Items for a different `phone_number_id` are not ours: settled and ignored. NUL (U+0000) is stripped before storage: Postgres cannot store it, and one such message would otherwise put Meta in a retry loop that also blocks the rest of its batch.

**D-035 [logged] Dedupe keys and the sweeper.** `msg:{wamid}[:edited|:revoked]`, `status:{id}:{status}`, `echo:{id}[...]`, `history:{request}:{phase}:{sha256(chunk)}`, `uidupd:{previous}:{current}`, and for events with no natural id (account state, app-state sync, preferences) a hash of the payload **plus the entry's `time`**:
Meta retries resend the same entry (same time) so replays still collapse, but a state that legitimately recurs (quality GREEN -> YELLOW -> GREEN -> YELLOW; a contact renamed back to its old name) is processed again. The sweeper (every 5 min) re-enqueues events unprocessed after 2 min, removes a failed/completed job first (BullMQ ignores an add for an existing id), counts an attempt only on a real re-enqueue, and alerts once at 10.

### Processing

**D-036 [logged] Persist, then process.** `process-webhook-event` validates the stored item, runs the handler in ONE transaction, runs side effects (enqueue, dashboard event, alert) AFTER commit, and stamps `processed_at` LAST. Handlers are idempotent (`messages.wamid` UNIQUE, conditional state machines), so a crash anywhere is repaired by retry or the sweeper.
An effect that must not be lost (a media download) is re-derived from database state on replay; dashboard events are best-effort (the dashboard also refreshes on reconnect). A status for a message we do not hold yet retries with backoff (5 attempts, ~30 s) and then settles with a note and NO alert (statuses for messages sent before we connected are normal). Concurrent webhooks for one customer are serialised with advisory locks.

**D-037 [logged] The 24h window has exactly one definition** (`refreshConversationAggregates`): the latest LIVE customer message (inbound, provenance `customer`, not a reaction) + 24 h. Echoes, reactions, imports and history can never open or extend it, and history cannot move it backward. A message timestamp more than 5 minutes in the future is clamped to now: a wrong clock must not extend the right to send free text.
Reactions and system notices never change the window, the status or the list order. Status: a customer message -> `waiting_on_me`; an echo -> `waiting_on_customer`; history leaves an existing status alone (new history conversations are created `resolved`).

**D-038 [logged] Identity.** BSUID first, then phone. Two records are merged only when nothing contradicts that they are one person; otherwise they are kept apart, the owner is alerted once (`identity_conflict`), and the message goes to the BSUID record. A phone is only FILLED when blank: webhooks are retried for ~36 h and arrive out of order, so a message may carry an OLDER number than the one on file, and following it would point replies at a number that may now belong to someone else; only an explicit `user_changed_number` notice replaces one.
A BSUID that was replaced (`user_id_update`) is recognised from the stored `uidupd:` events (up to 3 renames, no extra table) so a late message from the old id joins the same person instead of creating a phantom contact. `user_id_update` rewrites the BSUID, or merges when a message under the new id raced ahead. Names: owner-saved (app-state sync) > existing > WhatsApp profile; an imported label beats a profile name on merge; a contact removed in the phone app is left alone. We never merge by name.

**D-039 [logged] Echoes (messages the owner sends from the phone).** Stored outbound with provenance `owner_app_echo`, status `sent`. They reset `consecutive_auto_replies`, supersede every open draft (through the draft state machine's `new_inbound`), and never touch the window. An echo that names no recipient (`to`/`to_user_id`/`recipient_*`) is parked with an alert: filing the owner's words in a guessed thread is worse than not filing them.

**D-040 [logged] History import.** Direction = `from` is our own number (`metadata.display_phone_number`). Customer = the thread id (`threads[]`) or the sender/recipient. **An owner-side message in a flat chunk that names no recipient is NOT imported** (counted, alerted `history_unattributed`): the open-source fixtures have exactly that shape, so if real Meta is flat the owner-side import stays empty until a real payload shows how to attribute it. This is the largest unverified assumption in Phase 1.
Provenance: customer messages `customer` (spec said `imported` for all), owner-side `imported` (what style learning reads). Quiet: no drafts, no per-message dashboard events. Reply links are not resolved. Media past Meta's ~14-day window arrives without an id and is shown as "[Image unavailable]", or its caption.

**D-041 [logged] Edits and deletes by the customer.** The target is looked up by `context.id`, then by the message's own id (the exact shape is unconfirmed). A delete blanks the text and transcript but keeps the row (thread order and reply links), sets `deleted_at`, and the media is no longer served: the customer took it back and we do not keep showing it, searching it, or feeding it to a model. An edit replaces the content and sets `edited_at`; drafts written for the old text are superseded. If the target has not been processed yet the job waits (Meta does not guarantee order); on the last attempt an edit is kept as the customer's words and a delete is settled.

**D-042 [logged] Message types.** Every known type has a readable rendering; an unknown type becomes `unsupported` with a safe token (letters/digits/underscore, 32 chars). `order` is stored as `interactive`. `system` notices feed identity and are never stored as messages. Group messages are ignored (spec 16).

### Media and AI

**D-043 [logged] Media.** Only an allowlist of MIME types is stored (no HTML, SVG or executables), the message type must agree with the file's type, the extension comes from the verified MIME (never a filename), the path is `{yyyy}/{mm}/{message-id}.{ext}`, writes are atomic (temp + rename, mode 0640), and the SHA-256 Meta reports is checked (accepted as hex or base64: Meta is inconsistent). We do NOT sniff magic bytes: a mislabelled file is harmless because it is served with the verified type, `nosniff`, `Content-Security-Policy: sandbox`, `no-store`, and documents as attachments. The download URL must be public https (the access token never goes to an internal host); the size cap is enforced while streaming.
A file that will never arrive (gone, unacceptable) settles as unavailable and clears `media_id` (so nothing re-enqueues it and the UI can tell "gone" from "downloading"); a rejected token raises one critical alert per day. `/api/media/[id]` verifies the session itself and refuses (404) deleted messages, bad paths and symlinks that leave the directory.

**D-044 [logged] Voice notes.** Whisper has **no Luganda** and, given speech it does not know, produces fluent nonsense (often labelled Swahili or English). A transcript is trusted only when it is plausible English by language, Whisper's own thresholds (avg_logprob < -1.0, compression_ratio > 2.4, no_speech_prob > 0.6) and phrase-loop detection. **An unreliable transcript's text is discarded**: never stored, shown, or sent to a model; the message tells the owner to listen. Trusted transcripts are always labelled "auto-transcribed". (Phase 7 adds: a machine-transcript trigger always routes to approval.)
The per-segment numbers are read from the provider's raw response body (`responses[0].body`), which the SDK returns at runtime but does not declare in its types: an integration test fails first if that ever stops, and the text heuristics still apply.

**D-045 [logged] AI wrapper (spec 9.1).** `generateText` + `Output.object` (never `generateObject`), `instructions` not `system`, 30 s per call, SDK `maxRetries: 1` (the queue owns the rest, so a stuck provider cannot hold a worker inside one job), one `ai_runs` row per call, ONE corrective retry that names the broken fields but never their values, and a one-time per-model fall back from strict JSON-schema decoding when Groq answers 400. Errors stored and logged are content-free. Model ids come only from the environment. `.env.example` corrected: the Phase 0 file suggested `llama-3.3-70b-versatile` and `llama-3.1-8b-instant`, which Groq retires 2026-08-16; defaults are `openai/gpt-oss-120b` (draft, analysis), `openai/gpt-oss-20b` (verify), `whisper-large-v3`; Graph `v26.0`.

### Dashboard

**D-046 [logged] Realtime.** One Redis subscriber per web process fans out to all SSE streams and RE-VALIDATES every event against the strict schema (a message body cannot ride the stream even if something else publishes one). Cap 20 open streams (503 + Retry-After), heartbeat 25 s, a slow reader is dropped rather than buffered, the session is re-checked every 5 min. The client reconnects manually with jittered backoff (the browser gives up for good on 401/503), refreshes once on every reconnect and when a background tab returns, and debounces bursts (300 ms). Measured in Chromium: ~440 ms from POST to screen.

**D-047 [logged] Lists and search.** Keyset pagination on `(last_message_at, id)` with MICROsecond cursors (a millisecond cursor skips or repeats tied rows). Search: names and usernames (`ILIKE`, wildcards escaped), phone digits (the local form "0700 123" and E.164 both match), and message words with prefix matching through a `simple` tsquery built only from letter/digit runs (no syntax injection). Raw `db.execute` returns timestamps as strings (Drizzle disables the driver's date parsing): every raw timestamp goes through `toDate` and is asserted in tests. Times are formatted in `OWNER_TIMEZONE`. Status, delivery and window are always text as well as colour.

### Verification

**D-048 [logged] What was verified how.** 605 unit and 396 integration tests on real Postgres 16 and Redis 7 (every fixture replayed through the real pipeline, plus a real BullMQ worker end to end); ~55 mutation checks on the guards (window, identity, echo, history, status, NUL, clamp, route auth, symlink containment, hash, MIME, SSRF, size cap, transcript discard, deletion race, SSE auth/validation/cap, pagination, search escaping, deleted-message privacy), all killed except 3 redundant defensive clauses (equivalent mutants: the `direction` clause beside the `provenance` clause of the window, the identity null-guard beside `resolveContact`'s own, the `..` check beside the `relative()` containment check). Weak tests found this way were strengthened.
The production build was driven in Chromium (login, signed webhooks, live updates, media through the authenticated route, security headers, no console errors, no horizontal scroll at 320-1280 px) and **several real defects were found only there** (raw timestamps as strings crashing the pages; a sticky header hidden under the app header on narrow phones; a sidebar that scrolled away; bubbles showing through a translucent header; the newest message hidden under the bottom nav): see the phase report.
One intermittent failure class in the Playwright script (the Settings assertions) was observed twice, right after a server restart, and could not be reproduced with diagnostics on; the script now waits for the page itself. Cause unconfirmed. (A third failure was the script's own test data and is fixed.)

**D-049 [approved] Phase 7 gate (answers D-029).** Autopilot may be enabled only when ALL hold over the last 30 days of approved drafts: median edit distance <= 0.30 AND p75 <= 0.50, at least 200 approved drafts, and the latest eval run (>= 50 samples, <= 30 days old, matching the active prompt, model and style guide) shows 0 invented facts. Autopilot is OFF by default (`autopilot_paused = true`).

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

**D-027 [pending, partly done] Proposed fixes S4-S13** (S4, S6 and S11 landed in Phase 1: see D-032, D-044, D-031) from the plan, each landing in the phase that builds the affected code: S4 webhook body cap via `Content-Length` then a byte-capped stream read (Phase 1); S6 Whisper does not support Luganda (to verify on a real note), so low language confidence/unsupported language ->
`transcription_status='low_confidence'` -> `unreadable_media` (Phase 1); S7 invented-fact detector covers `50k`/`UGX 50,000`/separators/month names, numbers-in-words is a documented blind spot (Phase 3); S8 eval reports p25/p75 and a paired-bootstrap CI and the ship rule uses the CI (Phase 3);
S9 the draft prompt/call land in Phase 3 because the eval needs them; S10 import date-order detection and U+202F/LRM handling (Phase 3); S11 coexistence kinds `smb_app_state_sync` and `account_update` (Phase 1); S13 edit distance = normalized Levenshtein over NFC code points (Phase 2).

**D-028 [pending] Unverified from the sandbox**, to confirm on your machine or when docs are reachable: Meta payload shapes and error-code table, latest Graph version, Groq production model list (`.env.example` candidates are marked VERIFY), Groq strict JSON-schema support per model.

**D-029 [approved, see D-049] Phase 7 gate.** Spec 10.1 gates autopilot on median edit distance <= 0.30 over ~50 samples with 0 invented facts. That is weak evidence (0/50 does not bound the true rate under ~6% at 95% confidence). Proposal for Phase 7: also gate on p75, require >= 200 approved drafts, and show unedited rate. To be asked at the start of Phase 7.

## Phase 1 (2026-10-04): ingest, media, live dashboard

### Process

**D-030 [approved] Phases 1-7 are built continuously.** The owner asked for every remaining phase "without stopping", which overrides the spec's and `CLAUDE.md`'s
"one phase per session, stop and wait" rule. What still binds: gates on real exit codes per commit, a phase report per phase (`docs/phase-reports/`), a push per phase, ask-before-deciding on data model / send path / autopilot / security
(the open items were asked up front: D-032, D-033, D-049). Everything that cannot be run from the build sandbox (Docker, Meta, Groq, Telegram, a real Luganda voice note) accumulates in `docs/ACCEPTANCE.md` for the owner's laptop instead of blocking.

**D-031 [logged] Meta's webhook documentation was unreachable; shapes were reconstructed and are marked unverified.** The three links given (Graph webhooks, sample apps, and a page that is the **Messenger** platform, not WhatsApp) are blocked by the sandbox's egress proxy.
Shapes come from type definitions and fixtures shipped in maintained npm packages (`@whatsapp-cloudapi/types`, `@better-zap/fixtures` Coexistence fixtures, `whatsapp-api-js`, `@great-detail/whatsapp`) plus search summaries.
Every fixture in `test/fixtures/webhooks/index.json` states its confidence (`sdk-types`, `oss-fixture`, `constructed`). Parsing is therefore tolerant (`looseObject`: unknown fields are kept, never rejected) and an unrecognised shape is stored and alerted, never dropped or guessed.
**Biggest residual risks** (each has a defensive path and a test): the echo shape (official `message_echoes[]` with `to` vs the open-source `messages[]` without it), the history shape (flat vs `threads[]`; D-040), and how edits and deletes are expressed (D-041).
Drop 5-6 real payloads from Meta's webhook test tool into `test/fixtures/webhooks/real/` and the contract tests absorb them (`docs/ACCEPTANCE.md` step 4).

### Webhook intake

**D-032 [approved] Body cap 3 MiB (spec: 1 MB).** One POST may batch ~1000 updates. The cap is enforced via `Content-Length` first, then a byte-capped stream read (a lying header cannot exhaust memory). Over the cap: 413, nothing stored.

**D-033 [approved] Schema additions (migration 0003).** `contacts.username` (a username user may have a BSUID and no phone) and `messages.marked_bad_at` (Phase 7 "Mark bad").

**D-034 [logged] Response policy.** Order: size cap -> HMAC-SHA256 over the RAW bytes (`timingSafeEqual`, length-checked, never throws; a re-serialised body fails) -> 401 and NO database write if bad -> JSON (400 if not) -> envelope.
A signed payload for another `object` is ignored with 200. A signed payload with the right `object` but an unparseable shape is stored as an `other` event, alerted, and answered **200**: a 4xx would make Meta retry it for ~36 h for nothing.
Any database or Redis failure answers 500 so Meta retries. Items for a different `phone_number_id` are not ours: settled and ignored. NUL (U+0000) is stripped before storage: Postgres cannot store it, and one such message would otherwise put Meta in a retry loop that also blocks the rest of its batch.

**D-035 [logged] Dedupe keys and the sweeper.** `msg:{wamid}[:edited|:revoked]`, `status:{id}:{status}`, `echo:{id}[...]`, `history:{request}:{phase}:{sha256(chunk)}`, `uidupd:{previous}:{current}`, and for events with no natural id (account state, app-state sync, preferences) a hash of the payload **plus the entry's `time`**:
Meta retries resend the same entry (same time) so replays still collapse, but a state that legitimately recurs (quality GREEN -> YELLOW -> GREEN -> YELLOW; a contact renamed back to its old name) is processed again. The sweeper (every 5 min) re-enqueues events unprocessed after 2 min, removes a failed/completed job first (BullMQ ignores an add for an existing id), counts an attempt only on a real re-enqueue, and alerts once at 10.

### Processing

**D-036 [logged] Persist, then process.** `process-webhook-event` validates the stored item, runs the handler in ONE transaction, runs side effects (enqueue, dashboard event, alert) AFTER commit, and stamps `processed_at` LAST. Handlers are idempotent (`messages.wamid` UNIQUE, conditional state machines), so a crash anywhere is repaired by retry or the sweeper.
An effect that must not be lost (a media download) is re-derived from database state on replay; dashboard events are best-effort (the dashboard also refreshes on reconnect). A status for a message we do not hold yet retries with backoff (5 attempts, ~30 s) and then settles with a note and NO alert (statuses for messages sent before we connected are normal). Concurrent webhooks for one customer are serialised with advisory locks.

**D-037 [logged] The 24h window has exactly one definition** (`refreshConversationAggregates`): the latest LIVE customer message (inbound, provenance `customer`, not a reaction) + 24 h. Echoes, reactions, imports and history can never open or extend it, and history cannot move it backward. A message timestamp more than 5 minutes in the future is clamped to now: a wrong clock must not extend the right to send free text.
Reactions and system notices never change the window, the status or the list order. Status: a customer message -> `waiting_on_me`; an echo -> `waiting_on_customer`; history leaves an existing status alone (new history conversations are created `resolved`).

**D-038 [logged] Identity.** BSUID first, then phone. Two records are merged only when nothing contradicts that they are one person; otherwise they are kept apart, the owner is alerted once (`identity_conflict`), and the message goes to the BSUID record. A phone is only FILLED when blank: webhooks are retried for ~36 h and arrive out of order, so a message may carry an OLDER number than the one on file, and following it would point replies at a number that may now belong to someone else; only an explicit `user_changed_number` notice replaces one.
A BSUID that was replaced (`user_id_update`) is recognised from the stored `uidupd:` events (up to 3 renames, no extra table) so a late message from the old id joins the same person instead of creating a phantom contact. `user_id_update` rewrites the BSUID, or merges when a message under the new id raced ahead. Names: owner-saved (app-state sync) > existing > WhatsApp profile; an imported label beats a profile name on merge; a contact removed in the phone app is left alone. We never merge by name.

**D-039 [logged] Echoes (messages the owner sends from the phone).** Stored outbound with provenance `owner_app_echo`, status `sent`. They reset `consecutive_auto_replies`, supersede every open draft (through the draft state machine's `new_inbound`), and never touch the window. An echo that names no recipient (`to`/`to_user_id`/`recipient_*`) is parked with an alert: filing the owner's words in a guessed thread is worse than not filing them.

**D-040 [logged] History import.** Direction = `from` is our own number (`metadata.display_phone_number`). Customer = the thread id (`threads[]`) or the sender/recipient. **An owner-side message in a flat chunk that names no recipient is NOT imported** (counted, alerted `history_unattributed`): the open-source fixtures have exactly that shape, so if real Meta is flat the owner-side import stays empty until a real payload shows how to attribute it. This is the largest unverified assumption in Phase 1.
Provenance: customer messages `customer` (spec said `imported` for all), owner-side `imported` (what style learning reads). Quiet: no drafts, no per-message dashboard events. Reply links are not resolved. Media past Meta's ~14-day window arrives without an id and is shown as "[Image unavailable]", or its caption.

**D-041 [logged] Edits and deletes by the customer.** The target is looked up by `context.id`, then by the message's own id (the exact shape is unconfirmed). A delete blanks the text and transcript but keeps the row (thread order and reply links), sets `deleted_at`, and the media is no longer served: the customer took it back and we do not keep showing it, searching it, or feeding it to a model. An edit replaces the content and sets `edited_at`; drafts written for the old text are superseded. If the target has not been processed yet the job waits (Meta does not guarantee order); on the last attempt an edit is kept as the customer's words and a delete is settled.

**D-042 [logged] Message types.** Every known type has a readable rendering; an unknown type becomes `unsupported` with a safe token (letters/digits/underscore, 32 chars). `order` is stored as `interactive`. `system` notices feed identity and are never stored as messages. Group messages are ignored (spec 16).

### Media and AI

**D-043 [logged] Media.** Only an allowlist of MIME types is stored (no HTML, SVG or executables), the message type must agree with the file's type, the extension comes from the verified MIME (never a filename), the path is `{yyyy}/{mm}/{message-id}.{ext}`, writes are atomic (temp + rename, mode 0640), and the SHA-256 Meta reports is checked (accepted as hex or base64: Meta is inconsistent). We do NOT sniff magic bytes: a mislabelled file is harmless because it is served with the verified type, `nosniff`, `Content-Security-Policy: sandbox`, `no-store`, and documents as attachments. The download URL must be public https (the access token never goes to an internal host); the size cap is enforced while streaming.
A file that will never arrive (gone, unacceptable) settles as unavailable and clears `media_id` (so nothing re-enqueues it and the UI can tell "gone" from "downloading"); a rejected token raises one critical alert per day. `/api/media/[id]` verifies the session itself and refuses (404) deleted messages, bad paths and symlinks that leave the directory.

**D-044 [logged] Voice notes.** Whisper has **no Luganda** and, given speech it does not know, produces fluent nonsense (often labelled Swahili or English). A transcript is trusted only when it is plausible English by language, Whisper's own thresholds (avg_logprob < -1.0, compression_ratio > 2.4, no_speech_prob > 0.6) and phrase-loop detection. **An unreliable transcript's text is discarded**: never stored, shown, or sent to a model; the message tells the owner to listen. Trusted transcripts are always labelled "auto-transcribed". (Phase 7 adds: a machine-transcript trigger always routes to approval.)
The per-segment numbers are read from the provider's raw response body (`responses[0].body`), which the SDK returns at runtime but does not declare in its types: an integration test fails first if that ever stops, and the text heuristics still apply.

**D-045 [logged] AI wrapper (spec 9.1).** `generateText` + `Output.object` (never `generateObject`), `instructions` not `system`, 30 s per call, SDK `maxRetries: 1` (the queue owns the rest, so a stuck provider cannot hold a worker inside one job), one `ai_runs` row per call, ONE corrective retry that names the broken fields but never their values, and a one-time per-model fall back from strict JSON-schema decoding when Groq answers 400. Errors stored and logged are content-free. Model ids come only from the environment. `.env.example` corrected: the Phase 0 file suggested `llama-3.3-70b-versatile` and `llama-3.1-8b-instant`, which Groq retires 2026-08-16; defaults are `openai/gpt-oss-120b` (draft, analysis), `openai/gpt-oss-20b` (verify), `whisper-large-v3`; Graph `v26.0`.

### Dashboard

**D-046 [logged] Realtime.** One Redis subscriber per web process fans out to all SSE streams and RE-VALIDATES every event against the strict schema (a message body cannot ride the stream even if something else publishes one). Cap 20 open streams (503 + Retry-After), heartbeat 25 s, a slow reader is dropped rather than buffered, the session is re-checked every 5 min. The client reconnects manually with jittered backoff (the browser gives up for good on 401/503), refreshes once on every reconnect and when a background tab returns, and debounces bursts (300 ms). Measured in Chromium: ~440 ms from POST to screen.

**D-047 [logged] Lists and search.** Keyset pagination on `(last_message_at, id)` with MICROsecond cursors (a millisecond cursor skips or repeats tied rows). Search: names and usernames (`ILIKE`, wildcards escaped), phone digits (the local form "0700 123" and E.164 both match), and message words with prefix matching through a `simple` tsquery built only from letter/digit runs (no syntax injection). Raw `db.execute` returns timestamps as strings (Drizzle disables the driver's date parsing): every raw timestamp goes through `toDate` and is asserted in tests. Times are formatted in `OWNER_TIMEZONE`. Status, delivery and window are always text as well as colour.

### Verification

**D-048 [logged] What was verified how.** 605 unit and 396 integration tests on real Postgres 16 and Redis 7 (every fixture replayed through the real pipeline, plus a real BullMQ worker end to end); ~55 mutation checks on the guards (window, identity, echo, history, status, NUL, clamp, route auth, symlink containment, hash, MIME, SSRF, size cap, transcript discard, deletion race, SSE auth/validation/cap, pagination, search escaping, deleted-message privacy), all killed except 3 redundant defensive clauses (equivalent mutants: the `direction` clause beside the `provenance` clause of the window, the identity null-guard beside `resolveContact`'s own, the `..` check beside the `relative()` containment check). Weak tests found this way were strengthened.
The production build was driven in Chromium (login, signed webhooks, live updates, media through the authenticated route, security headers, no console errors, no horizontal scroll at 320-1280 px) and **several real defects were found only there** (raw timestamps as strings crashing the pages; a sticky header hidden under the app header on narrow phones; a sidebar that scrolled away; bubbles showing through a translucent header; the newest message hidden under the bottom nav): see the phase report.
One intermittent failure class in the Playwright script (the Settings assertions) was observed twice, right after a server restart, and could not be reproduced with diagnostics on; the script now waits for the page itself. Cause unconfirmed. (A third failure was the script's own test data and is fixed.)

**D-049 [approved] Phase 7 gate (answers D-029).** Autopilot may be enabled only when ALL hold over the last 30 days of approved drafts: median edit distance <= 0.30 AND p75 <= 0.50, at least 200 approved drafts, and the latest eval run (>= 50 samples, <= 30 days old, matching the active prompt, model and style guide) shows 0 invented facts. Autopilot is OFF by default (`autopilot_paused = true`).


## Phase 2 (2026-10-05)

### The send path

**D-050 [logged] One send path, two halves (builds on the approved D-008).** `queueMessage` runs INSIDE the caller's transaction: lock the conversation (`FOR UPDATE`), return the existing message for a repeated idempotency key, read `sending_paused` and the window, run the pure `precheck()`, insert the row as `queued`, and (for a draft) claim the draft with a conditional UPDATE in the same transaction, then refresh the aggregates and supersede the other open drafts. A refused check THROWS, so everything rolls back and the draft stays `pending`. The job is enqueued only AFTER commit (`afterCommit` hook on `ownerAction`: it never runs on a rollback, and its failure does not fail an action whose change is already committed; `alerts-scan` re-enqueues a lost job). `performSend` (the worker) is two short transactions around the HTTP call: (1) lock the message, re-run the pre-check (the kill switch and the window can change while the job waits), and stamp `send_started_at` atomically; (2) record the outcome through the message state machine. Effects (dashboard events, alerts) leave the transaction as data and run after commit. A static test fails if any other file imports `whatsapp/send-api.ts`, builds a Graph `/messages` URL, or queues an outbound row.

**D-051 [logged] Failure classes.** A failure is retried ONLY when Meta definitively did not send: throttling codes, a 5xx that carries a Meta error body, a connection that was never made (refused, DNS, TLS handshake). A timeout, a connection reset after the write, a 2xx we cannot read, and a 5xx WITHOUT a Meta body are `ambiguous` -> `unknown`, never retried (the Cloud API has no idempotency key, so a retry of an ambiguous failure is a duplicate message to a customer). A retry clears the stamp and COMMITS that before throwing for BullMQ (throwing inside the transaction would roll the clear back). An error code the table does not know is permanent and shown raw. The table (`whatsapp/errors.ts`) is written from SDK knowledge and secondary documentation, NOT Meta's reference: **verify it against real errors** (listed in `docs/ACCEPTANCE.md`). Retries are capped by the queue (3 attempts, 5 s exponential); on the last one a retryable failure becomes a visible `failed`.

**D-052 [logged] `unknown` is the owner's call.** The message shows "We could not confirm this was sent. Check your phone" with two actions: "It arrived" (`unknown -> sent`) and "It did not arrive: send again" (the original closes as `failed`, one NEW queued message with the same text, key `resend:{original id}` so it cannot be created twice, through the normal pre-check: a closed window refuses it and the original stays `unknown`). Text only: a template's values are not stored on the row. A late "accepted" answer for a message `alerts-scan` had already parked as `unknown` makes it `sent`. A status webhook that beats our write of the wamid is matched through `biz_opaque_callback_data` (our message id) and the status never moves backward.

**D-053 [logged] Idempotency keys come from the client**, one per composed message and reused on retry (a double click, a slow network or a re-submitted form is one message); the allowed characters exclude `:` so a client can never forge a `resend:` key. Template components travel in the job data (no schema change). If the job is lost for a template, the message fails visibly (`template_job_lost`) rather than being sent with guessed values.

**D-054 [logged] Recipient.** `to` (phone digits) when the contact has a phone, else `recipient` (BSUID), never both. **The BSUID `recipient` field is unverified against Meta**; a BSUID-only customer is the first thing to test with a real account.

### Templates

**D-055 [logged] Templates (v1 subset).** Listed from the WABA, cached in Redis (refetched after 5 min, kept 1 h and served stale with a notice if Meta is down). An APPROVED template with a text body (positional `{{1}}` or named values), an optional text footer, a header without values and quick-reply / phone / static-link buttons is usable; everything else (media headers, buttons with values, carousels, limited-time offers, authentication, anything not APPROVED) is listed disabled with the reason. The send action reads only the cache (never the network inside a database transaction) and re-checks the owner's values against the template: nothing is guessed. Value rules (no line breaks or tabs, no runs of 4+ spaces, 1,024 characters) follow Meta's template error 132018 and are **unverified**.

### Notifications and safety nets

**D-056 [logged] Telegram is send-only in this phase** (the inbound bot for Cancel / Send now arrives with the autopilot). Plain text only (no `parse_mode`), never a message body, bot token only in the request URL and never logged or returned, a short `retry_after` is waited out once and a long one is not, and no failure ever throws into the caller. Alerts reach it through the alert sink registered in the worker: `info` alerts are dashboard-only, quiet hours (owner's time zone, default 22:00-07:00) silence everything except critical alerts, the owner's `notify_telegram` switch silences all of it, and an unreadable quiet-hours setting means "not quiet". The throttle / digest rules for draft notifications belong to Phase 4, where those notifications exist.

**D-057 [logged] Scheduled jobs.** `alerts-scan` every 5 min: a message stamped but unanswered for 3 min becomes `unknown` + alert (`SKIP LOCKED`, so a worker finishing its send is left alone); queued and never stamped for 5 min is re-enqueued (a failed job is removed first, BullMQ ignores a re-add of an existing id); a template whose job is gone fails; a customer still waiting whose window closes within 2 h gets ONE alert per window (the dedupe key carries the expiry). `token-health` daily 06:10 (and "Check now" in Settings): a rejected token is the one critical alert, an outage on either side is a quiet warning. `purge-payloads` daily 03:30: nulls the payload of PROCESSED events older than 30 days and keeps the row (dedupe); an unprocessed event keeps its payload however old (the sweeper needs it).

### Dashboard

**D-058 [logged] Composer and countdown.** The composer mirrors the rules (window, placeholder, length, paused) only so the owner learns WHY before typing; the server decides, again, in a transaction. The window badge ticks client-side from one shared 10-second clock (a thread left open for hours must not keep promising "23h left"), and when the window closes mid-typing the box is replaced by the template picker without a reload and the typed text is kept. The reply box is `sticky` above the phone tab bar, pinned to the bottom even on a short thread, capped at 55% of the screen (a tall template form scrolls inside itself), with a negative bottom margin that cancels the page's tab-bar padding so it sits in the same place stuck or scrolled. Status-webhook failures use the same readable wording as send-time failures; our own internal reasons (`resent`, `template_job_lost`) are never shown as "code".

**D-059 [logged] What was verified how (Phase 2).** 725 unit and 522 integration tests (real Postgres 16 and Redis 7; Meta Graph and Telegram mocked at the fetch layer). Mutation checks: 33 mutants over the send core (crash-after-accept, stamp, retry/ambiguous classes, pre-check at queue AND at send time, draft claim, double approval, idempotency, state machine, resend/mark-sent) and 24 over the scans, purge, token check and Telegram sink (plus 3 over the `afterCommit` / refusal hooks). Everything was killed except guards that are layered on purpose and only killable in combination (message lock + conditional stamp; conversation lock + draft lock + conditional draft claim; idempotency pre-check + insert conflict; the candidate query + the locked re-check in `alerts-scan`): each pair was killed once removed together. The sink's outer `catch` (a DB error while reading settings) is defensive and has no test. The production build was driven in Chromium against a fake Meta/Telegram (a `--require` preload in the scratchpad, not in the repository): 53 checks (send, double click, Ctrl+Enter, timeout -> unknown -> "it arrived" / "send again", Meta refusal, throttle retry, the window closing live, templates, kill switch, Telegram test, token check, geometry at 320/390/1280 px, no console errors). **Found only in the browser**: the countdown showed "24h left" for a message that arrived 5 s ago (a floor-quantised clock ran behind real time and over-promised), the reply box hid the newest message, floated mid-screen on a short thread and left a gap above the tab bar, a tall template form covered the thread, internal reasons appeared as "(code resent)". **Not verified: anything against the real Meta, Telegram or WhatsApp.**

## Phase 3 (2026-10-05)

### Corpus

**D-060 [logged] Chat import.** `pnpm import:chats <file|folder> --me "<your name>"` reads WhatsApp "Export chat" `.txt` files (one customer per file): Android `12/03/2024, 14:05 - Name: text` and iOS `[12/03/2024, 14:05:33] Name: text`, 12 or 24 hour clocks, U+202F before AM/PM, U+200E marks, a BOM, multi-line messages, system lines, call notices, `<Media omitted>` / `image omitted` / `(file attached)` placeholders, deleted messages. **Day-first versus month-first is decided from the file** (a value above 12 proves it; contradictory values refuse the file as two exports joined; a file where every date is ambiguous is imported day-first and the warning says so, `--date-order` overrides). A chat with more than two senders is refused (group). Times are read in `OWNER_TIMEZONE` (daylight-saving gaps move forward, overlaps take the first occurrence). Everything is stored as provenance **`imported` on BOTH sides** (spec said `imported`; D-040's `customer` for history is not used here, so an import can never open the 24 h window even if it contains today's customer message), outbound `sent`, inbound `received`; a media placeholder becomes a `[Media omitted]` note (`unsupported`), a deleted message is skipped. A NEW conversation is `resolved`; an existing one keeps its status. **Idempotent**: each message has a key from (contact, side, the exact minute, the n-th identical message in that minute, text), so a re-run inserts nothing, and a later, longer export adds only the new tail. **Never a double of what WhatsApp already delivered**: an imported message whose side, minute and text already exist in the conversation (live or history-sync) is skipped (counted, so two identical live "ok"s cover two imported ones, not three). Same-minute messages keep file order, one millisecond apart. The customer is matched by **phone number** when the export names one (joining a live contact), otherwise by an **exact, case-insensitive name among earlier name-only imports**; it is **never linked to a live contact by name** (two customers share a first name; `--contact <id>` links explicitly). One advisory lock per customer, audit entry per file (counts and file name, never text).

**D-061 [logged] Stages (spec 9.4), and where I interpreted the spec.** A conversation is cut into segments wherever two consecutive messages (either side) are >= 24 h apart. Each owner message is, in this precedence: `opening` (the first owner message of its segment), `closing` (the segment's last word: followed by >= 24 h of silence, or with nothing after it and 24 h old at "now"), `followup` (directly after another owner message), else `mid`. The spec's wording ("first owner message after >= 24 h silence") is ambiguous about what "silence" is measured between; this reading makes opening and closing symmetric and never depends on the owner's previous message. The same rules exist in TypeScript (`stages.ts`) and SQL (`fewshot-sql.ts`, used for retrieval so it can run in the database), proven equal on 60 random conversations full of boundary gaps, reactions and failed sends (all four stages occur). The stage of the NEXT reply is `opening` when nobody from the owner's side has spoken in the current segment, else `mid`.

**D-062 [logged] Few-shot retrieval.** A pair is the run of customer messages (at most the last 5, oldest first) since the owner last spoke, plus the reply; a follow-up has no customer side. Eligible replies are the owner's own words only: `owner_manual`, `owner_app_echo`, `imported`, `ai_edited`, text, not failed, no `[[placeholder]]`; **never `ai_unedited` / `ai_autopilot`**. Selection: up to 3 of the same stage, then the best of everything else up to 8, ranked by Postgres full-text rank of the customer side against the new burst (the burst's lexemes of 3+ letters, OR-ed, `simple` config: content is multilingual), ties newest first, a pair with no customer text after every pair that has one; at most 2 per conversation; none from the current conversation's last 24 hours; none the caller excludes (the evaluation's holdout); **no two identical replies** (eight "ok"s teach nothing; not in the spec). The pair set is computed on the fly with window functions on every call: fine at this scale (tens of thousands of messages), not a materialised view, and the first thing to optimise if drafting ever feels slow.

### Style

**D-063 [logged] Style extraction (spec 9.6).** The model sees ONLY the owner's own eligible messages (never a customer message, never AI-written ones; angle brackets neutralised, 500 characters each), tagged with their stage: up to 400, an equal share per stage (a short stage's unused share goes to the others), newest first, **no sentence repeated more than twice**. Fewer than 30 is refused before any model call. The analysis model at temperature 0.1 returns the schema in spec 9.6; the generic assistant phrases the owner never writes ("I hope this message finds you well", "Certainly!", "As an AI", ...) are added to `forbiddenPatterns` (not any phrase the owner does write), capped at 30. A new version is created INACTIVE (number claimed under an advisory lock) and the owner activates it after reading the word-level diff against the active one; activation deactivates the previous version in the same transaction (advisory lock + the partial unique index). The extraction runs in the worker; progress lives in a short-lived Redis entry (a crashed worker cannot leave the button disabled for more than 10 minutes).

### Drafting and evaluation

**D-064 [logged] Draft prompt `draft-v1` and call.** The system prompt follows spec 9.2 slot for slot (nine rules, `<now>` with offset and weekday, profile, style guide, forbidden patterns, examples; a cold start omits the guide and examples and adds the "briefly, warmly, plainly" rule), the user turn is summary + last 15 messages + the burst. Every piece of person-written or model-written text is sanitised (angle brackets, 2,000 characters) including the owner's own profile and names, because a tag-breaking `</rules>` from any of them would change the prompt. The reply schema is spec 9.3 verbatim (no confidence field). After the call, code (not the model) checks: a `[[placeholder]]` with no `missingFacts` gets a generic entry; `missingFacts` with no placeholder sets `missingFactsUnmarked` (the owner must read it); a transcript the pipeline judged unreliable forces `unreadable_media`. Temperature 0.4; **reasoning effort `low` is sent only to models whose id matches gpt-oss or qwen** (a model with no such setting is not sent one: Groq's behaviour for a non-reasoning model is unverified). Context building is separate from the model call and takes an "as of" time and an exclusion list, which is what lets Phase 4 and the evaluation share it.

**D-065 [logged] Evaluation (spec 9.8).** The 50 most recent eligible (customer -> owner reply) pairs are held out; each is drafted AS OF the real reply's time (history before the burst, the clock at that moment, the stored summary NOT used because it describes the conversation as it is today), and every held-out reply is excluded from every call's examples. Per sample: normalised Levenshtein over code points (NFC, trimmed; an emoji is one edit), length ratio, emoji-count difference, forbidden-pattern hits, invented facts. **Invented-fact detector**: numbers (`50k`, `UGX 50,000`, `50 000`, `50000` are one number), calendar words and weekdays in the draft, outside a `[[placeholder]]`, that appear in none of: the profile, the owner and business names, the history, the burst, the clock line. **The few-shot examples are not allowed to license a fact** (a price from another customer's chat must not justify a price here). Blind spots, documented: numbers written as words, wrong names or products, relative dates; it errs toward flagging (an unexplained "2" is reported). Aggregates: median, p25, p75 of edit distance, mean length ratio and emoji difference, forbidden and invented RATES (share of drafts). Against the previous run (paired by held-out reply): **regressed** if the median edit distance rose with a 95% paired-bootstrap interval excluding zero, or the invented-fact rate rose at all; otherwise ok. A run where more than 20% of drafts failed is refused (nothing written, nothing recorded); a failure is reported by error NAME only. `eval_runs` records prompt, model, style guide, successful sample count and the rates for the Phase 7 gate (D-049); a run under 50 samples says so and cannot satisfy it. Reports (`eval/results/*.md|json`) hold real messages and are git-ignored.

**D-066 [logged] Business profile and names.** Settings has an editor (profile up to 8,000 characters, owner and business names up to 80, no angle brackets or line breaks in names) with a live preview drawn from parsed data: the markdown reader produces blocks and inlines, never HTML, and links, images and tags are shown as the text they are. The page says plainly that the profile is the ONLY source of prices, stock and policies. The audit entry holds lengths, never the profile.

**D-067 [logged] What was verified how (Phase 3).** 825 unit and 615 integration tests (real Postgres 16 and Redis 7; Groq mocked at the fetch layer). About 65 mutation checks over the importer (12), stage / pair SQL (10), the retriever and its pure selection (9), style extraction (14), the evaluation harness (13) and draft context (10): all killed. Two survived on the first pass because the layers above and below them were redundant or my test could not see them, and each got a test that kills it (the version-number race now has eight racing transactions; the held-out summary now has a planted marker). The importer, the style page (extract, activate, diff, versions) and the profile editor were driven in Chromium against the production build with the real import CLI and a fake model; `pnpm eval:drafts` ran end to end (dry run, a 50-sample run, a second run with the paired comparison) against the same database. **Not verified: any real model.** The baseline evaluation that spec 9.8 wants recorded here **cannot be produced without your Groq key** (`docs/ACCEPTANCE.md`, step 17), and so none of the quality questions (does it sound like you, how often are facts invented, how does it do in Luganda) has an answer yet.
