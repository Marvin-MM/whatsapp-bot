import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv } from '@/lib/env';
import { loadTemplates } from '@/lib/whatsapp/templates-client';
import { createEnrolledOwner, headersWith } from '../helpers/auth';
import { FIXTURE } from '../helpers/fixtures';
import { HOUR, NOW, T0, count, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';
import { jsonResponse, stubNetwork } from '../helpers/network';
import { createTestRedis } from '../helpers/redis';

// The real server actions read their headers through next/headers; point it at a mutable test cookie.
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const { markSent, resend, sendMessage, sendTemplate } = await import('@/actions/send');
const { listTemplates } = await import('@/actions/templates');

const h = setupIngestHarness();
const sql = () => h.admin();

let sendQueue: Queue;
const redis = createTestRedis();
beforeAll(() => {
  sendQueue = new Queue('outbound-send', { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
});
afterAll(async () => {
  await sendQueue.obliterate({ force: true });
  await sendQueue.close();
  await redis.quit();
});
beforeEach(async () => {
  await sendQueue.obliterate({ force: true });
  await redis.del(`${getEnv().BULLMQ_PREFIX}:templates:v1`);
  requestHeaders.current = new Headers();
});
afterEach(() => vi.unstubAllGlobals());

async function signedIn(): Promise<void> {
  const owner = await createEnrolledOwner();
  requestHeaders.current = headersWith(owner.cookie);
}

async function seedCustomer(openUntil: Date | null = new Date(T0.getTime() + 24 * HOUR)): Promise<string> {
  const contactId = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}`, bsuid: FIXTURE.amina.bsuid });
  const conversationId = await seedConversation(sql(), contactId, { status: 'waiting_on_me' });
  await seedMessage(sql(), conversationId, { direction: 'inbound', wamid: 'wamid.IN.A', content: 'hello', occurredAt: T0 });
  await sql()`UPDATE conversations SET last_inbound_at = ${T0}, last_message_at = ${T0}, window_expires_at = ${openUntil} WHERE id = ${conversationId}`;
  await sql()`INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING`;
  return conversationId;
}

const key = (n: string) => `test-key-${n}-0123456789`;
const audit = () => sql()<{ action: string; entity_id: string; metadata: Record<string, unknown> }[]>`SELECT action, entity_id, metadata FROM audit_log WHERE actor = 'owner' ORDER BY created_at`;

// The composer's window check is evaluated at the real clock by the action (the owner clicks "now"), so these tests use a
// conversation whose window is open relative to the REAL time.
const openWindow = () => new Date(Date.now() + 5 * HOUR);

describe('sendMessage (the real server action)', () => {
  it('is rejected without a session and creates nothing', async () => {
    const conversationId = await seedCustomer(openWindow());
    const result = await sendMessage({ conversationId, text: 'hi', idempotencyKey: key('a') });
    expect(result).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(await count(sql(), 'messages', `direction = 'outbound'`)).toBe(0);
    expect(await sendQueue.getJobs(['waiting'])).toHaveLength(0);
  });

  it('queues the message, enqueues the job AFTER commit, and audits without the message body', async () => {
    await signedIn();
    const conversationId = await seedCustomer(openWindow());
    const result = await sendMessage({ conversationId, text: 'Yes, we have it. A secret price: 50,000', idempotencyKey: key('a') });

    expect(result).toMatchObject({ ok: true, data: { conversationId, duplicate: false } });
    if (!result.ok) return;
    const [message] = await sql()<{ status: string; provenance: string; content: string }[]>`SELECT status, provenance, content FROM messages WHERE id = ${result.data.messageId}`;
    expect(message).toMatchObject({ status: 'queued', provenance: 'owner_manual', content: 'Yes, we have it. A secret price: 50,000' });
    expect((await sendQueue.getJobs(['waiting'])).map((job) => job.id)).toEqual([`send%3A${result.data.messageId}`]);

    const entries = await audit();
    expect(entries.filter((e) => e.action === 'message.send')).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('secret price');
  });

  it('a double submit with the same key is one message and one job', async () => {
    await signedIn();
    const conversationId = await seedCustomer(openWindow());
    const [a, b] = await Promise.all([
      sendMessage({ conversationId, text: 'hi', idempotencyKey: key('dup') }),
      sendMessage({ conversationId, text: 'hi', idempotencyKey: key('dup') }),
    ]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(await count(sql(), 'messages', `direction = 'outbound'`)).toBe(1);
    expect(await sendQueue.getJobs(['waiting'])).toHaveLength(1);
  });

  it('outside the window it is REFUSED with a reason, and nothing (not even an audit entry) is written', async () => {
    await signedIn();
    const conversationId = await seedCustomer(new Date(Date.now() - HOUR));
    const result = await sendMessage({ conversationId, text: 'hi', idempotencyKey: key('late') });
    expect(result).toMatchObject({ ok: false, error: { code: 'refused', reason: 'window_closed' } });
    expect(await count(sql(), 'messages', `direction = 'outbound'`)).toBe(0);
    expect((await audit()).filter((e) => e.action === 'message.send')).toHaveLength(0);
  });

  it('refuses while sending is paused', async () => {
    await signedIn();
    const conversationId = await seedCustomer(openWindow());
    await sql()`UPDATE settings SET sending_paused = true`;
    expect(await sendMessage({ conversationId, text: 'hi', idempotencyKey: key('p') })).toMatchObject({ ok: false, error: { reason: 'sending_paused' } });
  });

  it.each([
    ['a non-uuid conversation', { conversationId: 'nope', text: 'hi', idempotencyKey: key('v1') }],
    ['a missing key', { conversationId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', text: 'hi' }],
    ['a short key', { conversationId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', text: 'hi', idempotencyKey: 'short' }],
    ['a key that could collide with a resend key', { conversationId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', text: 'hi', idempotencyKey: 'resend:0190aaaa-bbbb-7ccc' }],
    ['absurdly long text', { conversationId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', text: 'x'.repeat(20_001), idempotencyKey: key('v2') }],
  ])('validates input: %s', async (_name, input) => {
    await signedIn();
    expect(await sendMessage(input)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('refuses a placeholder (the draft flow relies on this) with a readable message', async () => {
    await signedIn();
    const conversationId = await seedCustomer(openWindow());
    const result = await sendMessage({ conversationId, text: 'Price is [[price]]', idempotencyKey: key('ph') });
    expect(result).toMatchObject({ ok: false, error: { code: 'refused', reason: 'placeholder_unresolved' } });
  });
});

describe('templates through the real actions', () => {
  const tpl = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hi {{1}}, your order is ready.' }],
    ...over,
  });

  it('lists the account’s templates for the owner only', async () => {
    stubNetwork({ graphTemplates: () => jsonResponse({ data: [tpl('order_ready'), tpl('old', { status: 'REJECTED' })] }) });
    expect(await listTemplates({})).toMatchObject({ ok: false, error: { code: 'unauthorized' } });

    await signedIn();
    const result = await listTemplates({ refresh: true });
    expect(result.ok && result.data.templates.map((t) => `${t.name}:${t.supported}`)).toEqual(['order_ready:true', 'old:false']);
  });

  it('reports a Meta outage as a refusal the owner can read', async () => {
    stubNetwork({ graphTemplates: () => jsonResponse({}, 503) });
    await signedIn();
    expect(await listTemplates({ refresh: true })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'templates_unavailable' } });
  });

  it('sends a template outside the window: values checked, components in the job, rendered text stored, audit without values', async () => {
    stubNetwork({ graphTemplates: () => jsonResponse({ data: [tpl('order_ready')] }) });
    await signedIn();
    const conversationId = await seedCustomer(new Date(Date.now() - 48 * HOUR));
    await listTemplates({});

    const result = await sendTemplate({ conversationId, templateKey: 'order_ready/en', values: { '1': 'Amina' }, idempotencyKey: key('t1') });
    expect(result).toMatchObject({ ok: true, data: { conversationId } });
    if (!result.ok) return;

    const [message] = await sql()<{ type: string; content: string; template_name: string; status: string }[]>`SELECT type, content, template_name, status FROM messages WHERE id = ${result.data.messageId}`;
    expect(message).toEqual({ type: 'template', content: 'Hi Amina, your order is ready.', template_name: 'order_ready', status: 'queued' });
    const [job] = await sendQueue.getJobs(['waiting']);
    expect(job?.data).toEqual({
      messageId: result.data.messageId,
      template: { name: 'order_ready', language: 'en', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Amina' }] }] },
    });
    const entry = (await audit()).find((e) => e.action === 'message.send_template');
    expect(entry?.metadata).toMatchObject({ template: 'order_ready', language: 'en' });
    expect(JSON.stringify(entry)).not.toContain('Amina');
  });

  it('refuses when the cache is cold (the action never calls Meta inside a transaction), an unknown template, a bad value, a paused template', async () => {
    const net = stubNetwork({ graphTemplates: () => jsonResponse({ data: [tpl('order_ready'), tpl('paused_one', { status: 'PAUSED' })] }) });
    await signedIn();
    const conversationId = await seedCustomer(openWindow());

    const cold = await sendTemplate({ conversationId, templateKey: 'order_ready/en', values: { '1': 'A' }, idempotencyKey: key('c1') });
    expect(cold).toMatchObject({ ok: false, error: { reason: 'templates_unavailable' } });
    expect(net.templates).toHaveLength(0);

    await loadTemplates({ force: true });
    expect(await sendTemplate({ conversationId, templateKey: 'nope/en', values: {}, idempotencyKey: key('c2') })).toMatchObject({ ok: false, error: { reason: 'template_not_found' } });
    expect(await sendTemplate({ conversationId, templateKey: 'order_ready/en', values: { '1': 'two\nlines' }, idempotencyKey: key('c3') })).toMatchObject({ ok: false, error: { reason: 'template_invalid' } });
    expect(await sendTemplate({ conversationId, templateKey: 'order_ready/en', values: {}, idempotencyKey: key('c4') })).toMatchObject({ ok: false, error: { reason: 'template_invalid' } });
    expect(await sendTemplate({ conversationId, templateKey: 'paused_one/en', values: { '1': 'A' }, idempotencyKey: key('c5') })).toMatchObject({ ok: false, error: { reason: 'template_invalid' } });
    expect(await count(sql(), 'messages', `direction = 'outbound'`)).toBe(0);
  });
});

describe('owner repairs through the real actions', () => {
  it('markSent / resend work on an unknown message and are audited; a second resend is refused', async () => {
    await signedIn();
    const conversationId = await seedCustomer(openWindow());
    const unknownA = await seedMessage(sql(), conversationId, { direction: 'outbound', status: 'unknown', wamid: null, content: 'first', occurredAt: NOW });
    const unknownB = await seedMessage(sql(), conversationId, { direction: 'outbound', status: 'unknown', wamid: null, content: 'second', occurredAt: NOW });

    expect(await markSent({ messageId: unknownA })).toMatchObject({ ok: true });
    expect((await sql()<{ status: string }[]>`SELECT status FROM messages WHERE id = ${unknownA}`)[0]?.status).toBe('sent');
    expect(await markSent({ messageId: unknownA })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'not_unknown' } });

    const resent = await resend({ messageId: unknownB });
    expect(resent).toMatchObject({ ok: true });
    expect((await sendQueue.getJobs(['waiting'])).length).toBe(1);
    expect(await resend({ messageId: unknownB })).toMatchObject({ ok: false, error: { reason: 'not_unknown' } });
    expect((await audit()).map((e) => e.action)).toEqual(expect.arrayContaining(['message.mark_sent', 'message.resend']));
  });

  it('are rejected without a session', async () => {
    expect(await markSent({ messageId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(await resend({ messageId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });
});
