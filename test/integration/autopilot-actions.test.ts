import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModelProvider } from '@/lib/ai/models';
import { resetStrictCache } from '@/lib/ai/run';
import { runAutopilotForDraft } from '@/lib/autopilot/decide';
import { autopilotJobKey } from '@/lib/autopilot/jobs';
import { autopilotSend } from '@/lib/autopilot/send';
import { getDb } from '@/lib/db';
import { toJobId } from '@/lib/queue/enqueue';
import { getQueue } from '@/lib/queue/queues';
import { performSend } from '@/lib/send/send-message';
import { createEnrolledOwner, headersWith } from '../helpers/auth';
import { MIN, type World, seedAutopilotWorld } from '../helpers/autopilot';
import { FIXTURE } from '../helpers/fixtures';
import { chatCompletion } from '../helpers/groq';
import { NOW, seedContact, seedConversation, setupIngestHarness } from '../helpers/ingest';
import { jsonResponse, stubNetwork } from '../helpers/network';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const actions = await import('@/actions/autopilot');
const { setKillSwitch } = await import('@/actions/settings');

const h = setupIngestHarness();
const sql = () => h.admin();

beforeEach(async () => {
  resetStrictCache();
  resetModelProvider();
  requestHeaders.current = new Headers();
  await getQueue('autopilot-send').obliterate({ force: true });
  await getQueue('outbound-send').obliterate({ force: true });
});
afterEach(() => vi.unstubAllGlobals());

async function signedIn(): Promise<void> {
  requestHeaders.current = headersWith((await createEnrolledOwner()).cookie);
}
const verdict = () => chatCompletion(JSON.stringify({ unsupportedClaims: [], commitments: [], answersTheCustomer: true, toneRisk: false, verdict: 'pass' }));
const telegramOk = (request: { url: string }) => (request.url.endsWith('/answerCallbackQuery') ? jsonResponse({ ok: true, result: true }) : jsonResponse({ ok: true, result: { message_id: 4242 } }));
const accepted = (wamid: string) => jsonResponse({ messaging_product: 'whatsapp', contacts: [{ input: FIXTURE.amina.wa, wa_id: FIXTURE.amina.wa }], messages: [{ id: wamid }] });
let wamids = 0;
const network = () => stubNetwork({ groq: () => verdict(), telegram: telegramOk, graphSend: () => accepted(`wamid.ACT.${(wamids += 1)}`) });
const audit = (action: string) => sql()<{ actor: string; entity_type: string; entity_id: string; metadata: Record<string, unknown> }[]>`SELECT actor, entity_type, entity_id, metadata FROM audit_log WHERE action = ${action} ORDER BY created_at`;
const mode = async (id: string) => (await sql()<{ reply_mode: string; autopilot_until: Date | null }[]>`SELECT reply_mode, autopilot_until FROM conversations WHERE id = ${id}`)[0];
const status = async (id: string) => (await sql()<{ status: string }[]>`SELECT status FROM drafts WHERE id = ${id}`)[0]?.status;
const job = (draftId: string) => getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(draftId)));

async function scheduled(): Promise<World> {
  const world = await seedAutopilotWorld(sql());
  network();
  expect((await runAutopilotForDraft(getDb(), world.draftId, NOW)).kind).toBe('scheduled');
  return world;
}

/** A conversation that is in approval mode, in a system whose gate passes and whose autopilot is on. */
async function approvalConversation(): Promise<string> {
  await seedAutopilotWorld(sql(), { replyMode: 'approval' });
  const contact = await seedContact(sql(), { phone: '+256700555001', bsuid: 'UG.OTHER00000000000001', name: 'Brian' });
  return seedConversation(sql(), contact, { status: 'open' });
}

