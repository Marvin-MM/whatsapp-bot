# Phase 7 report: autopilot (ships OFF)

Date: 2026-10-05. Branch `claude/whatsapp-reply-assistant-bb49ug`. Spec phase 7 (+ D-092..D-100 in `DECISIONS.md`). This is the last phase of the build.

## Verdict

Phase 7 is **built, tested and browser-verified against everything a sandbox can verify**, and **autopilot has never run against a real model, a real Telegram or a real
customer.** What exists: a live eligibility gate (nine checks, each with its numbers) that keeps autopilot unreachable until the owner's own replies have earned it; a pure
policy of ten rules plus one of our own; an independent checking model that fails on any doubt or error; a countdown the owner can cancel or hurry from Telegram, the
conversation, Approvals or Settings; a re-check immediately before sending and one send path; a safety net for a lost countdown; demotion, "Mark bad", a daily digest and
analytics. What does **not** exist is any evidence about how good the replies are: the checking prompt has never seen a real model, Luganda has never been tried, and the
gate has never been looked at with a real month of data. **Autopilot is off, and the right first use is `pnpm eval:drafts`, a few weeks of approving drafts, and
`docs/ACCEPTANCE.md` steps 35-42, in that order.** If the numbers never get there, approval mode is a legitimate permanent outcome.

## What was built

