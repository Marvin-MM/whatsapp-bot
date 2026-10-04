import { describe, expect, it } from 'vitest';
import { getIngestHealth } from '@/lib/dashboard/ingest-health';
import { getDb } from '@/lib/db';
import { NOW, count, ingestFixture, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();

describe('getIngestHealth', () => {
  it('reports "never connected" on an empty system', async () => {
    expect(await getIngestHealth(getDb(), NOW)).toEqual({
      lastReceivedAt: null,
      received24h: 0,
      unprocessed: 0,
      stuck: 0,
      settledWithNote24h: 0,
      history: { chunks: 0, lastChunkAt: null, ownerMessagesImported: 0, errors: 0 },
      alerts: [],
    });
  });

  it('counts what arrived, what is waiting, what is stuck, and what was set aside', async () => {
    await ingestFixture('text-message'); // processed cleanly
    await ingestFixture('group-message'); // processed, set aside with a reason
    await sql()`INSERT INTO webhook_events (id, dedupe_key, kind, payload, received_at) VALUES (gen_random_uuid(), 'msg:waiting', 'message', '{}'::jsonb, ${new Date(NOW.getTime() - 60_000)})`;
    await sql()`INSERT INTO webhook_events (id, dedupe_key, kind, payload, received_at) VALUES (gen_random_uuid(), 'msg:stuck', 'message', '{}'::jsonb, ${new Date(NOW.getTime() - 30 * 60_000)})`;

    // The fixtures were processed "now" in real time; ask as of a moment shortly after.
    const health = await getIngestHealth(getDb(), new Date());
    expect(health.received24h).toBe(4);
    expect(health.unprocessed).toBe(2);
    expect(health.stuck).toBeGreaterThanOrEqual(1);
    expect(health.settledWithNote24h).toBe(1);
    expect(health.lastReceivedAt).toBeInstanceOf(Date); // the Settings page formats it with Date methods
  });

  it('tracks the history import: chunks, errors, and the owner messages brought in', async () => {
    await ingestFixture('history-threads');
    await ingestFixture('history-error');
    const health = await getIngestHealth(getDb(), new Date());
    expect(health.history.chunks).toBe(1);
    expect(health.history.errors).toBe(1);
    expect(health.history.lastChunkAt).toBeInstanceOf(Date);
    expect(health.history.ownerMessagesImported).toBe(await count(sql(), 'messages', `provenance = 'imported'`));
    expect(health.history.ownerMessagesImported).toBe(1);
  });

  it('lists recent alerts newest first, without the "alert:" prefix, capped at eight', async () => {
    for (let i = 0; i < 10; i += 1) {
      await sql()`INSERT INTO notifications (id, kind, dedupe_key, sent_at) VALUES (gen_random_uuid(), ${`alert:kind_${i}`}, ${`k${i}`}, ${new Date(NOW.getTime() + i * 1000)})`;
    }
    await sql()`INSERT INTO notifications (id, kind, dedupe_key) VALUES (gen_random_uuid(), 'telegram:digest', 'not-an-alert')`;
    const { alerts } = await getIngestHealth(getDb(), NOW);
    expect(alerts).toHaveLength(8);
    expect(alerts[0]?.kind).toBe('kind_9');
    expect(alerts[0]?.at).toBeInstanceOf(Date);
    expect(alerts.every((alert) => !alert.kind.startsWith('alert:') && alert.kind.startsWith('kind_'))).toBe(true);
  });

  it('is unaffected by other tables (a sanity check that the counts are about webhooks)', async () => {
    const convo = await seedConversation(sql(), await seedContact(sql(), { phone: '+256700123456' }));
    await seedMessage(sql(), convo, {});
    expect((await getIngestHealth(getDb(), NOW)).received24h).toBe(0);
  });
});
