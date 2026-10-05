import { Worker } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModelProvider } from '@/lib/ai/models';
import { resetStrictCache } from '@/lib/ai/run';
import { runAutopilotForDraft } from '@/lib/autopilot/decide';
import { autopilotJobKey } from '@/lib/autopilot/jobs';
import { autopilotSend } from '@/lib/autopilot/send';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { toJobId } from '@/lib/queue/enqueue';
import { getQueue } from '@/lib/queue/queues';
import { performSend } from '@/lib/send/send-message';
import { MIN, type World, seedAutopilotWorld } from '../helpers/autopilot';
import { FIXTURE } from '../helpers/fixtures';
import { chatCompletion } from '../helpers/groq';
import { HOUR, NOW, count, ingestPayload, seedMessage, setupIngestHarness } from '../helpers/ingest';
import { jsonResponse, stubNetwork } from '../helpers/network';
import { createTestRedis } from '../helpers/redis';

const h = setupIngestHarness();
const sql = () => h.admin();

beforeEach(async () => {
  resetStrictCache();
  resetModelProvider();
  await getQueue('autopilot-send').obliterate({ force: true });
  await getQueue('outbound-send').obliterate({ force: true });
});
afterEach(() => vi.unstubAllGlobals());

const verdict = () => chatCompletion(JSON.stringify({ unsupportedClaims: [], commitments: [], answersTheCustomer: true, toneRisk: false, verdict: 'pass' }));
const telegramOk = (request: { url: string }) => (request.url.endsWith('/answerCallbackQuery') ? jsonResponse({ ok: true, result: true }) : jsonResponse({ ok: true, result: { message_id: 4242 } }));
const accepted = (wamid: string) => jsonResponse({ messaging_product: 'whatsapp', contacts: [{ input: FIXTURE.amina.wa, wa_id: FIXTURE.amina.wa }], messages: [{ id: wamid }] });
let wamidCounter = 0;
const network = () => stubNetwork({ groq: () => verdict(), telegram: telegramOk, graphSend: () => accepted(`wamid.AUTO.${(wamidCounter += 1)}`) });
const edits = (net: ReturnType<typeof network>) => net.telegram.filter((request) => request.url.endsWith('/editMessageText'));
const pings = (net: ReturnType<typeof network>) => net.telegram.filter((request) => request.url.endsWith('/sendMessage'));

const draftRow = async (id: string) => {
  const [row] = await sql()<{ status: string; final_message_id: string | null; approved_at: Date | null; content: string; scheduled_send_at: Date | null; autopilot_decision: { eligible: boolean; reasons: string[] } | null }[]>`
    SELECT status, final_message_id, approved_at, content, scheduled_send_at, autopilot_decision FROM drafts WHERE id = ${id}`;
  if (!row) throw new Error('no draft');
  return row;
};
const messagesOf = (conversationId: string) => sql()<{ id: string; provenance: string; status: string; content: string; idempotency_key: string | null }[]>`SELECT id, provenance, status, content, idempotency_key FROM messages WHERE conversation_id = ${conversationId} AND direction = 'outbound' AND provenance = 'ai_autopilot' ORDER BY occurred_at`;
const audits = (action: string) => sql()<{ actor: string; metadata: Record<string, unknown> }[]>`SELECT actor, metadata FROM audit_log WHERE action = ${action} ORDER BY created_at`;
const AFTER = new Date(NOW.getTime() + 2 * MIN + 1000);

/** A scheduled draft: decided now, counting down. */
async function scheduled(options: Parameters<typeof seedAutopilotWorld>[1] = {}): Promise<{ world: World; net: ReturnType<typeof network> }> {
  const world = await seedAutopilotWorld(sql(), options);
  const net = network();
  const outcome = await runAutopilotForDraft(getDb(), world.draftId, NOW);
  expect(outcome.kind).toBe('scheduled');
  return { world, net };
}

