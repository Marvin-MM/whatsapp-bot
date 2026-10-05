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
One intermittent race in the Playwright script (Settings checks) was observed twice and could not be reproduced with diagnostics on; the script now waits for the page itself. Cause unconfirmed.

**D-049 [approved] Phase 7 gate (answers D-029).** Autopilot may be enabled only when ALL hold over the last 30 days of approved drafts: median edit distance <= 0.30 AND p75 <= 0.50, at least 200 approved drafts, and the latest eval run (>= 50 samples, <= 30 days old, matching the active prompt, model and style guide) shows 0 invented facts. Autopilot is OFF by default (`autopilot_paused = true`).

