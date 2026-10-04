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
