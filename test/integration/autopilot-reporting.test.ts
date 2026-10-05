import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDigest, sendAutopilotDigest } from '@/lib/autopilot/digest';
import { getDb } from '@/lib/db';
import { buildRange, getAutopilot } from '@/lib/metrics/analytics';
import { DAY, MIN, seedAutopilotWorld } from '../helpers/autopilot';
import { NOW, seedMessage, setupIngestHarness } from '../helpers/ingest';
import { jsonResponse, stubNetwork } from '../helpers/network';

const h = setupIngestHarness();
const sql = () => h.admin();
afterEach(() => vi.unstubAllGlobals());

const ok = (id = 9) => jsonResponse({ ok: true, result: { message_id: id } });
// NOW = 2026-10-04 08:46 UTC = 11:46 in Kampala. The digest is sent at 20:00 local = 17:00 UTC.
const EVENING = new Date('2026-10-04T17:00:00Z');
const TZ = 'Africa/Kampala';

async function activity(): Promise<{ conversationId: string }> {
  const world = await seedAutopilotWorld(sql(), { gate: false });
  const c = world.conversationId;
  // sent: two in the last 24 h, one three days ago, one that failed
  await seedMessage(sql(), c, { direction: 'outbound', provenance: 'ai_autopilot', occurredAt: new Date(EVENING.getTime() - 2 * 60 * MIN) });
  await seedMessage(sql(), c, { direction: 'outbound', provenance: 'ai_autopilot', occurredAt: new Date(EVENING.getTime() - 5 * 60 * MIN) });
  await seedMessage(sql(), c, { direction: 'outbound', provenance: 'ai_autopilot', occurredAt: new Date(EVENING.getTime() - 3 * DAY) });
  await seedMessage(sql(), c, { direction: 'outbound', provenance: 'ai_autopilot', status: 'failed', occurredAt: new Date(EVENING.getTime() - 1 * 60 * MIN) });
  // decided drafts (created in the last 24 h): 3 routed (2x quiet hours, 1x verifier), 2 silent, 1 scheduled-and-cancelled (a pass)
  const decision = (reasons: string[], eligible: boolean) => sql().json({ eligible, reasons, verifier: null });
  const draft = (reasons: string[], eligible: boolean, status = 'pending', at = new Date(EVENING.getTime() - 4 * 60 * MIN)) => sql()`
    INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status, autopilot_decision, created_at)
    VALUES (gen_random_uuid(), ${c}, '{}'::uuid[], 'x', 'x', 'question', 'a', 'm', 'p', ${status}, ${decision(reasons, eligible)}, ${at})`;
  await draft(['quiet_hours'], false);
  await draft(['quiet_hours', 'risk_flags'], false);
  await draft(['verifier_failed'], false);
  await draft(['no_reply_needed'], false, 'rejected');
  await draft(['no_reply_needed'], false, 'rejected');
  await draft([], true, 'pending'); // cancelled during its countdown: a pass, not a routing
  await draft(['gate_failed'], false, 'pending', new Date(EVENING.getTime() - 3 * DAY)); // old: outside the digest
  await sql()`INSERT INTO audit_log (id, actor, action, entity_type, entity_id, created_at) VALUES (gen_random_uuid(), 'owner', 'autopilot.cancel', 'draft', 'd1', ${new Date(EVENING.getTime() - 60 * MIN)})`;
  await sql()`INSERT INTO audit_log (id, actor, action, entity_type, entity_id, created_at) VALUES (gen_random_uuid(), 'autopilot', 'autopilot.demote', 'draft', 'd2', ${new Date(EVENING.getTime() - 90 * MIN)})`;
  await sql()`INSERT INTO audit_log (id, actor, action, entity_type, entity_id, created_at) VALUES (gen_random_uuid(), 'owner', 'autopilot.cancel', 'draft', 'old', ${new Date(EVENING.getTime() - 2 * DAY)})`;
  await sql()`UPDATE messages SET marked_bad_at = ${new Date(EVENING.getTime() - 30 * MIN)} WHERE conversation_id = ${c} AND provenance = 'ai_autopilot' AND status <> 'failed' AND occurred_at > ${new Date(EVENING.getTime() - 3 * 60 * MIN)}`;
  return { conversationId: c };
}

describe('the digest numbers (last 24 hours)', () => {
  it('counts sent, cancelled, routed (not the passes, not the "ok"s), silent, demoted and marked bad, and ranks the reasons', async () => {
    await activity();
    expect(await buildDigest(getDb(), EVENING)).toEqual({
      sent: 2,
      cancelled: 1,
      routed: 3,
      silent: 2,
      demoted: 1,
      markedBad: 1,
      topReasons: [
        { reason: 'quiet_hours', count: 2 },
        { reason: 'risk_flags', count: 1 },
        { reason: 'verifier_failed', count: 1 },
      ],
    });
  });
});