describe('every autopilot action needs the owner\'s session', () => {
  it.each([
    ['setReplyMode', () => actions.setReplyMode({ conversationId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', mode: 'approval' })],
    ['markAutopilotBad', () => actions.markAutopilotBad({ messageId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })],
    ['cancelAutopilotSend', () => actions.cancelAutopilotSend({ draftId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })],
    ['sendAutopilotNow', () => actions.sendAutopilotNow({ draftId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })],
    ['updateAutopilotSettings', () => actions.updateAutopilotSettings({ delaySeconds: 60, maxPerConversationPerHour: 3, maxPerDay: 30, maxConsecutive: 4, allowedIntents: ['question'], disclosure: 'x' })],
    ['the kill switch', () => setKillSwitch({ name: 'autopilot_paused', value: false })],
  ])('%s is refused without one', async (_name, call) => {
    expect(await call()).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });
});

describe('switching a conversation to autopilot (spec 10.1)', () => {
  it('is refused with the failing numbers while the gate fails', async () => {
    await signedIn();
    await seedAutopilotWorld(sql(), { gate: false, replyMode: 'approval' });
    const [conversation] = await sql()<{ id: string }[]>`SELECT id FROM conversations LIMIT 1`;
    const result = await actions.setReplyMode({ conversationId: conversation?.id, mode: 'autopilot' });
    expect(result).toMatchObject({ ok: false, error: { code: 'refused', reason: 'gate_failed' } });
    const message = result.ok ? '' : result.error.message;
    expect(message).toContain('No evaluation has been run yet');
    expect(message).toContain('0 approved so far');
    expect((await mode(conversation?.id ?? '' ))?.reply_mode).toBe('approval');
    expect(await audit('conversation.autopilot_on')).toHaveLength(0);
  });

  it('is refused while autopilot is paused, even when the checks pass', async () => {
    await signedIn();
    await seedAutopilotWorld(sql(), { paused: true, replyMode: 'approval' });
    const [conversation] = await sql()<{ id: string }[]>`SELECT id FROM conversations LIMIT 1`;
    expect(await actions.setReplyMode({ conversationId: conversation?.id, mode: 'autopilot' })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'paused' } });
  });

  it('works when the gate passes and autopilot is on, with an optional end date, and is audited', async () => {
    await signedIn();
    const id = await approvalConversation();
    const until = new Date(NOW.getTime() + 7 * 24 * 60 * MIN);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      const result = await actions.setReplyMode({ conversationId: id, mode: 'autopilot', until: until.toISOString() });
      expect(result).toEqual({ ok: true, data: { conversationId: id, mode: 'autopilot', until: until.toISOString() } });
    } finally {
      vi.useRealTimers();
    }
    const row = await mode(id);
    expect(row?.reply_mode).toBe('autopilot');
    expect(row?.autopilot_until?.toISOString()).toBe(until.toISOString());
    expect(await audit('conversation.autopilot_on')).toEqual([{ actor: 'owner', entity_type: 'conversation', entity_id: id, metadata: { previous: 'approval', until: until.toISOString(), cancelledDrafts: 0 } }]);
  });

  it.each([
    ['a date in the past', () => new Date(Date.now() - 60 * 1000)],
    ['a date more than a year away (a typo must not mean "forever")', () => new Date(Date.now() + 400 * 24 * 60 * 60 * 1000)],
  ])('refuses %s', async (_name, until) => {
    await signedIn();
    const id = await approvalConversation();
    const result = await actions.setReplyMode({ conversationId: id, mode: 'autopilot', until: until().toISOString() });
    expect(result).toMatchObject({ ok: false, error: { code: 'refused', reason: 'invalid_until' } });
    expect((await mode(id))?.reply_mode).toBe('approval');
  });

  it('rejects input that is not a conversation id or a mode', async () => {
    await signedIn();
    expect(await actions.setReplyMode({ conversationId: 'nope', mode: 'autopilot' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await actions.setReplyMode({ conversationId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', mode: 'yolo' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
});

describe('switching back to approval', () => {
  it('is always allowed, and a countdown running for the conversation stops: the draft goes back to the queue, the job is removed', async () => {
    await signedIn();
    const world = await scheduled();
    const result = await actions.setReplyMode({ conversationId: world.conversationId, mode: 'approval' });
    expect(result).toMatchObject({ ok: true, data: { mode: 'approval', until: null } });
    expect((await mode(world.conversationId))?.reply_mode).toBe('approval');
    expect(await status(world.draftId)).toBe('pending');
    expect(await job(world.draftId)).toBeUndefined();
    expect((await audit('conversation.autopilot_off'))[0]?.metadata).toMatchObject({ previous: 'autopilot', cancelledDrafts: 1 });
    // and a late run of the job does nothing
    expect((await autopilotSend(world.draftId, { now: new Date(NOW.getTime() + 3 * MIN) })).outcome).toBe('skipped');
  });

  it('works even when the gate has stopped passing and autopilot is paused (turning it off must never be blocked)', async () => {
    await signedIn();
    const world = await seedAutopilotWorld(sql(), { gate: false, paused: true });
    expect(await actions.setReplyMode({ conversationId: world.conversationId, mode: 'approval' })).toMatchObject({ ok: true });
  });
});

describe('the global autopilot switch', () => {
  it('cannot be turned on while the gate fails, and the refusal carries the numbers', async () => {
    await signedIn();
    await seedAutopilotWorld(sql(), { gate: false, paused: true });
    const result = await setKillSwitch({ name: 'autopilot_paused', value: false });
    expect(result).toMatchObject({ ok: false, error: { code: 'refused', reason: 'gate_failed' } });
    expect(result.ok ? '' : result.error.message).toContain('0 approved so far');
    const [row] = await sql()<{ autopilot_paused: boolean }[]>`SELECT autopilot_paused FROM settings`;
    expect(row?.autopilot_paused).toBe(true);
    expect(await audit('settings.kill_switch')).toHaveLength(0);
  });

  it('can be turned on once the gate passes', async () => {
    await signedIn();
    await seedAutopilotWorld(sql(), { paused: true });
    expect(await setKillSwitch({ name: 'autopilot_paused', value: false })).toMatchObject({ ok: true, data: { name: 'autopilot_paused', previous: true, value: false } });
    const [row] = await sql()<{ autopilot_paused: boolean }[]>`SELECT autopilot_paused FROM settings`;
    expect(row?.autopilot_paused).toBe(false);
  });

  it('pausing it stops every countdown: drafts go back to the queue, jobs are removed', async () => {
    await signedIn();
    const world = await scheduled();
    expect(await setKillSwitch({ name: 'autopilot_paused', value: true })).toMatchObject({ ok: true });
    expect(await status(world.draftId)).toBe('pending');
    expect(await job(world.draftId)).toBeUndefined();
  });

  it('the other two switches are not affected by the autopilot gate', async () => {
    await signedIn();
    await seedAutopilotWorld(sql(), { gate: false });
    expect(await setKillSwitch({ name: 'ai_paused', value: true })).toMatchObject({ ok: true });
    expect(await setKillSwitch({ name: 'sending_paused', value: true })).toMatchObject({ ok: true });
  });
});

describe('Mark bad', () => {
  async function autopilotMessage(world: World): Promise<string> {
    network();
    expect((await runAutopilotForDraft(getDb(), world.draftId, NOW)).kind).toBe('scheduled');
    const result = await autopilotSend(world.draftId, { now: new Date(NOW.getTime() + 3 * MIN) });
    if (result.outcome !== 'sent') throw new Error('not sent');
    await performSend(result.messageId, { finalAttempt: true, now: new Date(NOW.getTime() + 3 * MIN) });
    return result.messageId;
  }

  it('flags the automatic reply, takes the conversation back to approval mode, and audits both', async () => {
    await signedIn();
    const world = await seedAutopilotWorld(sql());
    const messageId = await autopilotMessage(world);
    expect((await mode(world.conversationId))?.reply_mode).toBe('autopilot');

    expect(await actions.markAutopilotBad({ messageId })).toEqual({ ok: true, data: { conversationId: world.conversationId, demoted: true } });
    const [message] = await sql()<{ marked_bad_at: Date | null }[]>`SELECT marked_bad_at FROM messages WHERE id = ${messageId}`;
    expect(message?.marked_bad_at).not.toBeNull();
    expect((await mode(world.conversationId))?.reply_mode).toBe('approval');
    expect(await audit('message.mark_bad')).toEqual([{ actor: 'owner', entity_type: 'message', entity_id: messageId, metadata: { conversationId: world.conversationId, alreadyMarked: false, demoted: true } }]);
    expect(await audit('autopilot.demote')).toEqual([{ actor: 'owner', entity_type: 'message', entity_id: messageId, metadata: { conversationId: world.conversationId, reason: 'marked_bad' } }]);
  });

  it('marking twice changes nothing more (the first time stays)', async () => {
    await signedIn();
    const world = await seedAutopilotWorld(sql());
    const messageId = await autopilotMessage(world);
    await actions.markAutopilotBad({ messageId });
    const [first] = await sql()<{ marked_bad_at: Date }[]>`SELECT marked_bad_at FROM messages WHERE id = ${messageId}`;
    expect(await actions.markAutopilotBad({ messageId })).toEqual({ ok: true, data: { conversationId: world.conversationId, demoted: false } });
    const [second] = await sql()<{ marked_bad_at: Date }[]>`SELECT marked_bad_at FROM messages WHERE id = ${messageId}`;
    expect(second?.marked_bad_at.toISOString()).toBe(first?.marked_bad_at.toISOString());
    expect(await audit('autopilot.demote')).toHaveLength(1);
  });

  it('only a reply the autopilot sent can be marked bad', async () => {
    await signedIn();
    const world = await seedAutopilotWorld(sql());
    const [manual] = await sql()<{ id: string }[]>`SELECT id FROM messages WHERE conversation_id = ${world.conversationId} AND provenance = 'owner_manual' LIMIT 1`;
    expect(await actions.markAutopilotBad({ messageId: manual?.id })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'not_autopilot_message' } });
    expect(await actions.markAutopilotBad({ messageId: world.questionId })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'not_autopilot_message' } });
    expect(await actions.markAutopilotBad({ messageId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'not_found' } });
    expect((await mode(world.conversationId))?.reply_mode).toBe('autopilot');
  });
});

describe('the dashboard\'s Cancel and Send now', () => {
  it('Cancel puts the draft back in the queue, removes the job, audits it as the dashboard; a second press is refused politely', async () => {
    await signedIn();
    const world = await scheduled();
    expect(await actions.cancelAutopilotSend({ draftId: world.draftId })).toEqual({ ok: true, data: { conversationId: world.conversationId } });
    expect(await status(world.draftId)).toBe('pending');
    expect(await job(world.draftId)).toBeUndefined();
    expect(await audit('autopilot.cancel')).toEqual([{ actor: 'owner', entity_type: 'draft', entity_id: world.draftId, metadata: { conversationId: world.conversationId, via: 'dashboard' } }]);
    expect(await actions.cancelAutopilotSend({ draftId: world.draftId })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'already_handled' } });
    expect(await audit('autopilot.cancel')).toHaveLength(1);
  });

  it('Send now promotes the countdown (the re-check still runs); a press on a draft that is not counting down is refused', async () => {
    await signedIn();
    const world = await scheduled();
    expect(await actions.sendAutopilotNow({ draftId: world.draftId })).toEqual({ ok: true, data: { conversationId: world.conversationId } });
    expect(await (await job(world.draftId))?.isWaiting()).toBe(true);
    expect(await audit('autopilot.send_now')).toEqual([{ actor: 'owner', entity_type: 'draft', entity_id: world.draftId, metadata: { conversationId: world.conversationId, via: 'dashboard' } }]);

    const [pending] = await sql()<{ id: string }[]>`
      INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status)
      VALUES (gen_random_uuid(), ${world.conversationId}, '{}'::uuid[], 'x', 'x', 'question', 'a', 'm', 'p', 'pending') RETURNING id`;
    expect(await actions.sendAutopilotNow({ draftId: pending?.id })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'already_handled' } });
    expect(await actions.sendAutopilotNow({ draftId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'not_found' } });
  });
});

