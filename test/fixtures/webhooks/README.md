# Webhook fixtures

Each `*.json` file is the exact body Meta would POST to `/api/webhooks/whatsapp`. `index.json` records, per file, how well its
shape is corroborated:

| confidence | meaning |
|---|---|
| `sdk-types` | matches the webhook type definitions of `@whatsapp-cloudapi/types` (a maintained open-source SDK) |
| `oss-fixture` | matches Coexistence fixtures published in `@better-zap/fixtures` |
| `constructed` | built from secondary documentation or to exercise a failure mode; **unverified against Meta** |

Meta's own documentation was not reachable when these were written (DECISIONS.md D-031). To harden the contract tests, paste
real payloads from Meta's webhook test tool into `real/` (any filename, `.json`); `test/unit/webhook-real-fixtures.test.ts`
runs every file there through the same invariants (valid envelope, every split item re-validates, replay-stable keys).

Identities shared by all fixtures: business number `256700000001` (phone number id `100000000000001`, matching the test env),
customers Amina (`256700123456`, BSUID `UG.13491208655302741918`), Brian (`256700654321`) and Kato (BSUID-only, username `kato_k`).
