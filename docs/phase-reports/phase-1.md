# Phase 1 report: ingest, media, live dashboard

Date: 2026-10-05. Branch `claude/whatsapp-reply-assistant-bb49ug`. Spec phase 1 (+ the corrections in `DECISIONS.md` D-030..D-049).

## Verdict

Phase 1 is **built and verified against everything that can be verified from a sandbox**, and **not verified against the only things that matter most**:
real Meta payloads, real Groq, real voice notes. Every shape Meta sends was reconstructed from SDK type definitions and open-source fixtures because
Meta's own pages were unreachable (D-031). The code is deliberately defensive about that (nothing it does not understand is dropped, guessed at, or allowed
to crash ingest: it is stored, parked and alerted), but **defensive is not the same as correct**. Until `docs/ACCEPTANCE.md` step 4 has been done with real
payloads, treat the history import and the echo handling as *unproven*. If you only do one thing, do that.

## What was built

| Area | What it does | Where |
|---|---|---|
| Webhook intake | 3 MiB cap -> HMAC over raw bytes (401, zero writes) -> JSON -> envelope; persists every item losslessly with `ON CONFLICT DO NOTHING`, bulk-enqueues with a deadline; any DB/Redis failure = 500 so Meta retries; GET handshake | `src/lib/whatsapp/*`, `src/app/api/webhooks/whatsapp` |
| Safety net | sweeper re-queues anything the worker did not finish; `raiseAlert` (deduped, SSE, pluggable sinks) | `src/lib/ingest/sweep.ts`, `src/lib/alerts.ts` |
| Ingest | message, status, echo, history, app-state, identity, account handlers in one idempotent transaction; effects after commit; `processed_at` last | `src/lib/ingest/*`, `worker/processors/process-webhook-event.ts` |
| Identity | bsuid-then-phone, merge only when nothing contradicts, retired-BSUID recognition, advisory locks, owner-saved names | `src/lib/ingest/contacts.ts`, `identity.ts` |
| Media | Graph lookup, capped download, hash + MIME checks, atomic store, authenticated range-capable route | `src/lib/ingest/media-job.ts`, `src/lib/whatsapp/{client,media}.ts`, `src/lib/media-serve.ts` |
| AI layer | provider from env, structured-output wrapper (timeout, `ai_runs`, one corrective retry), transcription with a reliability assessment | `src/lib/ai/*` |
| Live dashboard | SSE hub + stream, reconnecting listener, conversation list (keyset, search, filters), thread, Settings connection card, Overview | `src/lib/realtime/*`, `src/lib/conversations/*`, `src/components/*`, `src/app/*` |

About 5,000 lines of source; the test suite (Phase 0 + 1) is about 7,000 lines. Migration `0003` adds `contacts.username` and `messages.marked_bad_at` (both approved).

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| `pnpm test` (unit) | **605 passed** (26 files) |
| `pnpm test:integration` (real Postgres 16 + Redis 7) | **396 passed** (20 files) |
| Fresh clone (clean checkout, `pnpm install --frozen-lockfile`, all four gates, `pnpm build` with an EMPTY environment, boot web + worker, handshake 200 / bad token 403 / unsigned POST 401 / signed POST stored and processed) | all green |
| Every one of 60 webhook fixtures through the real pipeline, replayed, and a forced reprocess | state identical; database invariants hold |
| A real BullMQ worker end to end (POST -> queue -> worker -> database, status-before-message retry, image -> media job -> verified file) | green |
| **Mutation checks** (break the code, watch the right test fail) | ~55 mutants over the guards: all killed except **3 redundant defensive clauses** (equivalent mutants, listed in D-048). Mutation testing exposed **four weak tests, now strengthened** (the 24h-window definition three times over, one half of the "same person" merge rule). Review and failing tests exposed more weak spots: the phrase-loop detector, a symlink hole, a no-op assertion I had written |
| Production build in **Chromium** (login with TOTP, signed webhooks as Meta sends them, live updates, media through the authenticated route, headers, 320-1280 px) | 35 checks pass (last run), after 3 consecutive clean runs earlier; a new message appears in an open thread in **~440 ms** (spec: < 3 s) |

### Defects the tests did NOT catch and the browser did

1. **Every conversation page crashed in production** (`a.getTime is not a function`): raw `db.execute()` returns timestamps as strings. My query tests asserted ids and text, never the type. Now converted at the boundary, with assertions, proven to fail when the bug is reintroduced.
2. The sticky conversation header used a hard-coded offset and was **hidden under the app header on small phones** (the app header wraps to two rows): replaced by a measured CSS variable.
3. The desktop **sidebar scrolled away** on long threads; message bubbles **showed through a translucent header**; the newest message was **hidden under the bottom navigation** after auto-scroll; the phone header ate a third of the screen. All fixed and re-measured at 320/360/390/430/768/1024/1280 px.
4. Phone search missed the local format ("0700 123 456" vs stored "+256 700 123 456"). Found by writing the test for it, not by thinking.

