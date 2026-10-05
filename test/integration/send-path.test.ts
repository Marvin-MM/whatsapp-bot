import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Db, getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import {
  type OutboundContent,
  type QueueMessageInput,
  type QueuedMessage,
  SendRefused,
  SendRetryError,
  announceQueued,
  markMessageSent,
  performSend,
  queueMessage,
  resendMessage,
} from '@/lib/send/send-message';
import { FIXTURE } from '../helpers/fixtures';
import { HOUR, NOW, T0, count, envelopeOf, ingestPayload, seedContact, seedConversation, seedDraft, seedMessage, setupIngestHarness } from '../helpers/ingest';
import { jsonResponse, stubNetwork } from '../helpers/network';
import { createTestRedis } from '../helpers/redis';

const h = setupIngestHarness();
const sql = () => h.admin();

let sendQueue: Queue;
let analysisQueue: Queue;
beforeAll(async () => {
  sendQueue = new Queue('outbound-send', { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
  analysisQueue = new Queue('post-send-analysis', { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
});
afterAll(async () => {
  for (const queue of [sendQueue, analysisQueue]) {
    await queue.obliterate({ force: true });
    await queue.close();
  }
});
beforeEach(async () => {
  await sendQueue.obliterate({ force: true });
  await analysisQueue.obliterate({ force: true });
});
afterEach(() => vi.unstubAllGlobals());

// ------------------------------------------------------------------------------------------------------------ helpers

const accepted = (wamid = 'wamid.SENT.1') =>
  jsonResponse({ messaging_product: 'whatsapp', contacts: [{ input: FIXTURE.amina.wa, wa_id: FIXTURE.amina.wa }], messages: [{ id: wamid }] });
const metaError = (code: number, status = 400) => jsonResponse({ error: { message: 'x', type: 'OAuthException', code, fbtrace_id: 'trace' } }, status);
const networkError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

type Row = {
  id: string;
  status: string;
  wamid: string | null;
  provenance: string;
  content: string | null;
  type: string;
  template_name: string | null;
  idempotency_key: string | null;
  send_started_at: Date | null;
  error: { kind: string; code: string | null; message: string } | null;
};
const row = async (id: string) => (await sql()<Row[]>`SELECT * FROM messages WHERE id = ${id}`)[0];
const outboundCount = () => count(sql(), 'messages', `direction = 'outbound'`);
const alerts = (kind: string) => count(sql(), 'notifications', `kind = 'alert:${kind}'`);

interface Seed {
  contactId: string;
  conversationId: string;
  inboundId: string;
}

/** A customer who wrote at T0 (so the window is open until T0 + 24h) and a conversation waiting on the owner. */
async function seedCustomer(o: { phone?: string | null; bsuid?: string | null; windowOpen?: boolean; paused?: boolean } = {}): Promise<Seed> {
  const contactId = await seedContact(sql(), {
    phone: o.phone === undefined ? `+${FIXTURE.amina.wa}` : o.phone,
    bsuid: o.bsuid === undefined ? FIXTURE.amina.bsuid : o.bsuid,
    ...(o.phone === null && o.bsuid === null ? { source: 'import_name' as const, name: 'Name Only' } : {}),
  });
  const conversationId = await seedConversation(sql(), contactId, { status: 'waiting_on_me' });
  const inboundId = await seedMessage(sql(), conversationId, { direction: 'inbound', wamid: `wamid.IN.${conversationId}`, content: 'Do you have the blue dress?', occurredAt: T0 });
  if (o.windowOpen !== false) {
    await sql()`UPDATE conversations SET last_inbound_at = ${T0}, last_message_at = ${T0}, window_expires_at = ${new Date(T0.getTime() + 24 * HOUR)} WHERE id = ${conversationId}`;
  }
  await sql()`INSERT INTO settings (id, sending_paused) VALUES (1, ${o.paused ?? false}) ON CONFLICT (id) DO UPDATE SET sending_paused = ${o.paused ?? false}`;
  return { contactId, conversationId, inboundId };
}

const textInput = (conversationId: string, over: Partial<QueueMessageInput> & { text?: string } = {}): QueueMessageInput => ({
  conversationId,
  message: { kind: 'text', content: over.text ?? 'Yes, we have it in size M.' },
  idempotencyKey: over.idempotencyKey ?? `key-${Math.random().toString(36).slice(2)}`,
  source: { kind: 'manual' },
  now: NOW,
  ...(over.source ? { source: over.source } : {}),
  ...(over.message ? { message: over.message } : {}),
  ...(over.provenance ? { provenance: over.provenance } : {}),
  ...(over.now ? { now: over.now } : {}),
});

const queue = (input: QueueMessageInput): Promise<QueuedMessage> => getDb().transaction((tx) => queueMessage(tx, input));
const queueAndAnnounce = async (input: QueueMessageInput) => {
  const queued = await queue(input);
  await announceQueued(queued);
  return queued;
};
const refusal = async (promise: Promise<unknown>): Promise<SendRefused> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SendRefused) return error;
    throw error;
  }
  throw new Error('expected the send to be refused');
};

const template = (): OutboundContent => ({
  kind: 'template',
  template: {
    name: 'order_update',
    language: 'en',
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'Amina' }] }],
    renderedContent: 'Hello Amina, your order is ready.',
  },
});