describe('the countdown ends: the reply is sent through THE send path', () => {
  it('queues one outbound message with provenance ai_autopilot and the disclosure line, closes the draft, hands the message to the worker, and says so on the phone', async () => {
    const { world, net } = await scheduled();
    const result = await autopilotSend(world.draftId, { now: AFTER });
    expect(result.outcome).toBe('sent');

    const sent = await messagesOf(world.conversationId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ provenance: 'ai_autopilot', status: 'queued', content: 'We close at 6pm 🙏\n\n(sent by my assistant)', idempotency_key: `autopilot:${world.draftId}` });

    const draft = await draftRow(world.draftId);
    expect(draft.status).toBe('approved');
    expect(draft.final_message_id).toBe(sent[0]?.id);
    expect(draft.approved_at).not.toBeNull();
    expect(draft.content).toBe('We close at 6pm 🙏\n\n(sent by my assistant)');

    expect(await audits('autopilot.send')).toEqual([{ actor: 'autopilot', metadata: { draftId: world.draftId, conversationId: world.conversationId, disclosure: true } }]);

    const outbound = await getQueue('outbound-send').getJob(toJobId(`send:${sent[0]?.id}`));
    expect(outbound?.data).toMatchObject({ messageId: sent[0]?.id });

    const events = await h.events();
    expect(events.map((event) => event.type)).toContain('autopilot:sent');
    const retired = edits(net)[0];
    expect(String(retired?.body.text)).toContain('Sent.');
    expect(retired?.body.reply_markup).toEqual({ inline_keyboard: [] });
    // the countdown's own job is gone with it
    expect(await getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(world.draftId)))).toBeUndefined();
  });

  it('after Meta accepts it, the consecutive-reply counter goes up; a manual reply from the owner resets it', async () => {
    const { world } = await scheduled();
    await autopilotSend(world.draftId, { now: AFTER });
    const [message] = await messagesOf(world.conversationId);
    expect(await performSend(message?.id ?? '', { finalAttempt: true, now: AFTER })).toBe('sent');
    const [after] = await sql()<{ consecutive_auto_replies: number }[]>`SELECT consecutive_auto_replies FROM conversations WHERE id = ${world.conversationId}`;
    expect(after?.consecutive_auto_replies).toBe(1);

    // The owner writes by hand: the machine's streak is over.
    await ingestPayload(echoOf());
    const [reset] = await sql()<{ consecutive_auto_replies: number }[]>`SELECT consecutive_auto_replies FROM conversations WHERE id = ${world.conversationId}`;
    expect(reset?.consecutive_auto_replies).toBe(0);
  });

  it('is idempotent: a second run (a duplicate job, a retried worker) sends nothing more', async () => {
    const { world } = await scheduled();
    await autopilotSend(world.draftId, { now: AFTER });
    expect((await autopilotSend(world.draftId, { now: AFTER })).outcome).toBe('skipped');
    expect(await messagesOf(world.conversationId)).toHaveLength(1);
  });

  it('does nothing for a draft that is not scheduled (never releases a pending one)', async () => {
    const world = await seedAutopilotWorld(sql());
    network();
    expect((await autopilotSend(world.draftId, { now: AFTER })).outcome).toBe('skipped');
    expect(await messagesOf(world.conversationId)).toHaveLength(0);
    expect((await draftRow(world.draftId)).status).toBe('pending');
  });
});

describe('the disclosure line: once per 24 hours', () => {
  it('goes on the first automatic reply, not on the next one an hour later, and again after 24 hours', async () => {
    const { world } = await scheduled();
    await autopilotSend(world.draftId, { now: AFTER });
    const second = await nextDraft(world, 'We are open until 6pm.');
    await sql()`UPDATE conversations SET consecutive_auto_replies = 0 WHERE id = ${world.conversationId}`;
    await sql()`UPDATE drafts SET status = 'scheduled', scheduled_send_at = ${NOW} WHERE id = ${second}`;
    await autopilotSend(second, { now: new Date(AFTER.getTime() + HOUR) });
    const sent = await messagesOf(world.conversationId);
    expect(sent.map((message) => message.content.includes('(sent by my assistant)'))).toEqual([true, false]);

    const third = await nextDraft(world, 'Come by any time.');
    await sql()`UPDATE drafts SET status = 'scheduled', scheduled_send_at = ${NOW} WHERE id = ${third}`;
    // 25 hours after the first one (and the second is 24 hours old at that point too): the line is due again.
    await sql()`UPDATE messages SET occurred_at = occurred_at - interval '26 hours' WHERE conversation_id = ${world.conversationId} AND provenance = 'ai_autopilot'`;
    await autopilotSend(third, { now: new Date(AFTER.getTime() + 2 * HOUR) });
    const all = await messagesOf(world.conversationId);
    expect(all.at(-1)?.content).toContain('(sent by my assistant)');
  });

  it('uses the owner\'s own wording', async () => {
    const { world } = await scheduled({ disclosure: '🤖 automatic reply' });
    await autopilotSend(world.draftId, { now: AFTER });
    expect((await messagesOf(world.conversationId))[0]?.content).toBe('We close at 6pm 🙏\n\n🤖 automatic reply');
  });
});

