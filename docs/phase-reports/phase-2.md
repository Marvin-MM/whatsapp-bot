# Phase 2 report: manual sending, templates, kill switches, Telegram

Date: 2026-10-05. Branch `claude/whatsapp-reply-assistant-bb49ug`. Spec phase 2 (+ the corrections in `DECISIONS.md` D-050..D-059).

## Verdict

Phase 2 is **built and verified against everything a sandbox can verify**, and **not verified against Meta or Telegram**. Every guarantee about
the send path (never twice, never silently lost, never past the 24 h window, never while paused) is proven against mocks of their HTTP APIs, with
a simulated worker crash, and mutation-checked. What the mocks cannot prove: that Meta's real answers match the error table (written without
Meta's reference), that a BSUID-only customer can be addressed with `recipient`, and that the template list has the shape assumed. **Until
`docs/ACCEPTANCE.md` steps 10-12 are done, the first real sends are the real test.** Do them on a number you can afford to experiment with.

## What was built

| Area | What it does | Where |
|---|---|---|
| Pre-check | One pure function for every rule: paused, recipient, draft open / not stale, content (empty, 4,096, `[[placeholder]]`), the 24 h window (templates exempt) | `src/lib/send/precheck.ts` |
| Queue half | In the caller's transaction: lock conversation, idempotency, pre-check, insert `queued`, claim the draft; a refusal rolls everything back | `src/lib/send/send-message.ts` |
| Delivery half | Worker: re-check, stamp `send_started_at` atomically, HTTP outside any transaction, record the outcome; at most one send per message, ever | same file, `worker/processors/outbound-send.ts` |
| Meta client | Payloads (`to` or `recipient`, our id as callback data), outcome classification (accepted / retry / permanent / ambiguous), error table with readable messages | `src/lib/whatsapp/{send-api,errors}.ts` |
| Owner repairs | "It arrived" (`unknown -> sent`) and "send again" (original `failed`, one new message, key `resend:{id}`) | `markMessageSent`, `resendMessage` |
| Actions | `sendMessage`, `sendTemplate`, `markSent`, `resend`, `listTemplates`, notification settings, Telegram test, token check; read-only `ownerQuery`; `ActionRefusal` and `afterCommit` on `ownerAction` | `src/actions/*`, `src/lib/actions/owner-action-core.ts` |
| Templates | List from the WABA, supported-subset rules with reasons, value validation, exact components, Redis cache | `src/lib/whatsapp/templates{,-client}.ts` |
| Dashboard | Composer (Ctrl/Cmd+Enter, placeholder / length hints), template picker with live preview, live-ticking window badge, unconfirmed-message actions, kill switches, "Messages that need attention", token health, Telegram settings | `src/components/{send,settings,conversations}`, `src/app/(dashboard)/{conversations/[id],settings}` |
| Safety nets | `alerts-scan` (stale stamp -> `unknown`, lost job -> re-enqueue, template job lost -> fail, expiring windows -> one alert per window), `token-health`, `purge-payloads` (30 days, processed only) | `src/lib/ops/*`, `worker/{schedulers,processors/scheduled}.ts` |
| Telegram | Send-only, plain text, no bodies, quiet hours (critical bypass), `retry_after`, never throws; alert sink in the worker | `src/lib/notify/*` |

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| `pnpm test` (unit) | **725 passed** (32 files) |
| `pnpm test:integration` (real Postgres 16 + Redis 7) | **523 passed** (26 files) |
| Send core, specifically | 50 integration tests: double submit (sequential and concurrent), three workers racing on one message, window / pause at queue AND at send time, a pre-check refusal rolls the draft back, two approvals of one draft -> one message, **a worker crash after Meta accepted the message -> the re-run never sends again**, a delivery status that beats our wamid write, 429 retry clears the stamp (committed) and the retry sends once, final attempt gives up visibly, 5xx with / without a Meta body, connect-refused vs reset, timeout -> `unknown`, `to` vs `recipient`, callback data = our message id, template components |
| **Mutation checks** | 33 mutants over the send core, 24 over scans / purge / token check / Telegram, 3 over the `afterCommit` and refusal hooks. All killed except guards layered on purpose (they die only in combination; D-059) |
| Static guards | only `send-message.ts` imports `send-api.ts`, builds a Graph `/messages` URL or queues an outbound row (proven by adding a violating file) |
| Production build in **Chromium** against a fake Meta / Telegram | 53 checks pass: send, double click, Ctrl+Enter, timeout -> "not confirmed" -> both repair paths, Meta refusal wording, throttle retry, the window closing live without a reload, templates end to end, kill switch, Telegram test, token check, geometry at 320 / 390 / 1280 px, no console errors |

