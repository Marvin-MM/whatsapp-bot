import { describe, expect, it } from 'vitest';
import { FIXTURE } from '../helpers/fixtures';
import { HOUR, T0, cloneFixture, count, envelopeOf, ingestFixture, ingestPayload, seedContact, seedConversation, seedDraft, seedMessage, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();

type MessageRow = {
  id: string;
  conversation_id: string;
  direction: string;
  provenance: string;
  status: string;
  type: string;
  content: string | null;
  media_id: string | null;
  occurred_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
};
const messageRow = async (wamid: string) => (await sql()<MessageRow[]>`SELECT * FROM messages WHERE wamid = ${wamid}`)[0];

type ConversationRow = { id: string; contact_id: string; status: string; last_inbound_at: Date | null; last_message_at: Date | null; window_expires_at: Date | null; consecutive_auto_replies: number };
const conversationRow = async (id: string) => (await sql()<ConversationRow[]>`SELECT * FROM conversations WHERE id = ${id}`)[0];

const alertCount = (kind: string) => count(sql(), 'notifications', `kind = 'alert:${kind}'`);

describe('echoes: the owner replied from the WhatsApp Business app', () => {
  it('stores it as the owner’s own outbound message, in the right conversation, with the provenance the style learner reads', async () => {
    await ingestFixture('text-message');
    const customerMessage = await messageRow('wamid.IN.TEXT.1');

    expect((await ingestFixture('echo-message-echoes')).outcomes).toEqual(['processed']);

    const echo = await messageRow('wamid.ECHO.1');
    expect(echo).toMatchObject({ direction: 'outbound', provenance: 'owner_app_echo', status: 'sent', type: 'text', content: 'Sent from the WhatsApp Business app.' });
    expect(echo?.conversation_id).toBe(customerMessage?.conversation_id);
    expect(await count(sql(), 'contacts')).toBe(1);
  });

  it('NEVER opens or extends the 24h window (only the customer can), but does move the thread to waiting_on_customer and reset the auto-reply counter', async () => {
    await ingestFixture('text-message');
    const customerMessage = await messageRow('wamid.IN.TEXT.1');
    await sql()`UPDATE conversations SET consecutive_auto_replies = 3`;

    await ingestFixture('echo-message-echoes');

    const conversation = await conversationRow(customerMessage?.conversation_id ?? '');
    expect(conversation?.last_inbound_at).toEqual(T0);
    expect(conversation?.window_expires_at).toEqual(new Date(T0.getTime() + 24 * HOUR));
    expect(conversation?.last_message_at).toEqual(new Date(1791100020 * 1000));
    expect(conversation?.status).toBe('waiting_on_customer');
    expect(conversation?.consecutive_auto_replies).toBe(0);
  });

  it('only the customer’s LIVE messages define the window: not a reaction, not an imported inbound message, even when another event triggers the recompute', async () => {
    const contact = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}` });
    const convo = await seedConversation(sql(), contact, { status: 'resolved' });
    // The reaction is NEWER than the echo, so counting it for last_message_at (or the window) would visibly change the answer.
    await seedMessage(sql(), convo, { direction: 'inbound', type: 'reaction', content: '👍', occurredAt: new Date(T0.getTime() + 60_000) });
    await seedMessage(sql(), convo, { direction: 'inbound', provenance: 'imported', occurredAt: new Date(T0.getTime() - 120_000) });

    await ingestFixture('echo-message-echoes'); // recomputes this conversation's aggregates

    const conversation = await conversationRow(convo);
    expect(conversation?.last_inbound_at).toBeNull();
    expect(conversation?.window_expires_at).toBeNull();
    expect(conversation?.last_message_at).toEqual(new Date(1791100020 * 1000)); // the reaction does not count here either
  });

  it('a conversation that only the owner has written to has NO window at all', async () => {
    await ingestFixture('echo-message-echoes');
    const echo = await messageRow('wamid.ECHO.1');
    const conversation = await conversationRow(echo?.conversation_id ?? '');
    expect(conversation?.last_inbound_at).toBeNull();
    expect(conversation?.window_expires_at).toBeNull();
    expect(conversation?.status).toBe('waiting_on_customer');
  });

  it('supersedes every open draft: the owner already answered', async () => {
    await ingestFixture('text-message');
    const convo = (await messageRow('wamid.IN.TEXT.1'))?.conversation_id ?? '';
    const pending = await seedDraft(sql(), convo, 'pending');
    const scheduled = await seedDraft(sql(), convo, 'scheduled');
    const edited = await seedDraft(sql(), convo, 'edited');

    await ingestFixture('echo-message-echoes');

    const rows = await sql()<Array<{ id: string; status: string }>>`SELECT id, status FROM drafts`;
    const statusOf = (id: string) => rows.find((row) => row.id === id)?.status;
    expect([statusOf(pending), statusOf(scheduled), statusOf(edited)]).toEqual(['superseded', 'superseded', 'edited']);
  });

  it('finds the customer by a BSUID recipient too', async () => {
    await ingestFixture('bsuid-only-sender');
    const customer = await messageRow('wamid.IN.BSUID.1');
    await ingestFixture('echo-to-bsuid');
    expect((await messageRow('wamid.ECHO.3'))?.conversation_id).toBe(customer?.conversation_id);
    expect(await count(sql(), 'contacts')).toBe(1);
  });

  it('creates the contact when the owner starts a conversation from the phone', async () => {
    await ingestFixture('echo-message-echoes');
    const [contact] = await sql()<Array<{ phone_e164: string; bsuid: string | null }>>`SELECT phone_e164, bsuid FROM contacts`;
    expect(contact).toMatchObject({ phone_e164: `+${FIXTURE.amina.wa}`, bsuid: null });
  });

  it('PARKS an echo that names no recipient (the open-source shape) with an alert, instead of guessing a thread', async () => {
    await ingestFixture('text-message');
    const result = await ingestFixture('echo-messages-shape');

    expect(result.outcomes).toEqual(['processed']);
    expect(await messageRow('wamid.ECHO.2')).toBeUndefined();
    expect(await alertCount('echo_recipient_unknown')).toBe(1);
    const [event] = await sql()<Array<{ last_error: string; processed_at: Date | null }>>`SELECT last_error, processed_at FROM webhook_events WHERE kind = 'echo'`;
    expect(event?.last_error).toBe('echo_recipient_unknown');
    expect(event?.processed_at).not.toBeNull();
    // The raw payload is kept, so nothing Meta sent is lost.
    expect(await count(sql(), 'webhook_events', `kind = 'echo' AND payload IS NOT NULL`)).toBe(1);
  });

  it('is idempotent', async () => {
    await ingestFixture('echo-message-echoes');
    await sql()`UPDATE webhook_events SET processed_at = NULL`;
    await ingestFixture('echo-message-echoes');
    expect(await count(sql(), 'messages')).toBe(1);
    expect(await count(sql(), 'contacts')).toBe(1);
  });

  it('applies an owner edit and an owner delete made in the app to the original echo', async () => {
    await ingestFixture('echo-message-echoes');
    await ingestFixture('echo-edit');
    expect(await messageRow('wamid.ECHO.1')).toMatchObject({ content: 'Edited from the app' });
    expect((await messageRow('wamid.ECHO.1'))?.edited_at).not.toBeNull();

    await ingestFixture('echo-revoke');
    const revoked = await messageRow('wamid.ECHO.1');
    expect(revoked?.content).toBeNull();
    expect(revoked?.deleted_at).not.toBeNull();
    expect(await count(sql(), 'messages')).toBe(1);
  });

  it('does not confuse an owner-side edit with a customer message that shares an id shape', async () => {
    // An inbound message with the same wamid as an outbound one must not be edited by an echo (directions are scoped).
    const convo = await seedConversation(sql(), await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}` }));
    await seedMessage(sql(), convo, { direction: 'inbound', wamid: 'wamid.ECHO.1', content: 'customer text' });
    await ingestFixture('echo-edit', { finalAttempt: true });
    expect(await messageRow('wamid.ECHO.1')).toMatchObject({ content: 'customer text' });
  });
});