describe('the re-check just before sending (rules 1, 2, 6, 7, 8, 9)', () => {
  const cases: Array<[string, (world: World) => Promise<void>, string[], Date?]> = [
    ['the conversation was switched back to approval mode', async (w) => void (await sql()`UPDATE conversations SET reply_mode = 'approval' WHERE id = ${w.conversationId}`), ['not_autopilot_mode']],
    ['autopilot was paused (spec: autopilot_paused stops scheduled sends at the re-check)', async () => void (await sql()`UPDATE settings SET autopilot_paused = true`), ['autopilot_paused']],
    ['the eligibility gate stopped passing', async () => void (await sql()`DELETE FROM eval_runs`), ['gate_failed']],
    ['the window is about to close', async (w) => void (await sql()`UPDATE conversations SET window_expires_at = ${new Date(AFTER.getTime() + 5 * MIN)} WHERE id = ${w.conversationId}`), ['window_closing']],
    ['the day\'s limit was reached by other replies', async (w) => {
      await sql()`UPDATE settings SET autopilot_max_per_day = 2`;
      for (let i = 0; i < 2; i += 1) await seedMessage(sql(), w.conversationId, { direction: 'outbound', provenance: 'ai_autopilot', occurredAt: new Date(NOW.getTime() - (90 + i) * MIN) });
    }, ['rate_limit_daily']],
    ['the streak limit was reached', async (w) => void (await sql()`UPDATE conversations SET consecutive_auto_replies = 4 WHERE id = ${w.conversationId}`), ['consecutive_cap']],
    ['the delay ran into quiet hours (23:00 in Kampala)', async (w) => void (await sql()`UPDATE conversations SET window_expires_at = ${new Date('2026-10-05T20:00:00Z')} WHERE id = ${w.conversationId}`), ['quiet_hours'], new Date('2026-10-04T20:00:00Z')],
  ];

  it.each(cases)('%s: the draft goes back to the approval queue with the reason, nothing is sent, the owner is told the ordinary way', async (_name, change, reasons, at) => {
    const { world, net } = await scheduled();
    await change(world);
    const before = pings(net).length;
    const result = await autopilotSend(world.draftId, { now: at ?? AFTER });
    expect(result).toEqual({ outcome: 'routed', reasons });

    const draft = await draftRow(world.draftId);
    expect(draft.status).toBe('pending');
    expect(draft.scheduled_send_at).toBeNull();
    expect(draft.autopilot_decision).toMatchObject({ eligible: false, reasons });
    expect(await count(sql(), 'messages', `idempotency_key = 'autopilot:${world.draftId}'`)).toBe(0);
    expect(await audits('autopilot.recheck_failed')).toEqual([{ actor: 'autopilot', metadata: { conversationId: world.conversationId, reasons } }]);
    // the autopilot message loses its buttons and says why
    expect(String(edits(net)[0]?.body.text)).toContain('Not sent:');
    // the ordinary "ready for approval" ping goes out, except in quiet hours, when the phone stays silent (the draft waits in Approvals)
    if (reasons.includes('quiet_hours')) {
      expect(pings(net).length).toBe(before);
    } else {
      expect(pings(net).length).toBe(before + 1);
      expect(String(pings(net).at(-1)?.body.text)).toContain('ready for your approval');
    }
    expect(await getQueue('outbound-send').getJobCounts('waiting', 'delayed')).toEqual({ waiting: 0, delayed: 0 });
  });

  it('sending is paused (the send path\'s own check has the last word): back to approval, with that reason', async () => {
    const { world } = await scheduled();
    await sql()`UPDATE settings SET sending_paused = true`;
    expect(await autopilotSend(world.draftId, { now: AFTER })).toEqual({ outcome: 'routed', reasons: ['sending_paused'] });
    expect((await draftRow(world.draftId)).status).toBe('pending');
    expect(await messagesOf(world.conversationId)).toHaveLength(0);
  });

  it('the customer wrote again but the draft was not superseded yet (a race): the send path refuses it as stale, back to approval', async () => {
    const { world } = await scheduled();
    await seedMessage(sql(), world.conversationId, { direction: 'inbound', content: 'wait, one more thing', occurredAt: new Date(NOW.getTime() + 30 * 1000) });
    expect(await autopilotSend(world.draftId, { now: AFTER })).toEqual({ outcome: 'routed', reasons: ['draft_stale'] });
    expect(await messagesOf(world.conversationId)).toHaveLength(0);
  });

  it('a refusal rolls back whatever the send path had started: no half-written message', async () => {
    const { world } = await scheduled();
    await sql()`UPDATE settings SET sending_paused = true`;
    await autopilotSend(world.draftId, { now: AFTER });
    expect(await count(sql(), 'messages', `conversation_id = '${world.conversationId}' AND status = 'queued'`)).toBe(0);
  });
});