describe('autopilot settings', () => {
  const valid = { delaySeconds: 90, maxPerConversationPerHour: 2, maxPerDay: 20, maxConsecutive: 3, allowedIntents: ['question', 'scheduling'], disclosure: '🤖 automatic reply' };

  it('saves the limits, the allowed kinds and the disclosure, and audits WHICH fields changed (never the wording)', async () => {
    await signedIn();
    await seedAutopilotWorld(sql());
    expect(await actions.updateAutopilotSettings(valid)).toEqual({ ok: true, data: { changed: ['delaySeconds', 'maxPerConversationPerHour', 'maxPerDay', 'maxConsecutive', 'allowedIntents', 'disclosure'] } });
    const [row] = await sql()<{ autopilot_delay_seconds: number; autopilot_max_per_day: number; autopilot_allowed_intents: string[]; autopilot_disclosure: string }[]>`SELECT * FROM settings`;
    expect(row).toMatchObject({ autopilot_delay_seconds: 90, autopilot_max_per_day: 20, autopilot_allowed_intents: ['question', 'scheduling'], autopilot_disclosure: '🤖 automatic reply' });
    const entry = (await audit('settings.autopilot'))[0];
    expect(entry?.metadata).toEqual({ changed: ['delaySeconds', 'maxPerConversationPerHour', 'maxPerDay', 'maxConsecutive', 'allowedIntents', 'disclosure'] });
    expect(JSON.stringify(entry)).not.toContain('automatic reply');
    // saving the same values again changes nothing
    expect(await actions.updateAutopilotSettings(valid)).toEqual({ ok: true, data: { changed: [] } });
  });

  it.each([
    ['an empty disclosure (customers must be told)', { disclosure: '' }],
    ['a blank disclosure', { disclosure: '   ' }],
    ['a disclosure that looks like a placeholder', { disclosure: 'sent by [[assistant]]' }],
    ['a disclosure that is too long', { disclosure: 'x'.repeat(201) }],
    ['complaints as an allowed kind', { allowedIntents: ['question', 'complaint'] }],
    ['asks_for_human as an allowed kind', { allowedIntents: ['asks_for_human'] }],
    ['an unknown kind', { allowedIntents: ['question', 'jokes'] }],
    ['a delay under 15 seconds (no time to cancel)', { delaySeconds: 5 }],
    ['a delay over 30 minutes', { delaySeconds: 1801 }],
    ['a limit of zero', { maxPerDay: 0 }],
    ['a streak limit of zero', { maxConsecutive: 0 }],
    ['an hourly limit that is not a whole number', { maxPerConversationPerHour: 1.5 }],
  ])('refuses %s and changes nothing', async (_name, change) => {
    await signedIn();
    await seedAutopilotWorld(sql());
    const before = await sql()`SELECT autopilot_delay_seconds, autopilot_disclosure, autopilot_allowed_intents FROM settings`;
    expect(await actions.updateAutopilotSettings({ ...valid, ...change })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await sql()`SELECT autopilot_delay_seconds, autopilot_disclosure, autopilot_allowed_intents FROM settings`).toEqual(before);
    expect(await audit('settings.autopilot')).toHaveLength(0);
  });
});