const send = (messageId: string, o: { finalAttempt?: boolean; now?: Date; template?: { name: string; language: string; components: Array<Record<string, unknown>> }; db?: Db } = {}) =>
  performSend(messageId, { finalAttempt: o.finalAttempt ?? false, now: o.now ?? NOW, template: o.template, ...(o.db ? { db: o.db } : {}) });

// ------------------------------------------------------------------------------------------------------------ queueing

describe('queueMessage: the pre-check and the row', () => {
  it('queues a typed reply as owner_manual, tells the worker AFTER the row exists, and tells the dashboard', async () => {
    const { conversationId } = await seedCustomer();
    const queued = await queueAndAnnounce(textInput(conversationId, { idempotencyKey: 'k-1' }));

    const message = await row(queued.messageId);
    expect(message).toMatchObject({ status: 'queued', provenance: 'owner_manual', content: 'Yes, we have it in size M.', type: 'text', idempotency_key: 'k-1', wamid: null, send_started_at: null });

    const jobs = await sendQueue.getJobs(['waiting', 'delayed']);
    expect(jobs.map((job) => job.id)).toEqual([`send%3A${queued.messageId}`]);
    expect(jobs[0]?.data).toEqual({ messageId: queued.messageId });

    const events = (await h.events()).map((event) => event.type);
    expect(events).toContain('message:new');
    expect(events).toContain('conversation:updated');
  });

  it('DOUBLE SUBMIT: the same idempotency key is one message and one job, not two', async () => {
    const { conversationId } = await seedCustomer();
    const first = await queueAndAnnounce(textInput(conversationId, { idempotencyKey: 'dbl' }));
    const second = await queueAndAnnounce(textInput(conversationId, { idempotencyKey: 'dbl' }));

    expect(second.duplicate).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(await outboundCount()).toBe(1);
    expect(await sendQueue.getJobs(['waiting', 'delayed'])).toHaveLength(1);
  });

  it('CONCURRENT double submit with one key is still one message', async () => {
    const { conversationId } = await seedCustomer();
    const results = await Promise.all([queue(textInput(conversationId, { idempotencyKey: 'race' })), queue(textInput(conversationId, { idempotencyKey: 'race' }))]);
    expect(new Set(results.map((r) => r.messageId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await outboundCount()).toBe(1);
  });

  it('refuses TEXT outside the 24h window and writes nothing, but allows a TEMPLATE', async () => {
    const { conversationId } = await seedCustomer();
    const late = new Date(T0.getTime() + 25 * HOUR);

    const refused = await refusal(queue(textInput(conversationId, { now: late })));
    expect(refused.code).toBe('window_closed');
    expect(await outboundCount()).toBe(0);

    const queued = await queueAndAnnounce(textInput(conversationId, { now: late, message: template() }));
    expect(await row(queued.messageId)).toMatchObject({ status: 'queued', type: 'template', template_name: 'order_update', content: 'Hello Amina, your order is ready.' });
    const [job] = await sendQueue.getJobs(['waiting', 'delayed']);
    expect(job?.data).toMatchObject({ messageId: queued.messageId, template: { name: 'order_update', language: 'en', components: [{ type: 'body' }] } });
  });

  it('treats a customer who has never written as outside the window', async () => {
    const { conversationId } = await seedCustomer({ windowOpen: false });
    expect((await refusal(queue(textInput(conversationId)))).code).toBe('window_closed');
  });

  it('refuses while sending is paused, and the kill switch is read inside the transaction', async () => {
    const { conversationId } = await seedCustomer({ paused: true });
    expect((await refusal(queue(textInput(conversationId)))).code).toBe('sending_paused');
    expect(await outboundCount()).toBe(0);
  });

  it.each([
    ['an unresolved placeholder', 'Your total is [[price]] shillings.', 'placeholder_unresolved'],
    ['an empty message', '   ', 'empty_message'],
    ['a message over 4096 characters', 'x'.repeat(4097), 'message_too_long'],
  ])('refuses %s', async (_name, text, code) => {
    const { conversationId } = await seedCustomer();
    expect((await refusal(queue(textInput(conversationId, { text })))).code).toBe(code);
    expect(await outboundCount()).toBe(0);
  });

  it('refuses a contact with no phone and no BSUID', async () => {
    const { conversationId } = await seedCustomer({ phone: null, bsuid: null });
    expect((await refusal(queue(textInput(conversationId)))).code).toBe('no_recipient');
  });

  it('refuses a conversation that does not exist', async () => {
    await seedCustomer();
    expect((await refusal(queue(textInput('0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee')))).code).toBe('not_found');
  });

  it('supersedes drafts that were written before this reply', async () => {
    const { conversationId, inboundId } = await seedCustomer();
    const draftId = await seedDraft(sql(), conversationId, 'pending', [inboundId]);
    await queue(textInput(conversationId));
    expect((await sql()<{ status: string }[]>`SELECT status FROM drafts WHERE id = ${draftId}`)[0]?.status).toBe('superseded');
  });
});

describe('queueMessage: approving a draft', () => {
  const draftInput = (conversationId: string, draftId: string, finalContent: string, over: { overrideStale?: boolean; key?: string } = {}): QueueMessageInput => ({
    conversationId,
    message: { kind: 'text', content: finalContent },
    idempotencyKey: over.key ?? `draft-${draftId}`,
    source: { kind: 'draft', draftId, finalContent, overrideStale: over.overrideStale ?? false },
    now: NOW,
  });

  it('claims the draft in the same transaction: unedited -> approved / ai_unedited, linked to the message', async () => {
    const { conversationId, inboundId } = await seedCustomer();
    const draftId = await seedDraft(sql(), conversationId, 'pending', [inboundId]);
    const queued = await queue(draftInput(conversationId, draftId, 'draft'));

    expect(await row(queued.messageId)).toMatchObject({ provenance: 'ai_unedited', status: 'queued' });
    expect((await sql()<{ status: string; final_message_id: string; approved_at: Date }[]>`SELECT * FROM drafts WHERE id = ${draftId}`)[0]).toMatchObject({ status: 'approved', final_message_id: queued.messageId });
  });

  it('an edited draft becomes `edited` / ai_edited and stores what was actually sent', async () => {
    const { conversationId, inboundId } = await seedCustomer();
    const draftId = await seedDraft(sql(), conversationId, 'pending', [inboundId]);
    const queued = await queue(draftInput(conversationId, draftId, 'Yes, in size M. Anything else?'));

    expect((await row(queued.messageId))?.provenance).toBe('ai_edited');
    expect((await sql()<{ status: string; content: string; original_content: string }[]>`SELECT * FROM drafts WHERE id = ${draftId}`)[0]).toMatchObject({
      status: 'edited',
      content: 'Yes, in size M. Anything else?',
      original_content: 'draft',
    });
  });

  it('a FAILED PRE-CHECK ROLLS EVERYTHING BACK: no message, and the draft is still pending', async () => {
    const { conversationId, inboundId } = await seedCustomer();
    const draftId = await seedDraft(sql(), conversationId, 'pending', [inboundId]);

    const refused = await refusal(queue(draftInput(conversationId, draftId, 'It costs [[price]].')));
    expect(refused.code).toBe('placeholder_unresolved');
    expect(await outboundCount()).toBe(0);
    expect((await sql()<{ status: string; final_message_id: string | null }[]>`SELECT status, final_message_id FROM drafts WHERE id = ${draftId}`)[0]).toEqual({ status: 'pending', final_message_id: null });
  });

  it('a window that closed refuses the approval and leaves the draft pending', async () => {
    const { conversationId, inboundId } = await seedCustomer();
    const draftId = await seedDraft(sql(), conversationId, 'pending', [inboundId]);
    const refused = await refusal(queue({ ...draftInput(conversationId, draftId, 'draft'), now: new Date(T0.getTime() + 30 * HOUR) }));
    expect(refused.code).toBe('window_closed');
    expect((await sql()<{ status: string }[]>`SELECT status FROM drafts WHERE id = ${draftId}`)[0]?.status).toBe('pending');
  });

  it('a draft written before a newer customer message is STALE, and only an explicit override sends it', async () => {
    const { conversationId, inboundId } = await seedCustomer();
    const draftId = await seedDraft(sql(), conversationId, 'pending', [inboundId]);
    await seedMessage(sql(), conversationId, { direction: 'inbound', wamid: 'wamid.IN.NEWER', content: 'Actually, size L please', occurredAt: new Date(T0.getTime() + 10 * 60 * 1000) });

    expect((await refusal(queue(draftInput(conversationId, draftId, 'draft')))).code).toBe('draft_stale');
    expect(await outboundCount()).toBe(0);

    const queued = await queue(draftInput(conversationId, draftId, 'draft', { overrideStale: true }));
    expect((await row(queued.messageId))?.status).toBe('queued');
  });

  it('TWO APPROVALS of one draft (different keys, concurrently) send exactly one message', async () => {
    const { conversationId, inboundId } = await seedCustomer();
    const draftId = await seedDraft(sql(), conversationId, 'pending', [inboundId]);
    const settled = await Promise.allSettled([queue(draftInput(conversationId, draftId, 'draft', { key: 'a' })), queue(draftInput(conversationId, draftId, 'draft', { key: 'b' }))]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(SendRefused);
    expect((rejected?.reason as SendRefused).code).toBe('draft_not_open');
    expect(await outboundCount()).toBe(1);
  });

  it('refuses a draft that was already rejected, superseded or failed', async () => {
    const { conversationId, inboundId } = await seedCustomer();
    for (const status of ['rejected', 'superseded', 'failed', 'approved']) {
      const draftId = await seedDraft(sql(), conversationId, status, [inboundId]);
      expect((await refusal(queue(draftInput(conversationId, draftId, 'draft')))).code).toBe('draft_not_open');
    }
    expect(await outboundCount()).toBe(0);
  });

  it('an autopilot release (of a draft whose countdown ran: `scheduled`) is provenance ai_autopilot', async () => {
    const { conversationId, inboundId } = await seedCustomer();
    const draftId = await seedDraft(sql(), conversationId, 'scheduled', [inboundId]);
    const queued = await queue({ ...draftInput(conversationId, draftId, 'draft'), source: { kind: 'draft', draftId, finalContent: 'draft', overrideStale: false, autopilot: true } });
    expect((await row(queued.messageId))?.provenance).toBe('ai_autopilot');
    expect((await sql()<{ status: string }[]>`SELECT status FROM drafts WHERE id = ${draftId}`)[0]?.status).toBe('approved');
  });

  it('the autopilot can NEVER release a draft that is not scheduled (it only sends what a countdown was started for): refused, nothing queued', async () => {
    const { conversationId, inboundId } = await seedCustomer();
    const draftId = await seedDraft(sql(), conversationId, 'pending', [inboundId]);
    await expect(queue({ ...draftInput(conversationId, draftId, 'draft'), source: { kind: 'draft', draftId, finalContent: 'draft', overrideStale: false, autopilot: true } })).rejects.toMatchObject({ code: 'draft_not_open' });
    expect(await count(sql(), 'messages', `direction = 'outbound'`)).toBe(0);
    expect((await sql()<{ status: string }[]>`SELECT status FROM drafts WHERE id = ${draftId}`)[0]?.status).toBe('pending');
  });
});

// ------------------------------------------------------------------------------------------------------------ delivering

describe('performSend: one call to Meta, recorded exactly', () => {
  it('sends to the phone, carries OUR id as callback data, records the wamid, and moves the conversation on', async () => {
    const net = stubNetwork({ graphSend: () => accepted('wamid.SENT.A') });
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));

    expect(await send(messageId)).toBe('sent');

    expect(net.sends).toHaveLength(1);
    expect(net.sends[0]?.headers.authorization).toBe('Bearer test-access-token');
    expect(net.sends[0]?.url).toBe('https://graph.facebook.com/v25.0/100000000000001/messages');
    expect(net.sends[0]?.payload).toMatchObject({
      messaging_product: 'whatsapp',
      to: FIXTURE.amina.wa,
      type: 'text',
      text: { body: 'Yes, we have it in size M.', preview_url: false },
      biz_opaque_callback_data: messageId,
    });
    expect(net.sends[0]?.payload).not.toHaveProperty('recipient');

    expect(await row(messageId)).toMatchObject({ status: 'sent', wamid: 'wamid.SENT.A', error: null });
    expect((await row(messageId))?.send_started_at).toBeInstanceOf(Date);
    expect((await sql()<{ status: string }[]>`SELECT status FROM conversations WHERE id = ${conversationId}`)[0]?.status).toBe('waiting_on_customer');

    const statuses = (await h.events()).filter((e) => e.type === 'message:status');
    expect(statuses.map((e) => (e.type === 'message:status' ? e.payload.status : null))).toEqual(['sent']);

    // Once Meta has it: one summary-and-tasks job, named after the message (a second send run must not make another).
    expect((await analysisQueue.getJobs(['waiting', 'delayed', 'prioritized'])).map((job) => job.data)).toEqual([{ messageId }]);
  });

  it('a message that is NOT accepted (Meta refuses it) starts no analysis', async () => {
    stubNetwork({ graphSend: () => metaError(131026) });
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));
    expect(await send(messageId)).toBe('failed');
    expect(await analysisQueue.getJobs(['waiting', 'delayed', 'prioritized'])).toHaveLength(0);
  });

  it('a second run of the same job sends NOTHING (at most once, ever)', async () => {
    const net = stubNetwork({ graphSend: () => accepted() });
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));

    expect(await send(messageId)).toBe('sent');
    expect(await send(messageId)).toBe('skipped');
    expect(await send(messageId)).toBe('skipped');
    expect(net.sends).toHaveLength(1);
  });

  it('two workers racing on one message still send once', async () => {
    const net = stubNetwork({ graphSend: async () => accepted() });
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));

    const outcomes = await Promise.all([send(messageId), send(messageId), send(messageId)]);
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
    expect(net.sends).toHaveLength(1);
  });

  it('addresses a BSUID-only customer with `recipient`, never `to`', async () => {
    const net = stubNetwork({ graphSend: () => accepted() });
    const { conversationId } = await seedCustomer({ phone: null, bsuid: FIXTURE.kato.bsuid });
    const { messageId } = await queueAndAnnounce(textInput(conversationId));
    await send(messageId);

    expect(net.sends[0]?.payload).toMatchObject({ recipient: FIXTURE.kato.bsuid });
    expect(net.sends[0]?.payload).not.toHaveProperty('to');
  });

  it('sends a template with its components (which travelled in the job, not on the row)', async () => {
    const net = stubNetwork({ graphSend: () => accepted() });
    const { conversationId } = await seedCustomer({ windowOpen: false });
    const queued = await queueAndAnnounce(textInput(conversationId, { message: template() }));
    const [job] = await sendQueue.getJobs(['waiting', 'delayed']);
    const data = job?.data as { messageId: string; template: { name: string; language: string; components: Array<Record<string, unknown>> } };

    expect(await send(queued.messageId, { template: data.template })).toBe('sent');
    expect(net.sends[0]?.payload).toMatchObject({
      type: 'template',
      template: { name: 'order_update', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Amina' }] }] },
      biz_opaque_callback_data: queued.messageId,
    });
  });

  it('a template whose job data was lost fails VISIBLY, never stamped, never sent', async () => {
    const net = stubNetwork({ graphSend: () => accepted() });
    const { conversationId } = await seedCustomer({ windowOpen: false });
    const queued = await queue(textInput(conversationId, { message: template() }));

    expect(await send(queued.messageId)).toBe('failed');
    expect(net.sends).toHaveLength(0);
    expect(await row(queued.messageId)).toMatchObject({ status: 'failed', send_started_at: null, error: { kind: 'permanent', code: 'template_job_lost' } });
  });

  it('re-checks the window at SEND time: it closed while the job waited', async () => {
    const net = stubNetwork({ graphSend: () => accepted() });
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));

    expect(await send(messageId, { now: new Date(T0.getTime() + 24 * HOUR + 1000) })).toBe('failed');
    expect(net.sends).toHaveLength(0);
    expect(await row(messageId)).toMatchObject({ status: 'failed', send_started_at: null, error: { code: 'window_closed' } });
  });

  it('re-checks the kill switch at SEND time: paused after queueing', async () => {
    const net = stubNetwork({ graphSend: () => accepted() });
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));
    await sql()`UPDATE settings SET sending_paused = true`;

    expect(await send(messageId)).toBe('failed');
    expect(net.sends).toHaveLength(0);
    expect((await row(messageId))?.error?.code).toBe('sending_paused');
  });

  it('does not touch an inbound message or an unknown id', async () => {
    const net = stubNetwork({ graphSend: () => accepted() });
    const { inboundId } = await seedCustomer();
    expect(await send(inboundId)).toBe('skipped');
    expect(await send('0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee')).toBe('skipped');
    expect(net.sends).toHaveLength(0);
  });

  it('an autopilot message counts toward the consecutive cap; any other send resets it', async () => {
    let n = 0;
    stubNetwork({ graphSend: () => accepted(`wamid.CAP.${++n}`) });
    const { conversationId, inboundId } = await seedCustomer();
    const consecutive = async () => (await sql()<{ n: number }[]>`SELECT consecutive_auto_replies AS n FROM conversations WHERE id = ${conversationId}`)[0]?.n;

    const draftId = await seedDraft(sql(), conversationId, 'scheduled', [inboundId]);
    const auto = await queue({
      conversationId,
      message: { kind: 'text', content: 'draft' },
      idempotencyKey: 'auto-1',
      source: { kind: 'draft', draftId, finalContent: 'draft', overrideStale: false, autopilot: true },
      now: NOW,
    });
    await send(auto.messageId);
    expect(await consecutive()).toBe(1);

    const manual = await queue(textInput(conversationId));
    await send(manual.messageId);
    expect(await consecutive()).toBe(0);
  });

  it('does not mark the thread "waiting on customer" when the customer has already written again', async () => {
    const { conversationId } = await seedCustomer();
    const queued = await queueAndAnnounce(textInput(conversationId));
    stubNetwork({
      graphSend: async () => {
        // The customer replies while our request is in flight.
        await seedMessage(sql(), conversationId, { direction: 'inbound', wamid: 'wamid.IN.RACE', content: 'hello?', occurredAt: new Date(NOW.getTime() + 1000) });
        await sql()`UPDATE conversations SET last_inbound_at = ${new Date(NOW.getTime() + 1000)}, status = 'waiting_on_me' WHERE id = ${conversationId}`;
        return accepted();
      },
    });
    await send(queued.messageId);
    expect((await sql()<{ status: string }[]>`SELECT status FROM conversations WHERE id = ${conversationId}`)[0]?.status).toBe('waiting_on_me');
  });
});

