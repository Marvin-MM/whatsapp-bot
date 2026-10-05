import { describe, expect, it, vi } from 'vitest';
import * as enqueueModule from '@/lib/queue/enqueue';
import { getDb } from '@/lib/db';
import { processWebhookEvent } from '@/lib/ingest/process-event';
import { FIXTURE } from '../helpers/fixtures';
import { HOUR, NOW, T0, count, envelopeOf, ingestFixture, ingestPayload, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();

type MessageRow = { id: string; wamid: string | null; status: string; direction: string; error: { kind: string; code: string | null; message: string } | null; conversation_id: string };
const messageByWamid = async (wamid: string) => (await sql()<MessageRow[]>`SELECT * FROM messages WHERE wamid = ${wamid}`)[0];
const messageById = async (id: string) => (await sql()<MessageRow[]>`SELECT * FROM messages WHERE id = ${id}`)[0];
const alertCount = (kind: string) => count(sql(), 'notifications', `kind = 'alert:${kind}'`);

async function seedOutbound(wamid: string | null, status: string, id?: string): Promise<{ conversationId: string; messageId: string }> {
  const contact = await seedContact(sql(), { bsuid: FIXTURE.amina.bsuid, phone: `+${FIXTURE.amina.wa}` });
  const conversationId = await seedConversation(sql(), contact, { status: 'waiting_on_customer' });
  const messageId = await seedMessage(sql(), conversationId, { ...(id ? { id } : {}), direction: 'outbound', wamid, status, provenance: 'owner_manual' });
  return { conversationId, messageId };
}

describe('delivery statuses', () => {
  it('moves a message forward sent -> delivered -> read and tells the dashboard each time', async () => {
    const { conversationId } = await seedOutbound('wamid.OUT.TEXT.1', 'queued');

    await ingestFixture('status-sent');
    expect((await messageByWamid('wamid.OUT.TEXT.1'))?.status).toBe('sent');
    await ingestFixture('status-delivered');
    expect((await messageByWamid('wamid.OUT.TEXT.1'))?.status).toBe('delivered');
    await ingestFixture('status-read');
    expect((await messageByWamid('wamid.OUT.TEXT.1'))?.status).toBe('read');

    const events = (await h.events()).filter((event) => event.type === 'message:status');
    expect(events.map((event) => (event.type === 'message:status' ? event.payload.status : null))).toEqual(['sent', 'delivered', 'read']);
    expect(events.every((event) => event.type === 'message:status' && event.payload.conversationId === conversationId)).toBe(true);
  });

  it('NEVER moves a status backward: a late "delivered" after "read" changes nothing and emits nothing', async () => {
    await seedOutbound('wamid.OUT.TEXT.1', 'sent');
    await ingestFixture('status-read');
    const before = (await h.events()).length;

    await ingestFixture('status-delivered');
    await ingestFixture('status-sent');

    expect((await messageByWamid('wamid.OUT.TEXT.1'))?.status).toBe('read');
    expect((await h.events()).length).toBe(before);
  });

  it('treats "played" (a voice note listened to) as read', async () => {
    await seedOutbound('wamid.OUT.AUD.1', 'delivered');
    await ingestFixture('status-played');
    expect((await messageByWamid('wamid.OUT.AUD.1'))?.status).toBe('read');
  });

  it('records a failure with Meta’s code and reason', async () => {
    await seedOutbound('wamid.OUT.FAIL.1', 'sent');
    await ingestFixture('status-failed');
    expect(await messageByWamid('wamid.OUT.FAIL.1')).toMatchObject({ status: 'failed', error: { kind: 'permanent', code: '131047' } });
    expect((await messageByWamid('wamid.OUT.FAIL.1'))?.error?.message).toMatch(/24 hours/);
  });

  it('a late failure report cannot undo a read (read proves delivery)', async () => {
    await seedOutbound('wamid.OUT.FAIL.1', 'read');
    await ingestFixture('status-failed');
    expect(await messageByWamid('wamid.OUT.FAIL.1')).toMatchObject({ status: 'read', error: null });
  });

  it('recovers an ambiguous send: an `unknown` message that Meta later reports delivered was sent after all', async () => {
    await seedOutbound('wamid.OUT.TEXT.1', 'unknown');
    await ingestFixture('status-delivered');
    expect((await messageByWamid('wamid.OUT.TEXT.1'))?.status).toBe('delivered');
  });

  it('matches a status that beats our own wamid write through biz_opaque_callback_data, and records the wamid', async () => {
    const id = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
    await seedOutbound(null, 'queued', id);

    await ingestFixture('status-bsuid-recipient');

    expect(await messageById(id)).toMatchObject({ wamid: 'wamid.OUT.BSUID.1', status: 'delivered' });
  });

  it('heals the realistic stuck case: an `unknown` message with NO wamid is found by our callback id when Meta reports it delivered', async () => {
    const id = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
    await seedOutbound(null, 'unknown', id);

    await ingestFixture('status-bsuid-recipient');

    expect(await messageById(id)).toMatchObject({ wamid: 'wamid.OUT.BSUID.1', status: 'delivered' });
  });

  it('does not let a callback id hijack a message that already has a different wamid', async () => {
    const id = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
    await seedOutbound('wamid.SOMETHING.ELSE', 'sent', id);

    await ingestFixture('status-bsuid-recipient', { finalAttempt: true });

    expect(await messageById(id)).toMatchObject({ wamid: 'wamid.SOMETHING.ELSE', status: 'sent' });
  });

  it('retries a status for a message that is not in the database yet, and settles quietly on the last attempt', async () => {
    await expect(ingestFixture('status-delivered', { finalAttempt: false })).rejects.toMatchObject({ name: 'RetryLaterError' });
    const [waiting] = await sql()<Array<{ processed_at: Date | null; last_error: string }>>`SELECT processed_at, last_error FROM webhook_events`;
    expect(waiting?.processed_at).toBeNull();
    expect(waiting?.last_error).toBe('status_for_unknown_message');

    // The message row lands (the send worker committed); the next attempt applies the status.
    await seedOutbound('wamid.OUT.TEXT.1', 'sent');
    const retry = await ingestFixture('status-delivered', { finalAttempt: false });
    expect(retry.outcomes).toEqual(['processed']);
    expect((await messageByWamid('wamid.OUT.TEXT.1'))?.status).toBe('delivered');
  });

  it('gives up on a status for a message we will never have (e.g. sent before we were connected) without raising an alert', async () => {
    const result = await ingestFixture('status-delivered', { finalAttempt: true });
    expect(result.outcomes).toEqual(['processed']);
    const [event] = await sql()<Array<{ last_error: string; processed_at: Date | null }>>`SELECT last_error, processed_at FROM webhook_events`;
    expect(event?.last_error).toBe('status_for_unknown_message');
    expect(event?.processed_at).not.toBeNull();
    expect(await count(sql(), 'notifications')).toBe(0);
  });

  it('ignores a status value it does not know instead of guessing', async () => {
    await seedOutbound('wamid.OUT.TEXT.1', 'sent');
    const payload = envelopeOf('messages', { statuses: [{ id: 'wamid.OUT.TEXT.1', status: 'deleted', timestamp: '1791100003', recipient_id: FIXTURE.amina.wa }] });
    expect((await ingestPayload(payload)).outcomes).toEqual(['processed']);
    expect((await messageByWamid('wamid.OUT.TEXT.1'))?.status).toBe('sent');
  });

  it('never touches an inbound message', async () => {
    const contact = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}` });
    const convo = await seedConversation(sql(), contact);
    await seedMessage(sql(), convo, { direction: 'inbound', wamid: 'wamid.OUT.TEXT.1' });
    await ingestFixture('status-read');
    expect((await messageByWamid('wamid.OUT.TEXT.1'))?.status).toBe('received');
  });

  it('does not change the window or the conversation status', async () => {
    const { conversationId } = await seedOutbound('wamid.OUT.TEXT.1', 'sent');
    await ingestFixture('status-read');
    const [conversation] = await sql()<Array<{ status: string; window_expires_at: Date | null; last_inbound_at: Date | null }>>`SELECT * FROM conversations WHERE id = ${conversationId}`;
    expect(conversation).toMatchObject({ status: 'waiting_on_customer', window_expires_at: null, last_inbound_at: null });
  });
});

describe('identity changes', () => {
  const PREVIOUS = FIXTURE.amina.bsuid;
  const CURRENT = 'UG.55555555555555555555';

  it('user_id_update rewrites the BSUID of the contact we know', async () => {
    const contact = await seedContact(sql(), { bsuid: PREVIOUS, phone: `+${FIXTURE.amina.wa}` });
    await ingestFixture('user-id-update');
    const [row] = await sql()<Array<{ id: string; bsuid: string; phone_e164: string }>>`SELECT id, bsuid, phone_e164 FROM contacts`;
    expect(row).toMatchObject({ id: contact, bsuid: CURRENT, phone_e164: `+${FIXTURE.amina.wa}` });
    expect(await count(sql(), 'audit_log', `action = 'contact.bsuid_rewritten'`)).toBe(1);
  });

  it('after the rewrite, a message under the NEW id lands in the same conversation', async () => {
    const contact = await seedContact(sql(), { bsuid: PREVIOUS, phone: `+${FIXTURE.amina.wa}` });
    const convo = await seedConversation(sql(), contact);
    await ingestFixture('user-id-update');

    await ingestPayload(
      envelopeOf('messages', {
        contacts: [{ wa_id: FIXTURE.amina.wa, user_id: CURRENT, profile: { name: 'Amina' } }],
        messages: [{ id: 'wamid.AFTER.1', from: FIXTURE.amina.wa, from_user_id: CURRENT, timestamp: '1791100100', type: 'text', text: { body: 'hi again' } }],
      }),
    );
    expect(await count(sql(), 'contacts')).toBe(1);
    expect(await count(sql(), 'messages', `conversation_id = '${convo}'`)).toBe(1);
  });

  it('MERGES when a message with the new id raced ahead of the notice and created a second record', async () => {
    const older = await seedContact(sql(), { bsuid: PREVIOUS, phone: `+${FIXTURE.amina.wa}`, name: 'Amina' });
    const olderConvo = await seedConversation(sql(), older);
    await seedMessage(sql(), olderConvo, { wamid: 'wamid.OLD.1', occurredAt: new Date(T0.getTime() - 5 * HOUR) });
    const newer = await seedContact(sql(), { bsuid: CURRENT });
    const newerConvo = await seedConversation(sql(), newer);
    await seedMessage(sql(), newerConvo, { wamid: 'wamid.NEW.1', occurredAt: T0 });

    await ingestFixture('user-id-update');

    const contacts = await sql()<Array<{ id: string; bsuid: string; phone_e164: string }>>`SELECT id, bsuid, phone_e164 FROM contacts`;
    expect(contacts).toEqual([expect.objectContaining({ id: older, bsuid: CURRENT, phone_e164: `+${FIXTURE.amina.wa}` })]);
    expect(await count(sql(), 'conversations')).toBe(1);
    expect(await count(sql(), 'messages', `conversation_id = '${olderConvo}'`)).toBe(2);
    const [conversation] = await sql()<Array<{ last_inbound_at: Date }>>`SELECT last_inbound_at FROM conversations`;
    expect(conversation?.last_inbound_at).toEqual(T0);
  });

  it('a late message from the OLD id (Meta retries for ~36h) joins the same person instead of creating a phantom contact', async () => {
    const contact = await seedContact(sql(), { bsuid: PREVIOUS, phone: `+${FIXTURE.amina.wa}`, name: 'Amina' });
    const convo = await seedConversation(sql(), contact);
    await ingestFixture('user-id-update');

    // A message written before the change arrives after the notice, still carrying the old id.
    await ingestFixture('text-message');

    expect(await count(sql(), 'contacts')).toBe(1);
    expect((await sql()<Array<{ bsuid: string }>>`SELECT bsuid FROM contacts`)[0]?.bsuid).toBe(CURRENT);
    expect(await count(sql(), 'messages', `conversation_id = '${convo}'`)).toBe(1);
    expect(await count(sql(), 'notifications', `kind = 'alert:identity_conflict'`)).toBe(0);
  });

  it('recognises an id that was renamed twice', async () => {
    const MIDDLE = 'UG.44444444444444444444';
    const contact = await seedContact(sql(), { bsuid: MIDDLE, phone: `+${FIXTURE.amina.wa}` });
    await seedConversation(sql(), contact);
    // original -> middle (already applied earlier), middle -> current (this notice)
    await sql()`INSERT INTO webhook_events (id, dedupe_key, kind, payload, processed_at) VALUES (gen_random_uuid(), ${`uidupd:${PREVIOUS}:${MIDDLE}`}, 'user_id_update', NULL, now())`;
    await ingestPayload(envelopeOf('user_id_update', { user_id_update: [{ wa_id: FIXTURE.amina.wa, user_id: { previous: MIDDLE, current: CURRENT } }] }));

    await ingestFixture('text-message'); // still carries the very first id

    expect(await count(sql(), 'contacts')).toBe(1);
    expect(await count(sql(), 'notifications', `kind = 'alert:identity_conflict'`)).toBe(0);
  });

  it('but an id that was NEVER this person’s is still treated as a different person on a number we hold', async () => {
    const contact = await seedContact(sql(), { bsuid: CURRENT, phone: `+${FIXTURE.amina.wa}` });
    await seedConversation(sql(), contact);
    await ingestFixture('text-message'); // bsuid UG.1349... + the same phone, with no rename on record

    expect(await count(sql(), 'contacts')).toBe(2);
    expect(await count(sql(), 'notifications', `kind = 'alert:identity_conflict'`)).toBe(1);
  });

  it('ignores an update about someone we have never talked to, and says so', async () => {
    await ingestFixture('user-id-update');
    expect(await count(sql(), 'contacts')).toBe(0);
    const [event] = await sql()<Array<{ last_error: string }>>`SELECT last_error FROM webhook_events`;
    expect(event?.last_error).toBe('user_id_update_no_matching_contact');
  });

  it('a system notice "user changed number" updates the phone; it is not a chat message and never touches the thread', async () => {
    const contact = await seedContact(sql(), { bsuid: PREVIOUS, phone: `+${FIXTURE.amina.wa}` });
    const convo = await seedConversation(sql(), contact, { status: 'waiting_on_customer' });

    await ingestFixture('system-user-changed-number');

    const [row] = await sql()<Array<{ id: string; phone_e164: string }>>`SELECT id, phone_e164 FROM contacts`;
    expect(row).toMatchObject({ id: contact, phone_e164: '+256700999888' });
    expect(await count(sql(), 'messages')).toBe(0);
    const [conversation] = await sql()<Array<{ status: string; last_inbound_at: Date | null }>>`SELECT status, last_inbound_at FROM conversations WHERE id = ${convo}`;
    expect(conversation).toMatchObject({ status: 'waiting_on_customer', last_inbound_at: null });
    expect(await h.events()).toHaveLength(0);
  });

  it('a system notice about a stranger does not create a contact', async () => {
    await ingestFixture('system-user-changed-number');
    expect(await count(sql(), 'contacts')).toBe(0);
    expect(await count(sql(), 'messages')).toBe(0);
  });

  it('a system notice "user changed user id" rewrites the BSUID', async () => {
    await seedContact(sql(), { bsuid: PREVIOUS, phone: `+${FIXTURE.amina.wa}` });
    await ingestPayload(
      envelopeOf('messages', {
        messages: [
          { id: 'wamid.SYS.2', from: FIXTURE.amina.wa, from_user_id: CURRENT, timestamp: '1791100000', type: 'system', system: { type: 'user_changed_user_id', user_id: CURRENT, previous_user_id: PREVIOUS } },
        ],
      }),
    );
    expect((await sql()<Array<{ bsuid: string }>>`SELECT bsuid FROM contacts`)[0]?.bsuid).toBe(CURRENT);
    expect(await count(sql(), 'messages')).toBe(0);
  });

  it('records marketing-preference changes without acting on them (v1 sends no marketing)', async () => {
    const result = await ingestFixture('user-preferences');
    expect(result.outcomes).toEqual(['processed']);
    const [event] = await sql()<Array<{ last_error: string }>>`SELECT last_error FROM webhook_events`;
    expect(event?.last_error).toBe('user_preferences_recorded');
  });
});

describe('account and quality events', () => {
  it('raises a critical alert when the partner is removed, once, and not again on a replay', async () => {
    await ingestFixture('account-partner-removed');
    expect(await alertCount('account_partner_removed')).toBe(1);
    await sql()`UPDATE webhook_events SET processed_at = NULL`;
    await ingestFixture('account-partner-removed');
    expect(await alertCount('account_partner_removed')).toBe(1);
    expect((await h.events()).filter((event) => event.type === 'alert')).toHaveLength(1);
  });

  it('raises it AGAIN when it genuinely happens again later (a different entry time is a different event)', async () => {
    const removal = (time: number) => envelopeOf('account_update', { event: 'PARTNER_REMOVED', waba_id: '100000000000002' }, time);
    await ingestPayload(removal(1791100000));
    await ingestPayload(removal(1791200000));
    expect(await alertCount('account_partner_removed')).toBe(2);
  });

  it('alerts on offboarding, a flagged quality rating and a parked payload; stays quiet on events that need no action', async () => {
    await ingestFixture('account-offboarded');
    await ingestFixture('account-reconnected');
    await ingestFixture('quality-update');
    await ingestFixture('malformed-messages-value');
    expect(await alertCount('account_offboarded')).toBe(1);
    expect(await alertCount('account_reconnected')).toBe(1);
    expect(await alertCount('phone_quality_degraded')).toBe(1);
    expect(await alertCount('webhook_unparseable')).toBe(1);

    const total = await count(sql(), 'notifications');
    await ingestFixture('template-status-update');
    await ingestFixture('unknown-field');
    expect(await count(sql(), 'notifications')).toBe(total);
    expect(await count(sql(), 'webhook_events', 'processed_at IS NULL')).toBe(0);
  });

  it('keeps the raw payload of anything it parked, so nothing Meta sent is lost', async () => {
    await ingestFixture('malformed-messages-value');
    expect(await count(sql(), 'webhook_events', `kind = 'other' AND payload IS NOT NULL`)).toBe(1);
  });
});

describe('processing edge cases', () => {
  const insertEvent = (key: string, kind: string, payload: unknown) =>
    sql()`INSERT INTO webhook_events (id, dedupe_key, kind, payload) VALUES (gen_random_uuid(), ${key}, ${kind}, ${payload === null ? null : sql().json(payload as never)})`;

  it('answers "missing" for an unknown key and "already_processed" for a replay, doing nothing in both', async () => {
    expect(await processWebhookEvent('msg:does-not-exist', { finalAttempt: true })).toBe('missing');
    await ingestFixture('text-message');
    expect(await processWebhookEvent('msg:wamid.IN.TEXT.1', { finalAttempt: true })).toBe('already_processed');
  });

  it('settles a purged payload and an unknown kind instead of retrying them forever', async () => {
    await insertEvent('msg:purged', 'message', null);
    await insertEvent('x:unknown', 'carrier-pigeon', { a: 1 });
    expect(await processWebhookEvent('msg:purged', { finalAttempt: false })).toBe('parked');
    expect(await processWebhookEvent('x:unknown', { finalAttempt: false })).toBe('parked');
    const rows = await sql()<Array<{ dedupe_key: string; last_error: string; processed_at: Date | null }>>`SELECT dedupe_key, last_error, processed_at FROM webhook_events ORDER BY dedupe_key`;
    expect(rows.map((row) => [row.dedupe_key, row.last_error, row.processed_at !== null])).toEqual([
      ['msg:purged', 'payload_purged', true],
      ['x:unknown', 'unknown_event_kind', true],
    ]);
  });

  it('parks a stored item that fails validation (it never will pass) with an alert, rather than failing the job forever', async () => {
    await insertEvent('msg:invalid', 'message', { field: 'messages', message: { type: 'text' } });
    expect(await processWebhookEvent('msg:invalid', { finalAttempt: false })).toBe('parked');
    const [row] = await sql()<Array<{ last_error: string; processed_at: Date | null }>>`SELECT last_error, processed_at FROM webhook_events`;
    expect(row?.last_error).toMatch(/^zod: /);
    expect(row?.processed_at).not.toBeNull();
    expect(await alertCount('webhook_item_invalid')).toBe(1);
  });

  it('a failed enqueue AFTER the commit fails the job, keeps the message, and the retry finishes the job without duplicating anything', async () => {
    const spy = vi.spyOn(enqueueModule, 'enqueue').mockRejectedValueOnce(new Error('redis is down'));
    try {
      await expect(ingestFixture('image-caption')).rejects.toThrow('redis is down');
    } finally {
      spy.mockRestore();
    }
    expect(await count(sql(), 'messages')).toBe(1);
    const [pending] = await sql()<Array<{ processed_at: Date | null; last_error: string }>>`SELECT processed_at, last_error FROM webhook_events`;
    expect(pending?.processed_at).toBeNull();
    expect(pending?.last_error).toContain('redis is down');
    expect(await h.mediaJobs()).toHaveLength(0);

    const retried = await processWebhookEvent('msg:wamid.IN.IMG.1', { finalAttempt: false, now: NOW, db: getDb() });
    expect(retried).toBe('processed');
    expect(await count(sql(), 'messages')).toBe(1);
    expect(await h.mediaJobs()).toHaveLength(1);
  });

  it('records a content-free reason when a handler throws (never a message body)', async () => {
    const spy = vi.spyOn(enqueueModule, 'enqueue').mockRejectedValueOnce(new Error('boom'));
    try {
      await expect(ingestFixture('image-caption')).rejects.toThrow('boom');
    } finally {
      spy.mockRestore();
    }
    const [row] = await sql()<Array<{ last_error: string }>>`SELECT last_error FROM webhook_events`;
    expect(row?.last_error).not.toContain('This one?');
  });
});
