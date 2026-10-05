import { describe, expect, it } from 'vitest';
import { getAutopilotOverview } from '@/lib/autopilot/overview';
import { getAutopilotStatus } from '@/lib/autopilot/status';
import { getDb } from '@/lib/db';
import { countOpenDrafts, countScheduledDrafts } from '@/lib/drafts/queries';
import { DAY, MIN, seedAutopilotWorld } from '../helpers/autopilot';
import { NOW, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();

const decision = () => sql().json({ eligible: true, reasons: [], verifier: { verdict: 'pass', unsupportedClaims: [], commitments: [], answersTheCustomer: true, toneRisk: false } });

async function scheduledDraft(conversationId: string, at: Date): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status, scheduled_send_at, autopilot_decision)
    VALUES (gen_random_uuid(), ${conversationId}, '{}'::uuid[], 'x', 'x', 'question', 'a', 'm', 'p', 'scheduled', ${at}, ${decision()})
    RETURNING id`;
  if (!row) throw new Error('seed failed');
  return row.id;
}

describe('Settings -> Autopilot: what is configured and what is going on', () => {
  it('reads the stored rules, and falls back to the defaults when there is no settings row', async () => {
    const empty = await getAutopilotOverview(getDb());
    expect(empty.settings).toEqual({ delaySeconds: 120, maxPerConversationPerHour: 3, maxPerDay: 30, maxConsecutive: 4, allowedIntents: ['chit_chat', 'question'], disclosure: '(sent by my assistant)' });

    await sql()`INSERT INTO settings (id, autopilot_delay_seconds, autopilot_max_per_day, autopilot_allowed_intents, autopilot_disclosure)
      VALUES (1, 300, 12, '{question,scheduling}', '(automatic reply)')
      ON CONFLICT (id) DO UPDATE SET autopilot_delay_seconds = 300, autopilot_max_per_day = 12, autopilot_allowed_intents = '{question,scheduling}', autopilot_disclosure = '(automatic reply)'`;
    const stored = await getAutopilotOverview(getDb());
    expect(stored.settings).toMatchObject({ delaySeconds: 300, maxPerDay: 12, allowedIntents: ['question', 'scheduling'], disclosure: '(automatic reply)' });
  });

  it('never shows an intent the form cannot offer as allowed (a complaint can never be allowed)', async () => {
    await sql()`INSERT INTO settings (id, autopilot_allowed_intents) VALUES (1, '{question,complaint,asks_for_human}')
      ON CONFLICT (id) DO UPDATE SET autopilot_allowed_intents = '{question,complaint,asks_for_human}'`;
    expect((await getAutopilotOverview(getDb())).settings.allowedIntents).toEqual(['question']);
  });

  it('lists the conversations on autopilot, the countdowns (soonest first) and the replies marked bad, with the customer shown by name', async () => {
    const world = await seedAutopilotWorld(sql(), { gate: false });
    const other = await seedConversation(sql(), await seedContact(sql(), { phone: '+256700999777', bsuid: 'UG.OVERVIEW000000000001', name: 'Brenda' }), { status: 'waiting_on_me' });
    const approvalOnly = await seedConversation(sql(), await seedContact(sql(), { phone: '+256700999778', bsuid: 'UG.OVERVIEW000000000002', name: 'Not on autopilot' }), { status: 'open' });
    await sql()`UPDATE conversations SET reply_mode = 'autopilot', autopilot_until = ${new Date(NOW.getTime() + DAY)} WHERE id = ${other}`;

    const later = await scheduledDraft(other, new Date(NOW.getTime() + 10 * MIN));
    const sooner = await scheduledDraft(world.conversationId, new Date(NOW.getTime() + 2 * MIN));
    await sql()`UPDATE drafts SET status = 'pending' WHERE id = ${world.draftId}`;

    const bad = await seedMessage(sql(), world.conversationId, { direction: 'outbound', provenance: 'ai_autopilot', occurredAt: new Date(NOW.getTime() - 60 * MIN) });
    const fine = await seedMessage(sql(), world.conversationId, { direction: 'outbound', provenance: 'ai_autopilot', occurredAt: new Date(NOW.getTime() - 30 * MIN) });
    const manual = await seedMessage(sql(), world.conversationId, { direction: 'outbound', provenance: 'owner_manual', occurredAt: new Date(NOW.getTime() - 20 * MIN) });
    await sql()`UPDATE messages SET marked_bad_at = ${new Date(NOW.getTime() - 10 * MIN)} WHERE id IN (${bad}, ${manual})`;

    const overview = await getAutopilotOverview(getDb());
    expect(overview.conversations.map((item) => item.name).sort()).toEqual(['Amina', 'Brenda']);
    expect(overview.conversations.find((item) => item.conversationId === other)?.until?.toISOString()).toBe(new Date(NOW.getTime() + DAY).toISOString());
    expect(overview.conversations.find((item) => item.conversationId === approvalOnly)).toBeUndefined();
    expect(overview.scheduled.map((item) => item.draftId)).toEqual([sooner, later]);
    expect(overview.scheduled[0]).toMatchObject({ name: 'Amina', conversationId: world.conversationId });
    // Only the autopilot's own reply that the owner flagged: not an unflagged one, not a hand-written one someone flagged by other means.
    expect(overview.markedBad.map((item) => item.messageId)).toEqual([bad]);
    expect(overview.markedBad[0]?.name).toBe('Amina');
    expect(fine).not.toBe(bad);
  });
});

describe('the status the screens share', () => {
  it('is paused and ineligible with the failing numbers on an empty system, and is eligible once the record is there', async () => {
    const before = await getAutopilotStatus(getDb(), NOW);
    expect(before.paused).toBe(true);
    expect(before.eligible).toBe(false);
    expect(before.checks).toHaveLength(9);
    expect(before.failed.length).toBeGreaterThan(0);
    expect(before.failed.every((check) => check.detail.length > 0)).toBe(true);

    await seedAutopilotWorld(sql(), { paused: true });
    const after = await getAutopilotStatus(getDb(), NOW);
    expect(after).toMatchObject({ paused: true, eligible: true, failed: [] });
  });
});

describe('counting drafts', () => {
  it('separates the drafts counting down from the ones that wait for the owner', async () => {
    const world = await seedAutopilotWorld(sql(), { gate: false });
    expect(await countScheduledDrafts(getDb())).toBe(0);
    expect(await countOpenDrafts(getDb())).toBe(1);
    await scheduledDraft(world.conversationId, new Date(NOW.getTime() + 5 * MIN));
    expect(await countScheduledDrafts(getDb())).toBe(1);
    expect(await countOpenDrafts(getDb())).toBe(2);
  });
});