describe('performSend: when Meta says no', () => {
  it.each([
    [131047, 'window_expired', /24 hours|window/i],
    [131026, 'undeliverable', /could not deliver/i],
  ])('code %i is a permanent failure with a sentence the owner can act on', async (code, _label, readable) => {
    stubNetwork({ graphSend: () => metaError(code) });
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));

    expect(await send(messageId)).toBe('failed');
    const message = await row(messageId);
    expect(message).toMatchObject({ status: 'failed', error: { kind: 'permanent', code: String(code) } });
    expect(message?.error?.message).toMatch(readable);
    expect(message?.error?.message).not.toBe('x');
  });

  it('an invalid token fails the message AND raises a critical alert (once per day, however many messages fail)', async () => {
    stubNetwork({ graphSend: () => metaError(190, 401) });
    const { conversationId } = await seedCustomer();
    const a = await queueAndAnnounce(textInput(conversationId));
    const b = await queueAndAnnounce(textInput(conversationId));
    await send(a.messageId);
    await send(b.messageId);

    expect(await alerts('whatsapp_token_invalid')).toBe(1);
    expect((await row(a.messageId))?.status).toBe('failed');
    expect((await row(b.messageId))?.status).toBe('failed');
  });

  it('a spam-restricted account raises its own alert', async () => {
    stubNetwork({ graphSend: () => metaError(131048) });
    const { conversationId } = await seedCustomer();
    await send((await queueAndAnnounce(textInput(conversationId))).messageId);
    expect(await alerts('whatsapp_spam_restricted')).toBe(1);
  });

  it('an unrecognised error code is permanent and shows the raw code (never retried blindly)', async () => {
    const net = stubNetwork({ graphSend: () => metaError(987654) });
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));

    expect(await send(messageId)).toBe('failed');
    expect(net.sends).toHaveLength(1);
    expect((await row(messageId))?.error?.code).toBe('987654');
  });
});