### Other real bugs found while writing tests (all fixed, all have regression tests)

Phrase-loop hallucinations ("thank you thank you ...") slipped past a single-word repeat detector; a late retried webhook could overwrite a customer's phone with an older number; a late message from a customer's *old* BSUID created a phantom contact; id-less events (account state, contact renames) were deduped forever after their first occurrence; a symlink inside the media directory could lead out of it; NUL characters would have put Meta into a 36-hour retry loop.

## NOT verified (and what that risks), most important first

1. **Real Meta payload shapes** (D-031). Risk: the echo and history handlers assume shapes I could not confirm. *Failure mode is quiet data loss with an alert*, not a crash: owner-side history messages not imported (`history_unattributed`), echoes parked (`echo_recipient_unknown`). **Your replies being imported is what Phase 3's style learning is fed from**, so if the history shape is wrong, style learning starts from nothing.
2. **How Meta expresses edits and deletes** (D-041): looked up by `context.id` then by own id; unconfirmed.
3. **Meta media retrieval in practice** (token on the CDN URL, hash encoding, content types). Mocked at the network layer with the documented behaviour; never run against Meta.
4. **Transcription on real audio.** The reliability thresholds are Whisper's own plus conservative heuristics, tested with a Groq stub that returns the real response shape. English accuracy, how often code-mixed notes are rejected, and whether Whisper labels Luganda as `sw` or `en` are unknown. The design makes every wrong answer *cost the owner one listen* rather than feed a fiction to the model, but "unreliable" might be the usual outcome for your customers.
5. **Docker** (`docker-compose.yml`, `Dockerfile`): written, never run (no daemon here).
6. **The browser verification script is not in the repository** (it lives in the scratchpad: `playwright-core` is not an allowed dependency). So it is not reproducible by you and not run in CI. The behaviours it checked are mostly unit/integration-tested too; the *layout* checks are not.
7. **One intermittent failure class** in that script: three Settings assertions failed in two runs, each right after a server restart, and could not be reproduced with diagnostics on (3/3 clean afterwards, and 35/35 in the final run). **Cause unconfirmed.** A streamed loading skeleton or a cold connection pool are my guesses; the script now waits for the page itself. (A third failure, the "deleted message" check, was *my own test data*: the fresh-clone smoke test had posted a copy of the same sentence into the same database. The check is now scoped to the message's own element.)

## What is weak (my own critique)

- **The 24h-window badge is rendered at request time and never ticks.** A thread left open shows "Open · 23h 55m left" for hours until an event refreshes it. Harmless while the dashboard is read-only; it must become a client-side countdown before the composer lands (Phase 2) or the owner will trust a stale badge.
- **Search is word-prefix only.** "dre" finds "dress"; "ress" does not; there is no typo tolerance.
- **`webhook_events.payload` is never purged yet** (the `purge-payloads` job is Phase 2). Roughly kilobytes per event at <500 messages a day: harmless for months, but it is customer content sitting in a table longer than the 30 days the privacy text promises, until Phase 2.
- **App-state sync creates a contact row for every contact in your phone** that is not otherwise in the system (invisible: no conversation, so never listed). Privacy-neutral, but it is data about people who never wrote to the bot.
- **No load test of a very large history chunk** (a thousand messages in one transaction). Logic is batched; performance is untested.
- The conversation list refreshes by re-rendering the page on any event, which is simple and correct at this scale and wasteful if it ever were not.
- Phone numbers are shown in full in the dashboard (it is yours); only logs mask them.

## Commands

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration     # all four gates
pnpm build && pnpm start                                              # production build
pnpm dev:worker                                                       # the worker MUST be running for anything to be processed
```

## Decisions

D-030 .. D-049 in `DECISIONS.md` (process, Meta research limits, body cap, schema, response policy, dedupe keys, processing model, window, identity, echoes,
history, edits/deletes, message types, media, voice notes, AI wrapper, realtime, lists and search, how it was verified, the Phase 7 gate).

## Next: Phase 2 (manual send path)

Includes, because Phase 1 deferred them: `purge-payloads`, the Telegram alert sink, `alerts-scan` (expiring windows), a client-side window countdown, and **the send path
(`src/lib/send/send-message.ts` is the only file that may touch Meta's send endpoint)** with the fixes approved in D-008.
Your Phase 1 checklist (`docs/ACCEPTANCE.md`) can run in parallel; whatever it finds goes to the front of the queue.
