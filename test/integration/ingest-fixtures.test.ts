import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { parseEnvelope } from '@/lib/whatsapp/webhook-schema';
import { allFixtureNames, fixtureJson } from '../helpers/fixtures';
import { count, ingestPayload, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();

/** Fixtures that are valid envelopes (the malformed-envelope ones are the webhook route's concern, not the processor's). */
const processable = allFixtureNames().filter((name) => parseEnvelope(fixtureJson(name)).ok);

const TABLES = ['contacts', 'conversations', 'messages', 'drafts', 'tasks', 'notifications', 'audit_log', 'webhook_events'] as const;

async function snapshot(admin: Sql): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) out[table] = await count(admin, table);
  return out;
}

describe('every webhook fixture, through the real pipeline', () => {
  it('has fixtures to run (guards against the glob silently matching nothing)', () => {
    expect(processable.length).toBeGreaterThan(40);
  });

  it.each(processable)('%s: processes cleanly, settles every event, and a forced reprocess changes nothing', async (name) => {
    const first = await ingestPayload(fixtureJson(name), { finalAttempt: true });
    expect(first.outcomes.every((outcome) => outcome === 'processed' || outcome === 'parked')).toBe(true);
    expect(await count(sql(), 'webhook_events', 'processed_at IS NULL')).toBe(0);
    const after = await snapshot(sql());

    // Meta replays it: nothing is even enqueued.
    expect((await ingestPayload(fixtureJson(name), { finalAttempt: true })).keys).toEqual([]);

    // The crash case: the transaction committed but processed_at was never stamped. Reprocessing must be a no-op.
    await sql()`UPDATE webhook_events SET processed_at = NULL`;
    await ingestPayload(fixtureJson(name), { finalAttempt: true });
    expect(await snapshot(sql())).toEqual(after);
  });

  it('all of them together in one database: every event settles and the data obeys its invariants', async () => {
    // (Replaying everything again is deliberately NOT asserted: identity events legitimately change who a record is, so a
    // second pass in a different order is not a replay. Each fixture's own replay is checked above, in isolation.)
    for (const name of processable) await ingestPayload(fixtureJson(name), { finalAttempt: true });
    expect(await count(sql(), 'webhook_events', 'processed_at IS NULL')).toBe(0);

    // Invariant: the window is exactly last customer message + 24h, and only customer messages make it.
    const windows = await sql()<Array<{ id: string; window_ok: boolean; derived_ok: boolean }>>`
      SELECT c.id,
             (c.last_inbound_at IS NULL AND c.window_expires_at IS NULL)
               OR c.window_expires_at = c.last_inbound_at + interval '24 hours' AS window_ok,
             c.last_inbound_at IS NOT DISTINCT FROM (
               SELECT max(m.occurred_at) FROM messages m
               WHERE m.conversation_id = c.id AND m.direction = 'inbound' AND m.provenance = 'customer' AND m.type <> 'reaction'
             ) AS derived_ok
      FROM conversations c`;
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.filter((row) => !row.window_ok || !row.derived_ok)).toEqual([]);

    // Invariant: provenance matches direction (customers' words are never labelled as the owner's, and vice versa).
    expect(await count(sql(), 'messages', `direction = 'inbound' AND provenance <> 'customer'`)).toBe(0);
    expect(await count(sql(), 'messages', `direction = 'outbound' AND provenance = 'customer'`)).toBe(0);
    // Invariant: nothing the owner sent from the phone or imported is ever labelled as AI output (style learning reads these).
    expect(await count(sql(), 'messages', `provenance IN ('ai_unedited','ai_edited','ai_autopilot')`)).toBe(0);
    // Invariant: every contact is identifiable.
    expect(await count(sql(), 'contacts', `bsuid IS NULL AND phone_e164 IS NULL AND source <> 'import_name'`)).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Real payloads from the owner's own Meta account (test/fixtures/webhooks/real/*.json). The parser-level checks live in
// test/unit/webhook-real-fixtures.test.ts; this is the whole pipeline: if Meta's real shape differs from what the handlers
// assume, the event gets PARKED (unparseable / unattributed / unresolved) and this is where that shows up.

const REAL_DIR = 'test/fixtures/webhooks/real';
const realFiles = existsSync(REAL_DIR) ? readdirSync(REAL_DIR).filter((file) => file.endsWith('.json')) : [];

/** A real payload carries the owner's real phone_number_id; the test environment's differs, so point it at ours. */
function pointAtTestNumber(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pointAtTestNumber);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, key === 'phone_number_id' && typeof inner === 'string' ? (process.env.WHATSAPP_PHONE_NUMBER_ID ?? inner) : pointAtTestNumber(inner)]),
    );
  }
  return value;
}

describe.skipIf(realFiles.length === 0)('real Meta payloads through the whole pipeline', () => {
  it.each(realFiles)('%s is processed, and not parked as something we could not understand', async (file) => {
    const payload = pointAtTestNumber(JSON.parse(readFileSync(join(REAL_DIR, file), 'utf8')));
    const result = await ingestPayload(payload, { finalAttempt: true });
    expect(result.outcomes.every((outcome) => outcome === 'processed' || outcome === 'parked')).toBe(true);

    const notes = await sql()<Array<{ kind: string; last_error: string | null }>>`SELECT kind, last_error FROM webhook_events WHERE last_error IS NOT NULL`;
    // These mean "Meta's real shape is not what we assumed": fix the parser or handler, then keep this payload as a regression test.
    const surprises = notes.filter(
      (row) => row.last_error?.startsWith('zod:') || ['echo_recipient_unknown', 'no_customer_identity', 'history_without_own_number', 'unknown_event_kind'].includes(row.last_error ?? '') || row.last_error?.startsWith('history_unattributed'),
    );
    expect(surprises, `${file}: ${JSON.stringify(notes)}`).toEqual([]);
    expect(await count(sql(), 'notifications', `kind = 'alert:webhook_unparseable'`), `${file} was parked as unparseable`).toBe(0);
  });
});