describe('performSend: retries that cannot double-send', () => {
  it('a throttle (429) CLEARS the stamp, throws for the queue to retry, and the retry sends exactly once', async () => {
    let calls = 0;
    const net = stubNetwork({ graphSend: () => (++calls === 1 ? metaError(130429, 429) : accepted('wamid.RETRY.1')) });
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));

    await expect(send(messageId)).rejects.toBeInstanceOf(SendRetryError);
    // The clear was COMMITTED before the throw: the next attempt is allowed to proceed.
    expect(await row(messageId)).toMatchObject({ status: 'queued', send_started_at: null, wamid: null });

    expect(await send(messageId)).toBe('sent');
    expect(net.sends).toHaveLength(2);
    expect(await row(messageId)).toMatchObject({ status: 'sent', wamid: 'wamid.RETRY.1' });
  });

  it('a connection that was never made is retried; one that broke AFTER the write is not', async () => {
    const refused = stubNetwork({
      graphSend: () => {
        throw networkError('ECONNREFUSED');
      },
    });
    const { conversationId } = await seedCustomer();
    const first = await queueAndAnnounce(textInput(conversationId));
    await expect(send(first.messageId)).rejects.toBeInstanceOf(SendRetryError);
    expect(refused.sends).toHaveLength(1);
    expect((await row(first.messageId))?.send_started_at).toBeNull();

    vi.unstubAllGlobals();
    const reset = stubNetwork({
      graphSend: () => {
        throw networkError('ECONNRESET');
      },
    });
    const second = await queueAndAnnounce(textInput(conversationId));
    expect(await send(second.messageId)).toBe('unknown');
    expect(reset.sends).toHaveLength(1);
  });

  it('on the FINAL attempt a retryable failure is given up on, visibly, and nothing more is sent', async () => {
    const net = stubNetwork({ graphSend: () => metaError(130429, 429) });
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));

    expect(await send(messageId, { finalAttempt: true })).toBe('failed');
    expect(net.sends).toHaveLength(1);
    const message = await row(messageId);
    expect(message?.status).toBe('failed');
    expect(message?.error?.message).toMatch(/gave up/i);
  });

  it('a 5xx WITH a Meta error body is retried; a 5xx WITHOUT one is AMBIGUOUS and never retried', async () => {
    stubNetwork({ graphSend: () => metaError(2, 500) });
    const { conversationId } = await seedCustomer();
    const withBody = await queueAndAnnounce(textInput(conversationId));
    await expect(send(withBody.messageId)).rejects.toBeInstanceOf(SendRetryError);

    vi.unstubAllGlobals();
    const net = stubNetwork({ graphSend: () => new Response('<html>Bad gateway</html>', { status: 502 }) });
    const without = await queueAndAnnounce(textInput(conversationId));
    expect(await send(without.messageId)).toBe('unknown');
    expect(net.sends).toHaveLength(1);
  });
});

