# Acceptance checklist: what only you can verify

The build sandbox cannot reach Meta, Groq, Telegram or a Docker daemon, and has no real Luganda audio. Everything below was
tested with mocks at the network layer; this is the list of things that need the real services. Each phase appends its section.
Run them on your laptop, and **tell me what surprised you**: a surprise here is exactly the kind of bug the sandbox cannot find.

Legend: **Do** (what to run or click) / **Expect** (what should happen) / **If not** (what it means).

---

## Phase 1: ingest

### 0. Bring it up

**Do**
```bash
cp .env.example .env     # fill in the real values (see "Connecting WhatsApp" in the README)
docker compose up -d && pnpm install && pnpm db:migrate && pnpm seed:owner
pnpm dev                 # terminal 1
pnpm dev:worker          # terminal 2
```
**Expect** the dashboard at <http://localhost:3000>, sign-in with your password + authenticator code, header badges "AI on · Sending on · Autopilot off", a green "Live" dot.
**If not** `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` should all pass first: if one fails on your machine and not here, that is an environment difference worth reporting.

### 1. Meta handshake

**Do** Expose the webhook (`cloudflared tunnel --url http://localhost:3000`), set the callback URL and verify token in Meta's console (README, "Connecting WhatsApp"), subscribe to `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`, `user_id_update`, `account_update`.
**Expect** Meta accepts the URL (the handshake returns your challenge). Settings -> WhatsApp connection says "Last message from Meta: ..." after the first event.
**If not** a 403 on the handshake means the verify token differs from `WEBHOOK_VERIFY_TOKEN`; Meta saying the URL could not be verified with a 200 in your logs means a proxy is rewriting the query string.

Also check the guards from outside:
```bash
curl -i -X POST https://<host>/api/webhooks/whatsapp -d '{}'                                  # expect 401 (no signature)
curl -i -X POST https://<host>/api/webhooks/whatsapp -H 'X-Hub-Signature-256: sha256=00' -d '{}'   # expect 401
curl -i 'https://<host>/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1'   # expect 403
curl -i https://<host>/api/events ; curl -i https://<host>/api/media/0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee   # expect 401 both
```

### 2. A real message appears, fast

**Do** From another phone, message your business number: "Hello, do you have the blue dress in size M?".
**Expect** within ~3 s a new row at the top of **Chats** (no reload), "Needs reply", your text in the preview. Open it: the message, the time in **your** time zone, a window badge "Open · 23h 5x m left".
**If not** Settings -> "Waiting to process" > 0 and "Stuck over 10 min" > 0 means the worker is not running. Nothing there and no "Last message from Meta" means Meta is not reaching you (tunnel, subscription).

### 3. Voice notes (the part I cannot test)

**Do** Send three voice notes: (a) a clear sentence in **English**; (b) a sentence in **Luganda**; (c) a **mixed** Luganda/English one.
**Expect** (a) transcript shown with the label "Auto-transcribed · may contain errors", text matches what you said; (b) and (c) the notice "The automatic transcript was unreliable. Please listen to the voice message." with a working audio player, and **no transcript text anywhere**.
**If not** If (b) or (c) show a confident wrong transcript, tell me the language Whisper reported: the reliability rules in `src/lib/ai/transcribe.ts` need tightening. If (a) is marked unreliable, the thresholds are too strict. The goal is "never shown a fiction", not "always transcribed".

### 4. Real payloads (the highest-value check)

Meta's own pages were unreachable when this was built, so payload shapes were reconstructed (DECISIONS D-031). Please capture real ones:
**Do** In Meta's webhook test tool (or your server logs, `LOG_LEVEL=debug` does not log bodies by design: use the `webhook_events` table: `SELECT kind, payload FROM webhook_events ORDER BY received_at DESC LIMIT 20`) copy a **text**, a **voice note**, a **status**, a **reply you sent from the phone app**, and a **history chunk** into `test/fixtures/webhooks/real/*.json` (remove customer phone numbers and names first), then `pnpm test:integration`.
**Expect** all pass. A failure message tells you which assumption was wrong (`echo_recipient_unknown`, `history_unattributed`, `zod:` ...). **Send me the failing file and message**: fixing the handler and keeping the payload as a regression test is the point.
**If not** Specifically watch for an alert named `history_unattributed` or `echo_recipient_unknown` in Settings -> Recent alerts: it means the real shape does not name the customer on owner-side messages the way the threaded/`to` shapes do (D-039, D-040), and your own past replies are not being imported yet.

### 5. Coexistence: replies from your phone

**Do** Reply to that customer from the WhatsApp Business app on your phone.
**Expect** the reply appears in the thread within seconds, on the right side, labelled "Sent from your phone"; the conversation moves to "Waiting on customer"; the **window badge does not change** (only the customer's messages open it).
**If not** it appears under a different customer or not at all: `echo_recipient_unknown` alert (see step 4).

### 6. History import

**Do** After connecting the number, wait for Meta's history sync (it can take a while; it arrives in chunks).
**Expect** Settings -> History import: "Chunks received" grows, "Your messages imported" grows, conversations appear under the **Resolved** filter with their old messages; no drafts, no window badges "Open".
**If not** "Sync errors" > 0 or an alert `history_sync_error`: the customer or the account opted out of history sharing (Meta error codes are in the alert's `webhook_events` row). "Your messages imported" staying 0 while chunks arrive is the `history_unattributed` case above.

### 7. Things that should NOT happen

- A reaction (👍) to a message **does not** reorder the list, change "Needs reply", or open a window.
- A message the customer **deletes for everyone** shows "This message was deleted" and its text is gone from search.
- A **group** message is ignored (Settings "Set aside" goes up by one).
- A photo you receive shows "Downloading…" for a moment, then the picture. If it stays "Downloading…", the worker cannot reach Meta: check `WHATSAPP_ACCESS_TOKEN` (it must be a **System User** token; a Settings alert `whatsapp token invalid` confirms it).

### 8. Sign off

Tell me: which steps passed, which surprised you, and attach any failing `real/*.json`. Phase 2 (sending) starts from there.
