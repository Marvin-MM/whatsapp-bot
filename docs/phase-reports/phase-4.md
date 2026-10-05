# Phase 4 report: drafting and approvals

Date: 2026-10-05. Branch `claude/whatsapp-reply-assistant-bb49ug`. Spec phase 4 (+ D-068..D-074 in `DECISIONS.md`).

## Verdict

Phase 4 is **built and verified against everything a sandbox can verify**, and **not verified against a real model, a real Meta number or a real
phone.** A customer message now becomes one draft (a burst becomes one), the draft appears on **Approvals**, and the owner approves, edits, rejects or
regenerates it; whatever is approved goes through the one send path, so a `[[placeholder]]`, a closed window, paused sending or a newer customer
message refuses it with a reason and leaves it pending. Nothing the AI writes is ever sent without that approval. What does **not** exist is
evidence that the drafts are good: the prompt has never met a real model, so draft quality, the structured-output schema on the real model and the
`reasoning: low` setting remain unverified until you run `docs/ACCEPTANCE.md` steps 19-22.

## What was built

| Area | What it does | Where |
|---|---|---|
| Generation | One debounced `generate-draft` job per conversation; answers the unanswered set; re-checks under the conversation lock at completion (discard on new inbound, owner reply, overlapping generation); waits for voice-note transcripts; AI paused = no call; failure = a `failed` draft row + alert; lost-job safety net in `alerts-scan` | `src/lib/drafts/{trigger,unanswered,generate}.ts`, `worker/processors/generate-draft.ts`, `src/lib/ops/alerts-scan.ts` |
| Notification | Telegram "draft ready": link only, 10 min per conversation, digest above 5, quiet hours, switch, failed send frees its slot | `src/lib/notify/draft-ready.ts` |
| Decisions | Approve (`ai_unedited` / `ai_edited`, edit distance stored), reject, regenerate, "draft a reply"; all conditional, all audited without the text | `src/lib/drafts/decide.ts`, `src/actions/drafts.ts` |
| Queries | Approval queue (incl. failed drafts of unanswered customers), draft detail with staleness, intent edit-rate statistics, open-draft lookup, counts | `src/lib/drafts/queries.ts` |
| Screen | `/approvals`: queue, conversation with the answered messages outlined, draft card (chips, placeholders, missing facts, why-this-draft, edit rate), keyboard, mobile layout, confirmation, "Draft a reply" on conversations, count badge on the tab and the Overview | `src/app/(dashboard)/approvals`, `src/components/approvals/*` |
| Injection flag | Deterministic pattern check of the customer's words adds `prompt_injection` even if the model forgets (warning, not a gate) | `src/lib/ai/injection.ts` |
| Real-model suite | `pnpm test:ai`: 7 scenarios x 3 samples against the real model (opt-in) | `test/ai/`, `vitest.ai.config.ts` |

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| `pnpm test` (unit) | **923 passed** (42 files) |
| `pnpm test:integration` (real Postgres 16 + Redis 7) | ****702 passed** (35 files)** |
| Generation | burst -> one draft listing all triggers; debounce collapses to one delayed job; discard on new inbound / owner echo / overlapping generation / AI paused; failures; 401 alert; no-reply drafts; missing-fact handling; cold start; voice-note waits; supersede; notification throttle / digest / quiet hours / switch / failed slot; lost-job requeue |
| Decisions | approve as written / edited / whitespace-only; placeholder blocks and the draft stays pending, then edit and send; stale refused, override works; double submit = one message; two different submissions racing = one wins; every terminal status refused; closed window; paused sending; empty text; reject racing approve; regenerate refused when AI paused / nothing to answer (and rolled back); failed draft retried; `requestDraft`; unauthorized; validation; audit without the text |
| Injection | 31 attacks flagged, 25 ordinary messages not (incl. self-corrections and "care instructions"); zero-width and full-width tricks; no catastrophic backtracking; the customer's text cannot close a prompt tag; an injected model's answer (complied, no flag) still comes out flagged on a stored draft |
| **Mutation checks** | 32 mutants over decisions (10), queries (8), actions (5) and the injection defences (9), on top of the generation pipeline's earlier ones: all killed except two equivalent mutants (a reaction filter made redundant by the trigger-type list; a redundant "customer lines only" filter) |
| `pnpm test:ai` mechanics | with a stand-in model that behaves well: 7/7 pass; with one that behaves like an injected model: it fails exactly the three scenarios it should. **Never run against a real model.** |
| Production build in **Chromium** | the whole flow (see D-074), about 55 checks, no console errors; screenshots read by eye |

The browser found **five defects** the tests could not (D-074): the mobile grid overflowing (and a `scrollWidth` assertion that did not notice), the sticky
bar covering the draft text on a phone, the reason for a disabled button below the fold, a wrapping desktop bar, and a badge count that disagreed with
the page. It also found one **bad assumption of mine**: the schema requires a non-empty reply even for "no reply needed", so my fake model's empty
reply produced a `failed` draft (the failure path worked as designed, and the browser showed it).

## NOT verified (and what that risks), most important first

1. **Any real model.** Draft quality, whether the prompt makes the model use `[[placeholders]]` instead of guessing, whether it flags injections and
   `asks_if_bot` on its own, Luganda. `pnpm test:ai` and the evaluation exist to answer this; neither has been run.
2. **Real Meta and Telegram delivery of an approved draft.** The send path was proven in Phase 2 against a fake; the approval flow reuses it unchanged.
3. **Latency as the owner will feel it.** Debounce 25 s + a model call + the SSE refresh. Tunable (`DRAFT_DEBOUNCE_SECONDS`), but the right value is a feel.
4. **The injection detector is English-only** and a pattern list. It cannot read a Luganda attack, an image, or a paraphrase it has not seen.
5. **Accessibility** beyond roles, labels and live regions was not audited with a screen reader.

## What is weak (my own critique)

- **Live drafts are not fact-checked by code.** Only the evaluation runs the invented-number detector. A draft that says "UGX 60,000" when the profile
  says 50,000 is flagged by nothing except the model's own `missingFacts` (which a model that is confidently wrong will not fill). The owner is the
  check in this phase; the Phase 7 verifier is the planned second check. Adding the detector as a live warning is 20 lines and I did not, because a
  noisy warning trains the owner to ignore warnings.
- **`stale` is almost unreachable through normal use** (a new message supersedes the open draft in the same transaction), so the "Send anyway" path was
  exercised by inserting a message directly in SQL. It is a safety net for races, not a feature.
- **A draft replaced while the owner is editing it** turns read-only and the owner's text stays in the box for copying: nothing is lost, but it is not
  carried over to the new draft.
- **On a phone the conversation is open in the server-rendered HTML and collapses right after hydration**, so there can be a brief jump on first load.
- **The queue shows at most 200 drafts and has no search.** At under 500 messages a day that is theory.
- **`r` rejects with one key.** It is reversible (the customer is still waiting; "Draft a reply" asks again) and ignored while typing, but a stray press
  on a focused card rejects.
- **`scheduled` drafts** (autopilot) are handled only as far as the state machine allows (approvable; not rejectable here): Phase 7 finishes that.
- **`pnpm test:ai` thresholds (2 of 3) and its regexes are my guesses** for "grants no discount" / "denies being human". A failure needs reading, and a
  pass at 2/3 is not a clean bill.

## Commands

```
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
pnpm test:ai            # real model, opt-in
pnpm build && pnpm start & pnpm worker
```