describe('performSend: when we cannot know whether Meta has it', () => {
  it('a TIMEOUT marks the message `unknown`, alerts, and is never retried or resent', async () => {
    const net = stubNetwork({
      graphSend: () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      },
    });
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));

    expect(await send(messageId)).toBe('unknown');
    expect(await row(messageId)).toMatchObject({ status: 'unknown', error: { kind: 'ambiguous' } });
    expect(await alerts('message_unknown')).toBe(1);

    // A second delivery of the job (BullMQ redelivery, a manual re-add) must not send.
    expect(await send(messageId)).toBe('skipped');
    expect(net.sends).toHaveLength(1);
  });

  it('A CRASH AFTER META ACCEPTED THE MESSAGE: the re-run never sends it again', async () => {
    const net = stubNetwork({ graphSend: () => accepted('wamid.CRASH.1') });
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));

    // The worker dies between "Meta said yes" and "we wrote it down": the second transaction never commits.
    const real = getDb();
    let transactions = 0;
    const crashing = new Proxy(real, {
      get(target, prop) {
        if (prop === 'transaction') {
          return (...args: Parameters<Db['transaction']>) => {
            transactions += 1;
            if (transactions === 2) return Promise.reject(new Error('simulated worker crash'));
            return target.transaction(...args);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as Db;

    await expect(send(messageId, { db: crashing })).rejects.toThrow('simulated worker crash');
    expect(net.sends).toHaveLength(1);
    // What the database knows: stamped, still queued, no wamid. Nobody knows whether Meta has it.
    expect(await row(messageId)).toMatchObject({ status: 'queued', wamid: null });
    expect((await row(messageId))?.send_started_at).toBeInstanceOf(Date);

    // The job is run again (stall recovery, a retry, the sweeper): it must refuse to send.
    expect(await send(messageId)).toBe('unknown');
    expect(net.sends).toHaveLength(1);
    expect(await row(messageId)).toMatchObject({ status: 'unknown', error: { kind: 'ambiguous' } });
    expect(await alerts('message_unknown')).toBe(1);
  });

  it('a delivery status that BEATS our write of the wamid is matched by our callback id and never moved backward', async () => {
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));
    stubNetwork({
      graphSend: async () => {
        // Meta's "delivered" webhook arrives while we are still waiting for the HTTP answer.
        await ingestPayload(
          envelopeOf('messages', {
            statuses: [{ id: 'wamid.FAST.1', status: 'delivered', timestamp: String(Math.floor(NOW.getTime() / 1000)), recipient_id: FIXTURE.amina.wa, biz_opaque_callback_data: messageId }],
          }),
        );
        return accepted('wamid.FAST.1');
      },
    });

    expect(await send(messageId)).toBe('sent');
    expect(await row(messageId)).toMatchObject({ status: 'delivered', wamid: 'wamid.FAST.1' });
  });

  it('a message alerts-scan had already parked as `unknown` becomes `sent` when the late answer shows Meta had it', async () => {
    const { conversationId } = await seedCustomer();
    const { messageId } = await queueAndAnnounce(textInput(conversationId));
    stubNetwork({
      graphSend: async () => {
        await sql()`UPDATE messages SET status = 'unknown', error = ${sql().json({ kind: 'ambiguous', code: null, message: 'parked' })} WHERE id = ${messageId}`;
        return accepted('wamid.LATE.1');
      },
    });
    expect(await send(messageId)).toBe('sent');
    expect(await row(messageId)).toMatchObject({ status: 'sent', wamid: 'wamid.LATE.1', error: null });
  });
});