describe('a scheduled draft whose conversation moved on', () => {
  it('a new customer message supersedes it, ends its countdown and closes its phone message; a late run of the job finds nothing to send', async () => {
    const { world, net } = await scheduled();
    expect(await getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(world.draftId)))).toBeDefined();

    await ingestPayload(customerMessage('wamid.AUTO.NEWQ', 'also, do you deliver?'));
    expect((await draftRow(world.draftId)).status).toBe('superseded');
    expect(await getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(world.draftId)))).toBeUndefined();
    expect(String(edits(net)[0]?.body.text)).toContain('Not sent: the customer wrote again.');
    expect(edits(net)[0]?.body.reply_markup).toEqual({ inline_keyboard: [] });

    expect((await autopilotSend(world.draftId, { now: AFTER })).outcome).toBe('skipped');
    expect(await messagesOf(world.conversationId)).toHaveLength(0);
  });

  it('the owner answering from the phone supersedes it too', async () => {
    const { world, net } = await scheduled();
    await ingestPayload(echoOf());
    expect((await draftRow(world.draftId)).status).toBe('superseded');
    expect(String(edits(net)[0]?.body.text)).toContain('you answered from your phone');
    expect(await getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(world.draftId)))).toBeUndefined();
  });

  it('the owner approving it in the dashboard first sends it as THEIR approval (ai_unedited), not as autopilot; the countdown and the buttons go', async () => {
    const { world, net } = await scheduled();
    const { approveDraft } = await import('@/lib/drafts/decide');
    const { announceQueued } = await import('@/lib/send/send-message');
    const approval = await getDb().transaction((tx) => approveDraft(tx, { draftId: world.draftId, finalContent: 'We close at 6pm 🙏', overrideStale: false, idempotencyKey: 'owner-approves-1', now: AFTER }));
    await announceQueued(approval.queued);
    const [message] = await sql()<{ provenance: string }[]>`SELECT provenance FROM messages WHERE id = ${approval.queued.messageId}`;
    expect(message?.provenance).toBe('ai_unedited');
    expect(await getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(world.draftId)))).toBeUndefined();
    expect(String(edits(net)[0]?.body.text)).toContain('You sent it yourself.');
    expect((await autopilotSend(world.draftId, { now: AFTER })).outcome).toBe('skipped');
    expect(await messagesOf(world.conversationId)).toHaveLength(0);
  });
});

describe('a streak of automatic replies, then a person', () => {
  it('the cap stops further automatic replies after N, and a manual send from the owner resets it', async () => {
    const world = await seedAutopilotWorld(sql());
    await sql()`UPDATE settings SET autopilot_max_consecutive = 2, autopilot_max_per_conversation_per_hour = 20`;
    network();
    const sendOne = async (text: string, at: Date, key: string) => {
      const id = await nextDraft(world, text);
      await sql()`UPDATE drafts SET status = 'scheduled', scheduled_send_at = ${at} WHERE id = ${id}`;
      const result = await autopilotSend(id, { now: at });
      if (result.outcome === 'sent') await performSend(result.messageId, { finalAttempt: true, now: at });
      void key;
      return result;
    };
    expect((await sendOne('one', new Date(NOW.getTime() + 1 * HOUR), 'a')).outcome).toBe('sent');
    expect((await sendOne('two', new Date(NOW.getTime() + 2 * HOUR), 'b')).outcome).toBe('sent');
    expect(await sendOne('three', new Date(NOW.getTime() + 3 * HOUR), 'c')).toEqual({ outcome: 'routed', reasons: ['consecutive_cap'] });

    // The owner replies by hand (through the one send path) and it goes through: the streak is over.
    const { queueMessage } = await import('@/lib/send/send-message');
    const manual = await getDb().transaction((tx) => queueMessage(tx, { conversationId: world.conversationId, message: { kind: 'text', content: 'Hello from me' }, idempotencyKey: 'manual-1', source: { kind: 'manual' }, now: new Date(NOW.getTime() + 4 * HOUR) }));
    await performSend(manual.messageId, { finalAttempt: true, now: new Date(NOW.getTime() + 4 * HOUR) });
    const [reset] = await sql()<{ consecutive_auto_replies: number }[]>`SELECT consecutive_auto_replies FROM conversations WHERE id = ${world.conversationId}`;
    expect(reset?.consecutive_auto_replies).toBe(0);
    expect((await sendOne('four', new Date(NOW.getTime() + 5 * HOUR), 'd')).outcome).toBe('sent');
  });
});