| Area | What it does | Where |
|---|---|---|
| The gate | Nine checks computed live (evaluation exists, fresh, 50+ samples, current prompt/model/style guide, median <= 0.30, 0 invented facts; 200+ approved drafts in 30 days with median <= 0.30 and p75 <= 0.50), each with its numbers; an autopilot-sent draft stores no distance so it cannot feed its own record | `src/lib/autopilot/eligibility.ts`, `metrics/analytics.ts` (`editDistanceSummary`) |
| The policy | One pure function per rule of spec 10.2 plus "never answer a voice note"; reports every failing rule; a re-check subset (1, 2, 6, 7, 8, 9) before sending | `src/lib/autopilot/policy.ts` |
| The checking model | Separate call, own model, never sees the drafting prompt; any error is a failure; code recomputes the verdict | `ai/prompts/verify.ts`, `autopilot/verify.ts` |
| Decide and schedule | After drafting: not on autopilot, demote, close an "ok", route with reasons, or `scheduled` + delayed job + one Telegram message; never throws, never sends | `autopilot/decide.ts`, `drafts/generate.ts` |
| The executor | Delayed `autopilot-send` (1 attempt): reload under the conversation lock, re-check, release through THE send path (`autopilot: true`), disclosure once per 24 h | `autopilot/send.ts`, `send/send-message.ts`, `worker/processors/autopilot-send.ts` |
| Safety net | A lost countdown restarts once after a minute and returns to the owner after a quarter of an hour; nothing is sent late | `autopilot/safety-net.ts` in `alerts-scan` |
| Telegram | Cancel / Send now buttons, a webhook (secret, then chat id, constant time; status codes chosen for Telegram's retries), message rewritten without buttons when settled, a registration script | `autopilot/telegram*.ts`, `app/api/webhooks/telegram`, `scripts/telegram-webhook.ts` |
| Control | Per-conversation mode (gated, optional end date), automatic demotion, "Mark bad", the global switch (gated; off stops every countdown), range-checked settings | `autopilot/{mode,demote,settings,controls}.ts`, `actions/autopilot.ts` |
| Reporting | 20:00 digest (once per local day, only when there is something to say), analytics (sent / handed to you / closed, cancelled, demoted, marked bad, top reasons) | `autopilot/digest.ts`, `metrics/analytics.ts` |
| Screens | Settings -> Autopilot, reply-mode panel, Mark bad, list badge, Approvals countdown / why-not, Overview notice, Analytics card | `app/(dashboard)/settings/autopilot`, `components/*` |
| Docs | D-092..D-100, README section, CLAUDE.md rules, ACCEPTANCE steps 35-42, production guide (webhook registration), this report | |

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| `pnpm test` (unit) | **1,120 passed** (57 files) |
| `pnpm test:integration` (real Postgres 16 + Redis 7) | **1,005 passed** (51 files); the autopilot suites are 175 tests |
| **Fresh clone** of the pushed branch (`1ceeb37`; the later commit only added documentation and four tests that read `DECISIONS.md`) | frozen-lockfile install, an EMPTY database migrated, typecheck, lint, 1,116 unit, 1,005 integration and a production build with an EMPTY environment all exit 0; web and worker start, both health URLs 200, owner seeded; every page toured in Chromium on desktop and a 390 px phone: **zero CSP violations**, no console errors beyond the 404 page's own 404, pages fit their width |
| The gate on a new install | Settings -> Autopilot shows 0 of 9, each check with the exact next step ("Run `pnpm eval:drafts`", "0 approved so far") |
| Chromium on the sandbox data (54 checks, desktop and phone) | the gate failing with the stand-in evaluation's real numbers (median 0.81, invented rate 0.14, 18 of 200 approved), then passing with tagged synthetic rows removed afterwards; turn on (confirmation), switch a conversation, countdown list and Cancel, rules form refusals, Mark bad, Analytics, turn off; no CSP violation, no console error, no horizontal overflow. I looked at the screenshots: it found Approvals still claiming "Nothing is sent without your approval" while autopilot was on |
| **Mutation checks** | **122 mutants** over decide (21), send (17), controls (10), Telegram intake (17), safety net (14), digest (14), mode (15), settings (14): 85 killed by the existing tests; 37 survived and were each triaged: **32 were real gaps** and are killed by 27 new tests, **5 are judged equivalent** (below). Part 1 had 36 over the pure policy and gate, all killed. A new guard test for `DECISIONS.md` was mutation-checked too |
| Unit and integration, per rule | one unit test per rule of spec 10.2 and for all-pass; every gate condition; integration: supersede and job removal, Cancel, repeated taps, forged callbacks, quiet-hours re-check, the consecutive cap and its reset, complaint demotion, disclosure once per 24 h, a paused autopilot at re-check, verifier error = fail, a lost countdown |

The five equivalent mutants: **AD14** (a line that only narrows a type; `decideAutopilot` returns before it for every verifier error), **AS16** (the error text for "window closed" in the send refusal map; rule 6's 10-minute margin refuses first), and **AD19, AS14, AN6**
(status guards on updates that already run under the conversation lock; they matter only against an owner action that does not take that lock, and no deterministic test can reach that race). "Killed" means at least one test failed with stop-at-first-failure; I did not check that each kill was by the test I meant.

## NOT verified (and what that risks), most important first

1. **Any real model, for anything autopilot does.** The checking prompt (`verify-v1`) has never been run; the ten scenarios in `test/ai/verify-behaviour.test.ts` have never been run; draft quality and Luganda are unmeasured. Risk: a checking model that passes a reply it should fail, which is the failure that costs a customer. `docs/ACCEPTANCE.md` step 35 is the first thing to do.
2. **Real Telegram.** Webhook registration, a real tap, the message rewrite, https on a real port. The route is tested with forged and malformed requests, never with Telegram. Risk: the buttons do nothing (the dashboard's Cancel and Send now still work).
3. **A real WhatsApp send of an automatic reply.** Meta is mocked at the fetch layer; the send path itself is the Phase 2 one.
4. **The gate on real data.** Nobody knows whether this owner reaches 200 approved drafts a month with a median edit distance under 0.30, or whether those thresholds mean what they were meant to.
5. **A real phone and a real server** (carried from Phase 6: Docker, Caddy, HSTS, `rclone`).

## What is weak (my own critique)

- **"0 invented facts" is narrower than it sounds.** The detector is a pattern match over prices, numbers and dates; a draft that invents "it is in stock" or "delivery is free" has no number to catch. The checking model is supposed to cover that, and it is unmeasured. And 0 out of 50 evaluation samples cannot rule out a true rate of about 6% (the rule of three at 95%).
- **Edit distance measures how much you changed a draft, not whether it was good.** An owner who approves without reading makes the record look perfect, and the gate cannot see approval fatigue. 200 approvals are not 200 reads.
- **The checker and the drafter are the same family**, and the checker is the smaller model (`gpt-oss-20b`): correlated blind spots, and weakest exactly where Luganda comes in.
- **The countdown is a second chance, not a safeguard.** It helps only if you are looking at your phone within the delay (default 2 minutes). The real protection is the gate, the rules and the checking model; the README says so now.
- **If the gate lapses while autopilot is on** (an old evaluation, a changed model), autopilot quietly becomes "everything comes to you" and the header still says "Autopilot on". The Approvals page says why on each draft and the digest counts them, but there is no alert. A follow-up worth doing.
- **Quiet hours are one setting for two things** (alerts and autopilot).
- **An "ok" or "thanks" in an autopilot conversation is closed without any reply**, by design; the customer gets no acknowledgement.
- **Recharts still forces `style-src-attr 'unsafe-inline'`** (carried from Phase 6).
- **Process slips of mine, in the open:** the scheduled-send Telegram message carries the AI's reply text (the one place a notification holds text; D-096, in the README's privacy section); a commit message (`caa2525`) carries a model name in its trailer, against the repository's rule, and was left rather than force-pushed; and `DECISIONS.md` had been silently corrupted by earlier edits of mine (four copies of two sections), found while appending to it, repaired, and now guarded by a test.

## Commands

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
pnpm eval:drafts                  # the evaluation the gate reads (needs GROQ_API_KEY)
pnpm test:ai                      # real draft, analysis and checking models (needs LLM_MODEL_VERIFY too)
pnpm telegram:webhook [--info]    # register the Telegram webhook (after deploying over https)
```

## Next

The build is complete: Phases 0-7 are done. What remains is yours and is listed in `docs/ACCEPTANCE.md` (steps 1-42): a real Meta number, the real model, Telegram, a real server and a real phone, and then weeks of approving drafts before the gate has anything to measure.