### Defects the tests did NOT catch and the browser did

1. The window badge said **"24h left" for a message that arrived 5 seconds ago**: the shared clock was floor-quantised, ran behind real time and over-promised. Fixed (the clock is refreshed on subscribe and every 10 s, never rounded back).
2. The reply box **hid the newest message**, then **floated mid-screen on a short thread**, then left a **gap above the tab bar** after scrolling. Fixed with a measured layout (pinned to the bottom, same place stuck or scrolled; asserted with geometry at three widths).
3. A tall template form covered most of the thread: capped at 55% of the screen and scrolls inside itself.
4. Our own internal reasons were shown to the owner as "(code resent)". Only Meta's numeric codes are shown now.

(Four more failures during the run were bugs in my browser script, not in the app, and are not counted: a selector that matched the wrong `<header>`, a `<input>` cannot hold a newline, a duplicate `nav`, and a stale second worker process from my own restart script that answered the throttled request.)

## NOT verified (and what that risks), most important first

1. **Meta's real error codes and wording** (D-051). Risk: a failure that should be retried is shown as permanent, or one that should not is retried. Mitigation built in: **an unknown code is never retried**, and ambiguous failures never are. Cost of a wrong table entry is a failed message the owner re-sends, never a duplicate.
2. **BSUID-only customers** (D-054): `recipient` instead of `to` is from SDK type definitions. If wrong, replies to username-only customers fail with Meta's error (shown to you).
3. **Templates**: the list shape, the `parameter_format` field, the value rules (error 132018) and "positional values must be numbered 1..n" are assumptions; anything unexpected is listed as unavailable rather than sent.
4. **The real clock path**: a worker killed by the OS at the worst possible moment is simulated, not performed. The design (stamp before the call, never resend a stamped message) is the same either way.
5. **Telegram**: delivery, `retry_after` behaviour and quiet-hours timing against the real Bot API.
6. **Docker** images are still unrun (no daemon here). The browser script and its fake Meta preload live in the scratchpad, not the repository (`playwright-core` is not an allowed dependency).

## What is weak (my own critique)

- **The thresholds are guesses**: 3 minutes before a stamp without an answer is parked as `unknown`, 5 minutes before a never-stamped message is re-queued, 20 s HTTP abort, 3 attempts / 5 s backoff. They are defensible, not measured.
- **A Telegram alert that fails to send is lost to Telegram** (logged, still in the dashboard). There is no retry queue for notifications: at this scale a missed buzz is cheaper than a second delivery system, but a Telegram outage during an incident is exactly when you would want it.
- **No throttle / digest for notifications yet** (D-056): it belongs to "draft ready", which does not exist until Phase 4. Today only alerts are sent and each is deduplicated, so there is nothing to throttle.
- **`resend` is text-only.** A template that came back `unknown` has to be sent again from the picker (its values are not stored on the row, by design).
- **Template parameters are text only** (D-055): no header media, no button values. Most utility templates are fine; marketing ones often are not.
- **The composer mirrors the rules in the browser** (length, placeholder, window). The server is the authority, but the two copies of the rules can drift: the shared constants are imported, the window function is shared, the precedence is not tested in the UI.
- **One retained quirk**: if Redis is down when you press Send, the message is committed and the job is not enqueued; the owner sees "Sending" and `alerts-scan` re-queues it within 5-10 minutes. The action returns success because the message exists.
- **`purge-payloads` removes a customer's raw payload, not their message.** Messages stay in `messages` until you delete them; there is no retention policy or "forget this customer" yet.

## Commands

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration     # all four gates
pnpm build && pnpm start && pnpm worker                                # production build; the worker MUST be running to send anything
```

## Decisions

D-050 .. D-059 in `DECISIONS.md` (the two halves of the send path, failure classes, `unknown` handling, idempotency, recipient addressing, templates, Telegram, scheduled jobs, composer and countdown, how it was verified).

## Next: Phase 3 (import, style, few-shot, evaluation, the draft prompt)

Continuing without pausing (D-030). Phase 3 does not depend on Phase 2's real-service checks.