describe('history sync', () => {
  it('imports the customer’s messages into a RESOLVED conversation and opens no window from the past', async () => {
    const result = await ingestFixture('history-flat-phase1');
    expect(result.outcomes).toEqual(['processed']);

    const inbound = await messageRow('wamid.HIST.1');
    expect(inbound).toMatchObject({ direction: 'inbound', provenance: 'customer', status: 'received', content: "Can you confirm tomorrow's appointment?" });
    const conversation = await conversationRow(inbound?.conversation_id ?? '');
    expect(conversation?.status).toBe('resolved');
    expect(conversation?.last_inbound_at).toEqual(new Date(1787644000 * 1000));
    // Months old: the window is long closed, which is exactly what it should say.
    expect(conversation?.window_expires_at?.getTime()).toBeLessThan(T0.getTime());
  });

  it('does NOT file an owner-side message that names no customer (flat chunk): it is counted, alerted, never guessed', async () => {
    await ingestFixture('history-flat-phase1');
    expect(await messageRow('wamid.HIST.2')).toBeUndefined();
    expect(await alertCount('history_unattributed')).toBe(1);
    const [event] = await sql()<Array<{ last_error: string }>>`SELECT last_error FROM webhook_events`;
    expect(event?.last_error).toBe('history_unattributed:1');
  });

  it('imports both sides when the chunk is threaded: customer = thread id, owner side = imported with its delivery state', async () => {
    await ingestFixture('history-threads');

    expect(await messageRow('wamid.HIST.T1')).toMatchObject({ direction: 'inbound', provenance: 'customer', status: 'received' });
    expect(await messageRow('wamid.HIST.T2')).toMatchObject({ direction: 'outbound', provenance: 'imported', status: 'read', content: 'Yes, 10k delivery.' });
    expect(await count(sql(), 'contacts')).toBe(1);
    expect(await count(sql(), 'conversations')).toBe(1);
    expect(await alertCount('history_unattributed')).toBe(0);
  });

  it('is quiet: no drafts, no per-message dashboard events, no status change on a conversation that is already live', async () => {
    await ingestFixture('text-message');
    const convo = (await messageRow('wamid.IN.TEXT.1'))?.conversation_id ?? '';
    const draft = await seedDraft(sql(), convo, 'pending');
    const before = (await h.events()).length;

    await ingestFixture('history-threads');

    expect((await h.events()).length).toBe(before);
    const conversation = await conversationRow(convo);
    expect(conversation?.status).toBe('waiting_on_me');
    expect(conversation?.last_inbound_at).toEqual(T0);
    expect((await sql()<Array<{ status: string }>>`SELECT status FROM drafts WHERE id = ${draft}`)[0]?.status).toBe('pending');
    expect(await count(sql(), 'messages', `conversation_id = '${convo}'`)).toBe(3);
  });

  it('a duplicate chunk is deduplicated, and even a differently-keyed chunk with the same messages inserts nothing twice', async () => {
    await ingestFixture('history-threads');
    expect((await ingestFixture('history-threads')).keys).toEqual([]);

    const variant = cloneFixture('history-threads') as { entry: Array<{ changes: Array<{ value: { request_id: string } }> }> };
    const value = variant.entry[0]?.changes[0]?.value;
    if (value) value.request_id = 'req_hist_other';
    const second = await ingestPayload(variant);
    expect(second.outcomes).toEqual(['processed']);
    expect(await count(sql(), 'messages')).toBe(2);
  });

  it('chunks may arrive in any order and still produce the same data', async () => {
    await ingestFixture('history-complete');
    await ingestFixture('history-flat-phase1');
    await ingestFixture('history-group-excluded');
    expect(await count(sql(), 'messages')).toBe(3);
    expect(await count(sql(), 'conversations', `status = 'resolved'`)).toBe(2);
  });

  it('keeps a recent media message’s file reference and fetches it; an old one (no id) is kept as text and fetches nothing', async () => {
    await ingestFixture('history-media-recent');
    const recent = await messageRow('wamid.HIST.MEDIA.1');
    expect(recent).toMatchObject({ type: 'image', media_id: 'MEDIA_HIST_1', content: 'Receipt photo' });
    expect((await h.mediaJobs()).map((job) => job.messageId)).toEqual([recent?.id]);

    await h.clearMediaJobs();
    await ingestFixture('history-media-old');
    const old = await messageRow('wamid.HIST.MEDIA.2');
    expect(old).toMatchObject({ type: 'image', media_id: null, content: 'Older receipt photo' });
    expect(await h.mediaJobs()).toHaveLength(0);
  });

  it('says "unavailable" for old media that has no caption either', async () => {
    const payload = cloneFixture('history-media-old') as { entry: Array<{ changes: Array<{ value: { history: Array<{ messages: Array<{ image: { caption?: string } }> }> } }> }> };
    const image = payload.entry[0]?.changes[0]?.value.history[0]?.messages[0]?.image;
    if (image) delete image.caption;
    await ingestPayload(payload);
    expect((await messageRow('wamid.HIST.MEDIA.2'))?.content).toBe('[Image unavailable]');
  });

  it('raises an alert for a history-sync error and stores nothing', async () => {
    const result = await ingestFixture('history-error');
    expect(result.outcomes).toEqual(['processed']);
    expect(await alertCount('history_sync_error')).toBe(1);
    expect(await count(sql(), 'messages')).toBe(0);
  });

  it('applies a status-only chunk to a message we already hold, and ignores one for a message we do not', async () => {
    const convo = await seedConversation(sql(), await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}` }));
    await seedMessage(sql(), convo, { direction: 'outbound', wamid: 'wamid.HIST.2', status: 'sent' });
    expect((await ingestFixture('history-status-only')).outcomes).toEqual(['processed']);
    expect((await messageRow('wamid.HIST.2'))?.status).toBe('read');

    await sql()`DELETE FROM messages`;
    await sql()`DELETE FROM webhook_events`;
    expect((await ingestFixture('history-status-only')).outcomes).toEqual(['processed']);
  });

  it('refuses to guess direction when Meta does not say which number is ours', async () => {
    const payload = envelopeOf('history', {
      metadata: { phone_number_id: '100000000000001' },
      request_id: 'r1',
      history: [{ phase: 1, messages: [{ id: 'wamid.H.NOOWN', from: '256700123456', timestamp: '1787644000', type: 'text', text: { body: 'x' } }] }],
    });
    await ingestPayload(payload);
    expect(await count(sql(), 'messages')).toBe(0);
    expect(await alertCount('history_without_own_number')).toBe(1);
  });
});

describe('smb_app_state_sync: names the owner saved in the Business app', () => {
  const rename = (name: string, time: number) =>
    envelopeOf('smb_app_state_sync', { request_id: 'r1', contacts: [{ wa_id: FIXTURE.amina.wa, profile: { name } }] }, time);

  it('creates a contact with the owner’s name but no conversation: it does not appear in the inbox until they write', async () => {
    await ingestFixture('app-state-contact-add');
    const [contact] = await sql()<Array<{ phone_e164: string; display_name: string }>>`SELECT phone_e164, display_name FROM contacts`;
    expect(contact).toMatchObject({ phone_e164: `+${FIXTURE.amina.wa}`, display_name: 'Amina (saved name)' });
    expect(await count(sql(), 'conversations')).toBe(0);
  });

  it('the owner’s saved name outranks the customer’s WhatsApp profile name when they do write', async () => {
    await ingestFixture('app-state-contact-add');
    await ingestFixture('text-message');
    const [contact] = await sql()<Array<{ display_name: string; bsuid: string }>>`SELECT display_name, bsuid FROM contacts`;
    expect(contact).toMatchObject({ display_name: 'Amina (saved name)', bsuid: FIXTURE.amina.bsuid });
    expect(await count(sql(), 'contacts')).toBe(1);
  });

  it('overwrites an older name, including renaming back to a previous name (a replay-safe key must not swallow it)', async () => {
    await ingestPayload(rename('Amina', 1791100000));
    await ingestPayload(rename('A.', 1791100100));
    await ingestPayload(rename('Amina', 1791100200));
    expect((await sql()<Array<{ display_name: string }>>`SELECT display_name FROM contacts`)[0]?.display_name).toBe('Amina');
  });

  it('a replay of the same sync (same entry time) changes nothing', async () => {
    await ingestPayload(rename('Amina', 1791100000));
    expect((await ingestPayload(rename('Amina', 1791100000))).keys).toEqual([]);
  });

  it('ignores a contact the owner removed from the phone: the conversation history stays', async () => {
    await ingestFixture('text-message');
    const payload = envelopeOf('smb_app_state_sync', { request_id: 'r1', contacts: [{ wa_id: FIXTURE.amina.wa, removed: true }] });
    expect((await ingestPayload(payload)).outcomes).toEqual(['processed']);
    expect(await count(sql(), 'contacts')).toBe(1);
    expect(await count(sql(), 'messages')).toBe(1);
  });

  it('ignores a removal of a contact we never had without creating it', async () => {
    await ingestFixture('app-state-contact-remove');
    expect(await count(sql(), 'contacts')).toBe(0);
  });

  it('alerts when the sync itself failed', async () => {
    await ingestFixture('app-state-error');
    expect(await alertCount('app_state_sync_error')).toBe(1);
  });
});