// ------------------------------------------------------------------------------------------------------------ owner repairs

async function seedUnknown(content = 'Yes, we have it in size M.'): Promise<{ conversationId: string; messageId: string }> {
  const { conversationId } = await seedCustomer();
  const messageId = await seedMessage(sql(), conversationId, { direction: 'outbound', wamid: null, status: 'unknown', content, occurredAt: NOW });
  return { conversationId, messageId };
}

describe('owner repairs: mark sent / resend', () => {
  it('"mark sent" moves unknown -> sent, clears the error, and nothing else', async () => {
    const { messageId } = await seedUnknown();
    await getDb().transaction((tx) => markMessageSent(tx, messageId));
    expect(await row(messageId)).toMatchObject({ status: 'sent', error: null });
  });

  it('"mark sent" refuses anything that is not unknown', async () => {
    const { conversationId } = await seedCustomer();
    for (const status of ['queued', 'sent', 'delivered', 'failed']) {
      const id = await seedMessage(sql(), conversationId, { direction: 'outbound', status, wamid: null, content: 'x' });
      expect((await refusal(getDb().transaction((tx) => markMessageSent(tx, id)))).code).toBe('not_unknown');
    }
  });

  it('"resend" closes the original as failed and queues ONE new message with the same text', async () => {
    const net = stubNetwork({ graphSend: () => accepted('wamid.RESEND.1') });
    const { conversationId, messageId } = await seedUnknown('See you at 3pm.');
    const queued = await getDb().transaction((tx) => resendMessage(tx, messageId, NOW));
    await announceQueued(queued);

    expect(queued.messageId).not.toBe(messageId);
    expect(await row(messageId)).toMatchObject({ status: 'failed', error: { code: 'resent' } });
    expect(await row(queued.messageId)).toMatchObject({ status: 'queued', content: 'See you at 3pm.', idempotency_key: `resend:${messageId}` });

    await send(queued.messageId);
    expect(net.sends).toHaveLength(1);
    expect(await outboundCount()).toBe(2);
    expect(conversationId).toBeTruthy();
  });

  it('resending twice cannot create two messages', async () => {
    const { messageId } = await seedUnknown();
    await getDb().transaction((tx) => resendMessage(tx, messageId, NOW));
    expect((await refusal(getDb().transaction((tx) => resendMessage(tx, messageId, NOW)))).code).toBe('not_unknown');
    expect(await outboundCount()).toBe(2);
  });

  it('a resend outside the window is refused and the original stays `unknown`', async () => {
    const { messageId } = await seedUnknown();
    const refused = await refusal(getDb().transaction((tx) => resendMessage(tx, messageId, new Date(T0.getTime() + 48 * HOUR))));
    expect(refused.code).toBe('window_closed');
    expect((await row(messageId))?.status).toBe('unknown');
    expect(await outboundCount()).toBe(1);
  });

  it('a template cannot be resent as plain text (its parameters are not stored)', async () => {
    const { conversationId } = await seedCustomer();
    const id = await seedMessage(sql(), conversationId, { direction: 'outbound', status: 'unknown', wamid: null, type: 'template', content: 'Hello Amina' });
    expect((await refusal(getDb().transaction((tx) => resendMessage(tx, id, NOW)))).code).toBe('resend_not_supported');
    expect((await row(id))?.status).toBe('unknown');
  });
});