describe('never sends what the pre-check forbids', () => {
  it('a [[placeholder]] that appears in a scheduled draft after the fact is refused by the send path and the draft goes back to the owner', async () => {
    const { world } = await scheduled();
    await sql()`UPDATE drafts SET content = 'Delivery is [[fee?]]' WHERE id = ${world.draftId}`;
    expect(await autopilotSend(world.draftId, { now: AFTER })).toEqual({ outcome: 'routed', reasons: ['placeholder'] });
    expect(await messagesOf(world.conversationId)).toHaveLength(0);
  });
});

describe('an unexpected failure is not disguised as a refusal', () => {
  it('a database error inside the send path is raised (the job fails loudly) and the draft keeps its place: scheduled, nothing sent', async () => {
    const { world } = await scheduled();
    await sql().unsafe(`CREATE OR REPLACE FUNCTION p7_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'disk on fire'; END $$ LANGUAGE plpgsql`);
    await sql().unsafe(`CREATE TRIGGER p7_fail BEFORE INSERT ON messages FOR EACH ROW WHEN (NEW.provenance = 'ai_autopilot') EXECUTE FUNCTION p7_fail()`);
    try {
      await expect(autopilotSend(world.draftId, { now: AFTER })).rejects.toThrow();
    } finally {
      await sql().unsafe('DROP TRIGGER p7_fail ON messages');
      await sql().unsafe('DROP FUNCTION p7_fail()');
    }
    expect((await draftRow(world.draftId)).status).toBe('scheduled');
    expect(await messagesOf(world.conversationId)).toHaveLength(0);
  });
});

