# Phase 3 report: corpus, style, evaluation (and the draft prompt)

Date: 2026-10-05. Branch `claude/whatsapp-reply-assistant-bb49ug`. Spec phase 3 (+ D-060..D-067 in `DECISIONS.md`).

## Verdict

Phase 3 is **built and verified against everything a sandbox can verify**, and **not verified against the only things that matter here: your real
chat exports and a real model.** What now exists is the machinery (import, stages, retrieval, style extraction, the draft prompt, the measuring
stick) and the proof that the machinery does what it claims, including the safety properties (nothing the AI wrote is ever learned from, no customer
text reaches style extraction, an import can never open a reply window, a held-out reply never leaks into its own example set). What does **not**
exist is any answer to "does it sound like me?" The baseline evaluation the spec wants recorded **needs your Groq key**: `docs/ACCEPTANCE.md` step 17.
Until you have run it, treat the quality of drafts as unknown, and the Luganda quality as probably poor.

## What was built

| Area | What it does | Where |
|---|---|---|
| Export parser | Android + iOS, 12/24 h, U+202F / U+200E, multi-line, system lines, media and deleted markers, day/month order decided from the file (reported when ambiguous), group chats refused; DST-correct zone conversion | `src/lib/import/{parse-export,zoned-time}.ts` |
| Importer | Idempotent keys, never doubles WhatsApp-delivered messages, `imported` on both sides, new chats `resolved`, customers matched by phone or an earlier exact name, audit; `pnpm import:chats` | `src/lib/import/import-chat.ts`, `scripts/import-chats.ts` |
| Stages | opening / mid / closing / followup in TypeScript and SQL, proven equal on 60 random conversations | `src/lib/ai/{stages,fewshot-sql}.ts` |
| Few-shot retrieval | Pairs, eligible provenance only, same-stage quota, `ts_rank`, per-conversation cap, 24 h and held-out exclusion, identical replies dropped | `src/lib/ai/fewshot.ts` |
| Style extraction | Owner's own words only, stratified, >= 30, inactive versions, generic-phrase blocklist, worker + status, atomic activation | `src/lib/ai/style*.ts`, `worker/processors/style-extract.ts` |
| `/style` | Readable guide, versions, word-level diff against the active one, extract and activate | `src/app/(dashboard)/style`, `src/components/style` |
| Draft prompt + call | `draft-v1` per spec 9.2, schema per 9.3, context loader ("as of" time, exclusion list), code-side post-checks | `src/lib/ai/{draft,schemas}.ts`, `prompts/draft.ts` |
| Evaluation | Held-out pairs drafted as of their time, five metrics, paired-bootstrap comparison with the previous run, `eval_runs` for the Phase 7 gate; `pnpm eval:drafts` | `src/lib/eval/run-eval.ts`, `src/lib/metrics/*`, `scripts/eval-drafts.ts` |
| Profile editor | Names + business profile with a safe live preview (data, not HTML) | Settings, `src/lib/markdown.ts` |

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| `pnpm test` (unit) | **825 passed** (40 files) |
| `pnpm test:integration` (real Postgres 16 + Redis 7) | **615 passed** (33 files) |
| Exact import counts per fixture | Android 24 h, Android 12 h month-first with U+202F, iOS 24 h with LRM and attachments, iOS 12 h, phone-number author, group, contradictory and ambiguous dates; re-import = 0 new rows; a longer later export adds only the tail; refusals write nothing |
| Stage parity | SQL == TypeScript on 60 random conversations (all four stages occur) |
| Safety properties | the retriever never returns `ai_unedited` / `ai_autopilot` / placeholder / failed / non-text replies; style extraction never sends a customer message or an AI-written one; one active style guide always (also under racing activations); held-out replies and the stored summary never reach an evaluation draft; angle brackets in any prompt input are neutralised |
| **Mutation checks** | about 65 mutants across importer, SQL, retrieval, style, evaluation and draft context: all killed. Two survived the first pass (a version-number race my test could not provoke; an evaluation that quietly used today's summary) and now have tests that kill them |
| CLI end to end | `pnpm import:chats` (dry run, folder, group refusal, re-run), `pnpm eval:drafts` (dry run, 50-sample run, second run with the paired comparison) against the smoke database, fake model |
| Production build in **Chromium** | /style: real CLI import -> extract -> Version 1 -> activate -> Version 2 -> diff (added / removed items and words) -> activate; profile editor: live preview, XSS text shown as text, persistence, validation, phone tabs; no console errors, no horizontal scroll at 320 / 390 |

The browser found no new defect this time (the checks that failed on first run were my script's: a selector for list diffs, and a re-run against already-imported data).

## NOT verified (and what that risks), most important first

1. **Any real model.** Prompt wording, the structured-output schema on `openai/gpt-oss-120b`, whether `reasoning: low` is accepted (it is sent only to gpt-oss / qwen ids; unverified), draft quality, Luganda, how often facts are invented. The evaluation exists to answer this; it has not been run on a real model.
2. **Real export files.** The parser was built from the formats as I know them and fixtures I wrote. A different phone language ("<Média omis>", "image omise", translated call notices and system lines), another WhatsApp version, or Arabic-Indic digits may be misread: a translated media placeholder would be imported as ordinary text ("[Média omis]"), and a translated system line that happens to contain ": " as a message from a person. English exports are the tested case.
3. **Retrieval quality.** `ts_rank` with the `simple` configuration does no stemming ("dress" does not match "dresses") and weighs a common word like "you" like a rare one (ts_rank has no inverse-document-frequency). Whether the examples chosen are the right ones is unmeasured; the evaluation will tell you if it matters.
4. **The invented-fact detector is a regex.** It flags numbers and calendar words not in the profile or the conversation; it misses numbers written as words, wrong names and relative dates, and it will flag a harmless "2". Your Phase 7 gate (D-049) demands ZERO invented facts, so a noisy detector makes the gate hard to pass: you may find that rule too strict once you see real reports.
5. **Stage definition** is my reading of an ambiguous sentence (D-061).

## What is weak (my own critique)

- **An import that matches by name only does not join the live conversation with the same person.** Customers saved in your phone appear in exports by NAME, with no number. They become a name-only contact separate from the live contact that WhatsApp creates, and there is no merge screen. Style learning does not care (it reads every pair), but a returning customer's drafts will not see their imported history. Fix with `--contact <id>` per file, or tell me and I will build the merge (and a way to import a whole folder with a name -> contact table).
- **There is no "undo an import".** Imported rows are identifiable (`provenance = 'imported'`, `idempotency_key LIKE 'import:%'`) and can be deleted in SQL, but nothing in the product does it.
- **The pair set is recomputed on every retrieval** (window functions over all messages). Fine for tens of thousands of messages, wasteful beyond; a materialised view is the obvious step and is not built.
- **Settings is now six cards long.** It works and reads clearly on a phone; it is also becoming the junk drawer. Phase 6 should split it.
- **An evaluation costs 50 model calls and takes a few minutes**; nothing rate-limits it beyond three at a time.
- **Reports hold real customer messages.** They are git-ignored and say so, but they are files on your disk: a backup will carry them.
- **The first style guide is only as good as the first 400 messages**; with a short history the "no sentence more than twice" rule leaves little to learn from. It says how many messages it used.

## Commands

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration     # all four gates
pnpm import:chats ./exports --me "Your Name" [--dry-run]               # your past chats
pnpm eval:drafts [--samples 50] [--dry-run]                            # measure (needs GROQ_API_KEY)
```

## Decisions

D-060 .. D-067 in `DECISIONS.md` (import, stages, retrieval, style extraction, the draft prompt and call, the evaluation and its shipping rule, the profile editor, how it was verified).

## Next: Phase 4 (drafting and approvals)

Continuing without pausing (D-030). It builds directly on `loadDraftContext` / `generateDraftFromContext` and the send path's draft claim.
