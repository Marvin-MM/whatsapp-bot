# Phase 5 report: summaries, tasks, follow-ups

Date: 2026-10-05. Branch `claude/whatsapp-reply-assistant-bb49ug`. Spec phase 5 (+ D-075..D-081 in `DECISIONS.md`).

## Verdict

Phase 5 is **built and verified against everything a sandbox can verify**, and **not verified against a real model.** After the owner's reply (from the
dashboard or typed on the phone) a job keeps a three-sentence summary and a list of what the owner owes; the owner manages that list on **Tasks**;
overdue tasks alert once; the **Overview** shows what is slipping. The code decides which of the model's proposed changes are acceptable, so a
model that invents an id, a year or a duplicate cannot change anything it should not. What does **not** exist is evidence that `analysis-v1` makes a
real model write good tasks and the right dates: the prompt has never met one. `pnpm test:ai` (now with analysis scenarios) and `docs/ACCEPTANCE.md`
steps 25-26 answer that; until they are run, treat task quality as unknown.

## What was built

| Area | What it does | Where |
|---|---|---|
| Analysis | Job per accepted outbound message; reads the newest messages since the summary; model call outside any transaction; applied under the conversation lock against fresh tasks; concurrency-safe (covered / stale); AI paused skips without advancing | `src/lib/analysis/{analyze,trigger}.ts`, `worker/processors/post-send-analysis.ts`, `src/lib/ai/prompts/analysis.ts` |
| Planner | Rejects foreign / closed ids, dates more than a day past, duplicates, no-op updates; applies the rest | `src/lib/analysis/operations.ts` |
| Triggers | After `sent` in the send path and after a phone echo (also on an echo replay) | `send-message.ts`, `ingest/echoes.ts` |
| Safety nets | Overdue-task alert (once per due time); lost-analysis requeue (once per message, last 24 h) | `src/lib/ops/alerts-scan.ts` |
| Owner tasks | create / done / cancel / reopen / edit, conditional, audited without text, owner-zone times | `src/lib/tasks/{manage,present}.ts`, `src/actions/tasks.ts` |
| Tasks page | Open (late first, red + words) / Done / Cancelled, filters by kind and when, source links, inline actions, add form, overdue badge on the tab | `src/app/(dashboard)/tasks`, `src/components/tasks/*` |
| Thread panel | Summary and tasks above the thread in a closed bar (first line + open/late counts) | `src/components/tasks/conversation-panel.tsx` |
| Overview | Four cards + Needs attention (grouped, worst first); median first reply | `src/app/(dashboard)/page.tsx`, `src/lib/dashboard/attention.ts`, `src/lib/metrics/response-time.ts` |
| Real-model suite | Analysis scenarios (tomorrow 3pm, no invented time, completes by real id, injection) | `test/ai/analysis-behaviour.test.ts` |

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| `pnpm test` (unit) | **961 passed** (45 files) |
| `pnpm test:integration` (real Postgres 16 + Redis 7) | **770 passed** (39 files) |
| Analysis | "call me tomorrow at 3pm" -> task due 2026-10-05 15:00 +03:00 stored as 12:00Z, linked to the owner's reply; twice = once (and one model call); a repeated task on a later run is not duplicated; complete; foreign / invented / closed ids rejected while valid operations apply; past dates rejected; update re-arms the alert; only the new messages are sent next time; reactions, failed, queued and deleted/unreliable messages never reach the model; angle brackets defused; AI paused; schema failure -> alert on the last attempt only; invalid key -> the critical alert; two concurrent runs (covered, and stale -> retried) |
| Tasks | actions (auth, validation, audit without text, events), the lists (ordering, filters in the owner's calendar days, week boundary, source previews, deleted source hidden), counts, races |
| Alerts | once per due time; moved time alerts again; crash between alert and stamp is deduplicated; lost analysis requeued once, bounded to a day, finished job removed first, waiting job left alone, AI paused |
| Overview | needs-attention (each kind, grouping, "failed then resent" excluded, "unknown" kept, limits, ordering), waiting count, median first reply hand-computed (10/30/120 min -> 30 min; even count; bursts; echoes; imports invisible) |
| **Mutation checks** | 83 mutants (D-081): all dead or removed; **eleven survived the first pass and each was a real gap in a test or redundant code** |
| `pnpm test:ai` mechanics | stand-in good model: 11/11; stand-in that resolves "tomorrow" to today and obeys the injection: fails exactly those. **Never run against a real model.** |
| Production build in **Chromium** | the whole flow (D-081), no console errors; screenshots read by eye |

## NOT verified (and what that risks), most important first

1. **Any real model.** Whether `analysis-v1` makes the model resolve "tomorrow at 3pm" against `<now>` correctly (including after midnight and on Fridays),
   keep to three sentences, avoid duplicates and not invent tasks; whether the strict schema (a discriminated union) is accepted by the real model's
   structured-output mode (the wrapper falls back to non-strict on a 400, which a test proves, but the real model's behaviour is unknown). A task
   with a wrong date is the failure that costs you something: the red "overdue" and the alert only help if the date is right.
2. **Luganda and code-mixed chats.** Task wording is asked for in English; whether the model understands "nkusaba onkubire enkya ku ssaawa mwenda" is untested.
3. **Telegram delivery of the overdue alert on a real bot** (Phase 2 caveat).
4. **The median first reply against your feel**, and whether counting nights and weekends is what you want to see.

## What is weak (my own critique)

- **Tasks come only after YOU reply.** A customer's request that you never answer creates no task (the conversation is in "waiting for your reply"
  instead). That is the spec's design; it is also the case where a task would help most.
- **The link from a task to its message is a heuristic** (the newest customer message for a request, the newest owner message for a promise): the spec's
  schema has no field for "which message". With a burst of messages in one window the link can point at the wrong one of them.
- **Long histories are summarised in steps of 60 messages**; a conversation with hundreds of imported messages gets a summary of its newest part and
  learns the rest only as it continues.
- **A reply that is queued when analysis runs and sent later** can fall behind the summary's marker and be skipped until the next reply (rare: two
  replies in flight at once); the safety net covers a lost job, not this ordering.
- **The "Done" and "Cancelled" lists show 50 each and are always expanded**, which makes a long Tasks page on a phone. Collapsing them is a small change I did not make.
- **Manual tasks need a conversation.** There is no "remind me to order stock" without a customer: the schema requires the link.
- **The Overview's "waiting for your reply" and the other cards are counts without trends**; Phase 6 (analytics) adds the history.
- **The median first reply ignores business hours** by design; if you want "during opening hours only" that is a definition to decide with you.

## Commands

```
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
pnpm test:ai            # real draft + analysis models, opt-in
pnpm build && pnpm start & pnpm worker
```