describe('the safety net under the countdown (alerts-scan)', () => {
  it('a countdown whose job was lost is started again, once; a quarter of an hour late the draft goes back to the owner instead', async () => {
    const { world } = await scheduled();
    const { repairAutopilotCountdowns } = await import('@/lib/autopilot/safety-net');
    await getQueue('autopilot-send').obliterate({ force: true }); // the job is lost
    const scheduledAt = (await draftRow(world.draftId)).scheduled_send_at as Date;

    // not yet late: nothing
    expect(await repairAutopilotCountdowns(getDb(), new Date(scheduledAt.getTime() + 30 * 1000))).toEqual({ restarted: 0, returned: 0 });
    // a few minutes late: started again, once
    expect(await repairAutopilotCountdowns(getDb(), new Date(scheduledAt.getTime() + 3 * MIN))).toEqual({ restarted: 1, returned: 0 });
    const restarted = await getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(world.draftId)));
    expect(restarted?.opts.delay).toBe(0);
    await getQueue('autopilot-send').obliterate({ force: true }); // lost again
    expect(await repairAutopilotCountdowns(getDb(), new Date(scheduledAt.getTime() + 4 * MIN))).toEqual({ restarted: 0, returned: 0 });
    // a quarter of an hour late: back to the owner, nothing is ever sent late on the autopilot's own initiative
    const net = stubNetwork({ telegram: telegramOk });
    expect(await repairAutopilotCountdowns(getDb(), new Date(scheduledAt.getTime() + 16 * MIN))).toEqual({ restarted: 0, returned: 1 });
    const draft = await draftRow(world.draftId);
    expect(draft.status).toBe('pending');
    expect(draft.scheduled_send_at).toBeNull();
    expect(draft.autopilot_decision).toMatchObject({ eligible: false, reasons: ['countdown_lost'] });
    expect(await messagesOf(world.conversationId)).toHaveLength(0);
    // The owner is told twice, the ordinary way: the countdown message loses its buttons and says why, and the draft is announced for approval.
    expect(edits(net)).toHaveLength(1);
    expect(String(edits(net)[0]?.body.text)).toContain('countdown was lost');
    expect(edits(net)[0]?.body.reply_markup).toEqual({ inline_keyboard: [] });
    expect(pings(net)).toHaveLength(1);
    expect(String(pings(net)[0]?.body.text)).toContain('ready for your approval');
    // ...and it is on the record, as the system.
    expect(await audits('autopilot.recheck_failed')).toEqual([{ actor: 'system', metadata: { conversationId: world.conversationId, reasons: ['countdown_lost'] } }]);
    expect((await h.events()).map((event) => event.type)).toContain('autopilot:cancelled');
  });

  it('a countdown whose job ran and FAILED (it is not alive: the draft is still waiting) is started again', async () => {
    const { world } = await scheduled();
    const { repairAutopilotCountdowns } = await import('@/lib/autopilot/safety-net');
    await getQueue('autopilot-send').obliterate({ force: true });
    // A job that really fails, as in production: a worker throws once.
    const worker = new Worker('autopilot-send', async () => { throw new Error('boom'); }, { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
    const failed = new Promise<void>((resolve) => worker.once('failed', () => resolve()));
    await getQueue('autopilot-send').add('send', { draftId: world.draftId }, { jobId: toJobId(autopilotJobKey(world.draftId)), attempts: 1 });
    await failed;
    await worker.close();
    expect(await (await getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(world.draftId))))?.getState()).toBe('failed');

    const scheduledAt = (await draftRow(world.draftId)).scheduled_send_at as Date;
    expect(await repairAutopilotCountdowns(getDb(), new Date(scheduledAt.getTime() + 3 * MIN))).toEqual({ restarted: 1, returned: 0 });
    expect(await (await getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(world.draftId))))?.getState()).not.toBe('failed');
  });

  it('only a draft that is still `scheduled` is ever repaired: a pending one carrying an old send time (a few minutes late, or a quarter of an hour) is left alone', async () => {
    const world = await seedAutopilotWorld(sql());
    const { repairAutopilotCountdowns } = await import('@/lib/autopilot/safety-net');
    for (const lateBy of [3 * MIN, 20 * MIN]) {
      await sql()`UPDATE drafts SET scheduled_send_at = ${new Date(NOW.getTime() - lateBy)} WHERE id = ${world.draftId}`;
      expect(await repairAutopilotCountdowns(getDb(), NOW)).toEqual({ restarted: 0, returned: 0 });
      expect((await draftRow(world.draftId)).status).toBe('pending');
      expect(await getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(world.draftId)))).toBeUndefined();
    }
  });

  it('leaves a healthy countdown alone', async () => {
    const { world } = await scheduled();
    const { repairAutopilotCountdowns } = await import('@/lib/autopilot/safety-net');
    const scheduledAt = (await draftRow(world.draftId)).scheduled_send_at as Date;
    expect(await repairAutopilotCountdowns(getDb(), new Date(scheduledAt.getTime() + 3 * MIN))).toEqual({ restarted: 0, returned: 0 });
    expect((await draftRow(world.draftId)).status).toBe('scheduled');
  });
});

// ------------------------------------------------------------------------------------------------------------------------ helpers

/** Another draft for the same conversation, pending, for the same unanswered customer message. */
async function nextDraft(world: World, content: string): Promise<string> {
  await sql()`UPDATE drafts SET status = 'superseded' WHERE conversation_id = ${world.conversationId} AND status = 'pending'`;
  const [row] = await sql()<{ id: string }[]>`
    INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status)
    VALUES (gen_random_uuid(), ${world.conversationId}, ${sql().array([world.questionId])}::uuid[], ${content}, ${content}, 'question', 'a', 'test-draft-model', 'draft-v1', 'pending') RETURNING id`;
  if (!row) throw new Error('draft seed failed');
  return row.id;
}

function customerMessage(wamid: string, text: string): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'w', time: Math.floor(NOW.getTime() / 1000), changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: FIXTURE.businessPhone, phone_number_id: FIXTURE.phoneNumberId },
      contacts: [{ wa_id: FIXTURE.amina.wa, user_id: FIXTURE.amina.bsuid, profile: { name: 'Amina' } }],
      messages: [{ from: FIXTURE.amina.wa, from_user_id: FIXTURE.amina.bsuid, id: wamid, timestamp: String(Math.floor(NOW.getTime() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  };
}

function echoOf(): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'w', time: Math.floor(NOW.getTime() / 1000), changes: [{ field: 'smb_message_echoes', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: FIXTURE.businessPhone, phone_number_id: FIXTURE.phoneNumberId },
      message_echoes: [{ from: FIXTURE.businessPhone, to: FIXTURE.amina.wa, id: `wamid.ECHO.${Math.random().toString(36).slice(2)}`, timestamp: String(Math.floor(NOW.getTime() / 1000) + 1), type: 'text', text: { body: 'Typed on my phone' } }],
    } }] }],
  };
}

