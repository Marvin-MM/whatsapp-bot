# Real Meta payloads

Drop real webhook bodies from Meta's webhook test tool or from your own server logs here, one JSON file per payload (any filename
ending in `.json`). `pnpm test` runs each one through the same invariants as the built-in fixtures (valid envelope, every split item
re-validates against its stored-item schema, replay-stable dedupe keys), and `docs/ACCEPTANCE.md` lists which ones are most useful:
a text message, a voice note, a status, a reply sent from the phone app (an echo), and a history chunk.

**Remove customer phone numbers and names first** (replace them consistently) if this repository will ever be shared.
Never include access tokens or the app secret: a webhook body never contains them, but a copied request does.