describe('sending the digest', () => {
  it('sends ONE message with the counts and a link; a second run the same day sends nothing', async () => {
    await activity();
    const net = stubNetwork({ telegram: () => ok(31) });
    expect(await sendAutopilotDigest(getDb(), EVENING)).toBe('sent');
    expect(net.telegram).toHaveLength(1);
    const text = String(net.telegram[0]?.body.text);
    expect(text).toContain('Sent automatically: 2');
    expect(text).toContain('Why they came to you: Quiet hours (2)');
    expect(text).toContain('/settings/autopilot');
    expect(text).not.toContain('We close'); // no message text, ever
    expect(await sendAutopilotDigest(getDb(), new Date(EVENING.getTime() + 60 * MIN))).toBe('skipped');
    expect(net.telegram).toHaveLength(1);
    // the next evening it is sent again
    expect(await sendAutopilotDigest(getDb(), new Date(EVENING.getTime() + DAY))).toBe('sent');
    expect(net.telegram).toHaveLength(2);
  });

  it('says nothing when autopilot is off and nothing happened', async () => {
    await seedAutopilotWorld(sql(), { gate: false, paused: true });
    const net = stubNetwork({ telegram: () => ok() });
    expect(await sendAutopilotDigest(getDb(), EVENING)).toBe('silent');
    expect(net.telegram).toHaveLength(0);
  });

  it('reports a quiet day when autopilot is ON (it confirms the thing is alive)', async () => {
    await seedAutopilotWorld(sql(), { gate: false, paused: false });
    const net = stubNetwork({ telegram: () => ok() });
    expect(await sendAutopilotDigest(getDb(), EVENING)).toBe('sent');
    expect(String(net.telegram[0]?.body.text)).toContain('Sent automatically: 0');
  });

  it('respects the owner\'s Telegram switch and quiet hours', async () => {
    await activity();
    const net = stubNetwork({ telegram: () => ok() });
    await sql()`UPDATE settings SET notify_telegram = false`;
    expect(await sendAutopilotDigest(getDb(), EVENING)).toBe('skipped');
    await sql()`UPDATE settings SET notify_telegram = true, quiet_hours = '{"start":"19:00","end":"22:00"}'::jsonb`;
    expect(await sendAutopilotDigest(getDb(), EVENING)).toBe('skipped');
    expect(net.telegram).toHaveLength(0);
  });

  it('a failed delivery frees the day: the next run tries again', async () => {
    await activity();
    let calls = 0;
    stubNetwork({ telegram: () => (++calls === 1 ? jsonResponse({ ok: false, error_code: 400, description: 'bad' }, 400) : ok(5)) });
    expect(await sendAutopilotDigest(getDb(), EVENING)).toBe('failed');
    expect(await sendAutopilotDigest(getDb(), new Date(EVENING.getTime() + 5 * MIN))).toBe('sent');
  });
});

describe('analytics: autopilot sent versus routed', () => {
  it('buckets by the owner\'s calendar day, ranks the reasons, and counts cancels, demotions and marks', async () => {
    await activity();
    const range = buildRange(EVENING, 7, TZ);
    const result = await getAutopilot(getDb(), range);

    const today = range.dates.at(-1);
    const threeDaysAgo = range.dates.at(-4);
    expect(result.byDay.find((d) => d.day === today)).toEqual({ day: today, sent: 2, routed: 3, silent: 2 });
    expect(result.byDay.find((d) => d.day === threeDaysAgo)).toEqual({ day: threeDaysAgo, sent: 1, routed: 1, silent: 0 });
    expect(result.byDay).toHaveLength(7);
    expect(result.totals).toEqual({ sent: 3, routed: 4, silent: 2, cancelled: 2, demoted: 1, markedBad: 1 });
    expect(result.topReasons).toEqual([
      { reason: 'quiet_hours', count: 2 },
      { reason: 'gate_failed', count: 1 },
      { reason: 'risk_flags', count: 1 },
      { reason: 'verifier_failed', count: 1 },
    ]);
  });

  it('is all zeros with no autopilot activity (no division, no gaps)', async () => {
    await seedAutopilotWorld(sql(), { gate: false });
    const result = await getAutopilot(getDb(), buildRange(NOW, 30, TZ));
    expect(result.byDay).toHaveLength(30);
    expect(result.totals).toEqual({ sent: 0, routed: 0, silent: 0, cancelled: 0, demoted: 0, markedBad: 0 });
    expect(result.topReasons).toEqual([]);
  });
});
