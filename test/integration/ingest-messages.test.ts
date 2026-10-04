import { describe, expect, it } from 'vitest';
import { FIXTURE } from '../helpers/fixtures';
import { HOUR, NOW, T0, cloneFixture, count, envelopeOf, ingestFixture, ingestPayload, seedContact, seedConversation, seedDraft, seedMessage, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();

const messageRow = async (wamid: string) => {
  const [row] = await sql()<
    Array<{ id: string; conversation_id: string; direction: string; provenance: string; status: string; type: string; content: string | null; content_source: string | null; media_id: string | null; transcription_status: string | null; occurred_at: Date; reply_to_message_id: string | null; edited_at: Date | null; deleted_at: Date | null }>
  >`SELECT * FROM messages WHERE wamid = ${wamid}`;
  return row;
};

const conversationRow = async (id: string) => {
  const [row] = await sql()<Array<{ status: string; last_inbound_at: Date | null; last_message_at: Date | null; window_expires_at: Date | null; consecutive_auto_replies: number }>>`
    SELECT * FROM conversations WHERE id = ${id}`;
  return row;
};

describe('an inbound text message', () => {
  it('creates the contact and conversation, stores the message, opens the 24h window, and tells the dashboard without leaking the body', async () => {
    const result = await ingestFixture('text-message');
    expect(result.outcomes).toEqual(['processed']);

    const [contact] = await sql()<Array<{ id: string; bsuid: string; phone_e164: string; display_name: string; source: string }>>`SELECT * FROM contacts`;
    expect(contact).toMatchObject({ bsuid: FIXTURE.amina.bsuid, phone_e164: `+${FIXTURE.amina.wa}`, display_name: FIXTURE.amina.name, source: 'webhook' });

    const message = await messageRow('wamid.IN.TEXT.1');
    expect(message).toMatchObject({
      direction: 'inbound',
      provenance: 'customer',
      status: 'received',
      type: 'text',
      content: 'Hello, do you have the blue dress in size M?',
      content_source: 'text',
    });
    expect(message?.occurred_at).toEqual(T0);

    const conversation = await conversationRow(message?.conversation_id ?? '');
    expect(conversation?.status).toBe('waiting_on_me');
    expect(conversation?.last_inbound_at).toEqual(T0);
    expect(conversation?.last_message_at).toEqual(T0);
    expect(conversation?.window_expires_at).toEqual(new Date(T0.getTime() + 24 * HOUR));

    const [event] = await sql()<Array<{ processed_at: Date | null; last_error: string | null }>>`SELECT processed_at, last_error FROM webhook_events`;
    expect(event?.processed_at).not.toBeNull();
    expect(event?.last_error).toBeNull();

    const events = await h.events();
    expect(events.map((e) => e.type).sort()).toEqual(['conversation:updated', 'message:new']);
    expect(JSON.stringify(events)).not.toContain('blue dress');
    expect(JSON.stringify(events)).not.toContain(FIXTURE.amina.wa);
  });

  it('is idempotent: a replay stores nothing new and says nothing new', async () => {
    await ingestFixture('text-message');
    const first = await h.events();

    const replay = await ingestFixture('text-message');
    expect(replay.keys).toEqual([]);
    expect(await count(sql(), 'messages')).toBe(1);
    expect(await count(sql(), 'contacts')).toBe(1);
    expect(await count(sql(), 'webhook_events')).toBe(1);
    expect((await h.events()).length).toBe(first.length);
  });

  it('survives a crash between commit and processed_at: reprocessing creates no duplicate and emits no duplicate event', async () => {
    await ingestFixture('text-message');
    const before = (await h.events()).length;
    await sql()`UPDATE webhook_events SET processed_at = NULL`;

    const retry = await ingestFixture('text-message');
    expect(retry.outcomes).toEqual(['processed']);
    expect(await count(sql(), 'messages')).toBe(1);
    expect((await h.events()).length).toBe(before);
  });

  it('handles a username user: a BSUID and no phone number', async () => {
    await ingestFixture('bsuid-only-sender');
    const [contact] = await sql()<Array<{ bsuid: string; phone_e164: string | null; username: string; display_name: string }>>`SELECT * FROM contacts`;
    expect(contact).toMatchObject({ bsuid: FIXTURE.kato.bsuid, phone_e164: null, username: FIXTURE.kato.username, display_name: FIXTURE.kato.name });
    expect(await messageRow('wamid.IN.BSUID.1')).toMatchObject({ content: 'Hi, is this the shop?' });
  });

  it('processes every message of a batched POST, not just the first', async () => {
    const result = await ingestFixture('batch-multi', { finalAttempt: true });
    expect(result.keys.filter((key) => key.startsWith('msg:'))).toHaveLength(4);
    for (const wamid of ['wamid.BATCH.1', 'wamid.BATCH.2', 'wamid.BATCH.3', 'wamid.BATCH.4']) expect(await messageRow(wamid)).toBeDefined();
  });

  it('stores a reply even when the message it answers is not in our database', async () => {
    await ingestFixture('reply-context');
    expect((await messageRow('wamid.IN.REPLY.1'))?.reply_to_message_id).toBeNull();
  });

  it('links a reply to the message it answers when we hold it', async () => {
    const convo = await seedConversation(sql(), await seedContact(sql(), { bsuid: FIXTURE.amina.bsuid, phone: `+${FIXTURE.amina.wa}` }));
    const original = await seedMessage(sql(), convo, { direction: 'outbound', wamid: 'wamid.OUT.TEXT.1', content: 'Is it this one?' });
    await ingestFixture('reply-context');
    expect((await messageRow('wamid.IN.REPLY.1'))?.reply_to_message_id).toBe(original);
  });
});

describe('message types', () => {
  const cases: Array<[string, string, string, string, string | undefined]> = [
    // fixture, wamid, stored type, expected content, content_source
    ['image-caption', 'wamid.IN.IMG.1', 'image', 'This one?', 'caption'],
    ['video', 'wamid.IN.VID.1', 'video', 'See the fabric', 'caption'],
    ['document', 'wamid.IN.DOC.1', 'document', 'Payment receipt', 'caption'],
    ['sticker', 'wamid.IN.STK.1', 'sticker', '[Sticker]', 'rendered'],
    ['location', 'wamid.IN.LOC.1', 'location', '[Location: Kampala Road, Kampala, Uganda (0.3476, 32.5825)]', 'rendered'],
    ['contacts-shared', 'wamid.IN.CON.1', 'contacts', '[Shared contact: Sarah Seller]', 'rendered'],
    ['interactive-button-reply', 'wamid.IN.INT.1', 'interactive', 'Yes, confirm', 'text'],
    ['interactive-list-reply', 'wamid.IN.INT.2', 'interactive', 'Medium - Size M', 'text'],
    ['button', 'wamid.IN.BTN.1', 'button', 'Confirm order', 'text'],
    ['order', 'wamid.IN.ORD.1', 'interactive', '[Order: 3 items] Please deliver Friday', 'rendered'],
    ['unsupported', 'wamid.IN.UNS.1', 'unsupported', '[Unsupported message]', 'rendered'],
    ['unknown-type', 'wamid.IN.NEW.1', 'unsupported', '[Unsupported message type: hologram]', 'rendered'],
  ];

  it.each(cases)('%s is stored as %s', async (fixture, wamid, type, content, source) => {
    expect((await ingestFixture(fixture)).outcomes).toEqual(['processed']);
    expect(await messageRow(wamid)).toMatchObject({ type, content, content_source: source });
  });

  it('ignores group messages entirely (spec 16) and says why', async () => {
    const result = await ingestFixture('group-message');
    expect(result.outcomes).toEqual(['processed']);
    expect(await count(sql(), 'messages')).toBe(0);
    expect(await count(sql(), 'contacts')).toBe(0);
    const [event] = await sql()<Array<{ last_error: string }>>`SELECT last_error FROM webhook_events`;
    expect(event?.last_error).toBe('group_message_ignored');
  });

  it('ignores an event for another phone number id: not ours, so nothing is stored', async () => {
    const result = await ingestFixture('foreign-phone-number');
    expect(result.outcomes).toEqual(['parked']);
    expect(await count(sql(), 'messages')).toBe(0);
    const [event] = await sql()<Array<{ last_error: string; processed_at: Date | null }>>`SELECT last_error, processed_at FROM webhook_events`;
    expect(event).toMatchObject({ last_error: 'foreign_phone_number' });
    expect(event?.processed_at).not.toBeNull();
  });

  it('survives a message containing U+0000, which Postgres cannot store: it is stripped, not retried forever', async () => {
    const payload = cloneFixture('text-message') as { entry: Array<{ changes: Array<{ value: { messages: Array<{ text: { body: string } }> } }> }> };
    const message = payload.entry[0]?.changes[0]?.value.messages[0];
    if (message) message.text.body = 'pay\u0000ment sent';
    const result = await ingestPayload(payload);
    expect(result.outcomes).toEqual(['processed']);
    expect((await messageRow('wamid.IN.TEXT.1'))?.content).toBe('payment sent');
  });
});

describe('media and voice notes', () => {
  it('enqueues exactly one download job per media message, keyed by the message id', async () => {
    await ingestFixture('image-caption');
    const message = await messageRow('wamid.IN.IMG.1');
    expect(message?.media_id).toBe('MEDIA_IMG_1');
    const jobs = await h.mediaJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.messageId).toBe(message?.id);
    expect(jobs[0]?.id).toBe(encodeURIComponent(`media:${message?.id}`));
  });

  it('marks a voice note pending transcription and shows an honest placeholder until it is transcribed', async () => {
    await ingestFixture('voice-note');
    expect(await messageRow('wamid.IN.AUD.1')).toMatchObject({ type: 'audio', content: '[Voice message]', content_source: 'rendered', transcription_status: 'pending', media_id: 'MEDIA_AUD_1' });
    expect(await h.mediaJobs()).toHaveLength(1);
  });

  it('re-derives the download after a crash between commit and enqueue (the job is lost, the message is not)', async () => {
    await ingestFixture('image-caption');
    await h.clearMediaJobs();
    await sql()`UPDATE webhook_events SET processed_at = NULL`;

    await ingestFixture('image-caption');
    expect(await count(sql(), 'messages')).toBe(1);
    expect(await h.mediaJobs()).toHaveLength(1);
  });

  it('does not enqueue a download for a message whose file we already have', async () => {
    await ingestFixture('image-caption');
    await sql()`UPDATE messages SET media_path = '2026/10/x.jpg'`;
    await h.clearMediaJobs();
    await sql()`UPDATE webhook_events SET processed_at = NULL`;
    await ingestFixture('image-caption');
    expect(await h.mediaJobs()).toHaveLength(0);
  });
});

describe('the 24h window and conversation state', () => {
  it('a later customer message moves the window forward; an older one (out of order) cannot move it back', async () => {
    const later = cloneFixture('text-message') as { entry: Array<{ changes: Array<{ value: { messages: Array<{ id: string; timestamp: string }> } }> }> };
    const msg = later.entry[0]?.changes[0]?.value.messages[0];
    if (msg) {
      msg.id = 'wamid.IN.LATER';
      msg.timestamp = String(1791100000 + 600);
    }
    await ingestPayload(later);
    await ingestFixture('text-message'); // the original, 10 minutes older, arrives second

    const message = await messageRow('wamid.IN.LATER');
    const conversation = await conversationRow(message?.conversation_id ?? '');
    expect(conversation?.last_inbound_at).toEqual(new Date(T0.getTime() + 600_000));
    expect(conversation?.window_expires_at).toEqual(new Date(T0.getTime() + 600_000 + 24 * HOUR));
    expect(conversation?.last_message_at).toEqual(new Date(T0.getTime() + 600_000));
  });

  it('clamps a timestamp from the far future to now: a wrong clock must not extend the right to send free text', async () => {
    const payload = cloneFixture('text-message') as { entry: Array<{ changes: Array<{ value: { messages: Array<{ timestamp: string }> } }> }> };
    const msg = payload.entry[0]?.changes[0]?.value.messages[0];
    if (msg) msg.timestamp = String(Math.floor(NOW.getTime() / 1000) + 3 * 24 * 3600);
    await ingestPayload(payload);

    const message = await messageRow('wamid.IN.TEXT.1');
    expect(message?.occurred_at).toEqual(NOW);
    expect((await conversationRow(message?.conversation_id ?? ''))?.window_expires_at).toEqual(new Date(NOW.getTime() + 24 * HOUR));
  });

  it('a new customer message supersedes the open drafts (they no longer answer what the customer said)', async () => {
    const contact = await seedContact(sql(), { bsuid: FIXTURE.amina.bsuid, phone: `+${FIXTURE.amina.wa}` });
    const convo = await seedConversation(sql(), contact, { status: 'waiting_on_customer' });
    const pending = await seedDraft(sql(), convo, 'pending');
    const scheduled = await seedDraft(sql(), convo, 'scheduled');
    const approved = await seedDraft(sql(), convo, 'approved');

    await ingestFixture('text-message');

    const rows = await sql()<Array<{ id: string; status: string }>>`SELECT id, status FROM drafts`;
    const statusOf = (id: string) => rows.find((row) => row.id === id)?.status;
    expect(statusOf(pending)).toBe('superseded');
    expect(statusOf(scheduled)).toBe('superseded');
    expect(statusOf(approved)).toBe('approved');
    const draftEvents = (await h.events()).filter((e) => e.type === 'draft:updated');
    expect(draftEvents).toHaveLength(2);
  });

  it('a reaction never touches the window, the status, the list order, or the drafts', async () => {
    const contact = await seedContact(sql(), { bsuid: FIXTURE.amina.bsuid, phone: `+${FIXTURE.amina.wa}` });
    const convo = await seedConversation(sql(), contact, { status: 'waiting_on_customer' });
    const target = await seedMessage(sql(), convo, { direction: 'outbound', wamid: 'wamid.OUT.TEXT.1', occurredAt: new Date(T0.getTime() - 3600_000) });
    const draft = await seedDraft(sql(), convo, 'pending');
    await sql()`UPDATE conversations SET last_message_at = ${new Date(T0.getTime() - 3600_000)} WHERE id = ${convo}`;

    await ingestFixture('reaction');

    const reaction = await messageRow('wamid.IN.RXN.1');
    expect(reaction).toMatchObject({ type: 'reaction', content: '👍', reply_to_message_id: target });
    const conversation = await conversationRow(convo);
    expect(conversation?.status).toBe('waiting_on_customer');
    expect(conversation?.last_inbound_at).toBeNull();
    expect(conversation?.window_expires_at).toBeNull();
    expect(conversation?.last_message_at).toEqual(new Date(T0.getTime() - 3600_000));
    expect((await sql()<Array<{ status: string }>>`SELECT status FROM drafts WHERE id = ${draft}`)[0]?.status).toBe('pending');
  });

  it('records a removed reaction as an empty reaction, not as an error', async () => {
    await ingestFixture('reaction-removed');
    expect(await messageRow('wamid.IN.RXN.2')).toMatchObject({ type: 'reaction', content: '' });
  });
});

describe('edits and deletions by the customer', () => {
  it('an edit replaces the text of the original, marks it edited, and creates no new message', async () => {
    await ingestFixture('text-message');
    expect((await ingestFixture('edit-live')).outcomes).toEqual(['processed']);

    const original = await messageRow('wamid.IN.TEXT.1');
    expect(original).toMatchObject({ content: 'Actually size L please', content_source: 'text' });
    expect(original?.edited_at).not.toBeNull();
    expect(await count(sql(), 'messages')).toBe(1);
    expect(await messageRow('wamid.IN.EDIT.1')).toBeUndefined();
  });

  it('an edit supersedes the draft written for the old text, but not drafts that answered other messages', async () => {
    await ingestFixture('text-message');
    const original = await messageRow('wamid.IN.TEXT.1');
    const other = await seedMessage(sql(), original?.conversation_id ?? '', { wamid: 'wamid.OTHER' });
    const stale = await seedDraft(sql(), original?.conversation_id ?? '', 'pending', [original?.id ?? '']);
    const unrelated = await seedDraft(sql(), original?.conversation_id ?? '', 'pending', [other]);

    await ingestFixture('edit-live');

    const status = async (id: string) => (await sql()<Array<{ status: string }>>`SELECT status FROM drafts WHERE id = ${id}`)[0]?.status;
    expect(await status(stale)).toBe('superseded');
    expect(await status(unrelated)).toBe('pending');
  });

  it('a delete-for-everyone blanks the text but keeps the row, so the thread and replies stay intact', async () => {
    await ingestFixture('text-message');
    await ingestFixture('revoke-live');
    const original = await messageRow('wamid.IN.TEXT.1');
    expect(original?.content).toBeNull();
    expect(original?.content_source).toBeNull();
    expect(original?.deleted_at).not.toBeNull();
    expect(await count(sql(), 'messages')).toBe(1);
  });

  it('an edit that arrives before its original waits (retry), then on the last attempt is kept as the customer’s words', async () => {
    await expect(ingestFixture('edit-live', { finalAttempt: false })).rejects.toMatchObject({ name: 'RetryLaterError' });
    expect(await count(sql(), 'messages')).toBe(0);
    const [pending] = await sql()<Array<{ processed_at: Date | null }>>`SELECT processed_at FROM webhook_events`;
    expect(pending?.processed_at).toBeNull();

    await ingestFixture('edit-live', { finalAttempt: true });
    expect(await messageRow('wamid.IN.EDIT.1')).toMatchObject({ content: 'Actually size L please' });
  });

  it('a delete whose original never arrives is settled without inventing a message', async () => {
    const result = await ingestFixture('revoke-live', { finalAttempt: true });
    expect(result.outcomes).toEqual(['processed']);
    expect(await count(sql(), 'messages')).toBe(0);
    const [event] = await sql()<Array<{ last_error: string }>>`SELECT last_error FROM webhook_events`;
    expect(event?.last_error).toBe('revoke_target_unknown');
  });
});

describe('contact identity (bsuid and phone, either may be missing)', () => {
  it('matches an imported phone-only contact by phone, adopts the BSUID, keeps the owner’s saved name and the existing thread', async () => {
    const contact = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}`, name: 'Amina (saved)', source: 'import_phone' });
    const convo = await seedConversation(sql(), contact, { status: 'resolved' });
    await seedMessage(sql(), convo, { direction: 'outbound', provenance: 'imported', occurredAt: new Date(T0.getTime() - 86400_000) });

    await ingestFixture('text-message');

    const contacts = await sql()<Array<{ id: string; bsuid: string | null; display_name: string }>>`SELECT id, bsuid, display_name FROM contacts`;
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ id: contact, bsuid: FIXTURE.amina.bsuid, display_name: 'Amina (saved)' });
    expect(await count(sql(), 'conversations')).toBe(1);
    expect(await count(sql(), 'messages', `conversation_id = '${convo}'`)).toBe(2);
    expect((await conversationRow(convo))?.status).toBe('waiting_on_me');
  });

  it('fills in a missing phone when a BSUID-only contact turns out to have one', async () => {
    const contact = await seedContact(sql(), { bsuid: FIXTURE.amina.bsuid });
    await ingestFixture('text-message');
    const [row] = await sql()<Array<{ id: string; phone_e164: string }>>`SELECT id, phone_e164 FROM contacts`;
    expect(row).toMatchObject({ id: contact, phone_e164: `+${FIXTURE.amina.wa}` });
    expect(await count(sql(), 'audit_log', `action = 'contact.phone_changed'`)).toBe(1);
  });

  it('does NOT overwrite a phone on file with a different one from a message (it may be an older number arriving late): it keeps it and flags it', async () => {
    const contact = await seedContact(sql(), { bsuid: FIXTURE.amina.bsuid, phone: '+256711000000' });
    await ingestFixture('text-message');

    const [row] = await sql()<Array<{ id: string; phone_e164: string }>>`SELECT id, phone_e164 FROM contacts`;
    expect(row).toMatchObject({ id: contact, phone_e164: '+256711000000' });
    expect(await count(sql(), 'audit_log', `action = 'contact.phone_changed'`)).toBe(0);
    expect(await count(sql(), 'notifications', `kind = 'alert:identity_conflict'`)).toBe(1);
    // The message is still stored in the right thread.
    const message = await messageRow('wamid.IN.TEXT.1');
    const [conversation] = await sql()<Array<{ contact_id: string }>>`SELECT contact_id FROM conversations WHERE id = ${message?.conversation_id ?? ''}`;
    expect(conversation?.contact_id).toBe(contact);
  });

  it('merges two records that turn out to be one person, moving messages, drafts and tasks and keeping the imported name', async () => {
    const live = await seedContact(sql(), { bsuid: FIXTURE.amina.bsuid, name: 'Amina Customer' });
    const liveConvo = await seedConversation(sql(), live, { status: 'waiting_on_me' });
    await seedMessage(sql(), liveConvo, { wamid: 'wamid.LIVE.OLD', occurredAt: new Date(T0.getTime() - 2 * HOUR) });

    const imported = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}`, name: 'Amina (saved)', source: 'import_phone' });
    const importedConvo = await seedConversation(sql(), imported, { status: 'resolved' });
    await seedMessage(sql(), importedConvo, { wamid: 'wamid.IMPORTED.1', direction: 'outbound', provenance: 'imported', occurredAt: new Date(T0.getTime() - 3 * HOUR) });
    await seedDraft(sql(), importedConvo, 'rejected');
    await sql()`INSERT INTO tasks (id, conversation_id, description, type, created_by) VALUES (gen_random_uuid(), ${importedConvo}, 'call back', 'followup', 'owner')`;

    await ingestFixture('text-message');

    const contacts = await sql()<Array<{ id: string; bsuid: string; phone_e164: string; display_name: string }>>`SELECT id, bsuid, phone_e164, display_name FROM contacts`;
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ id: live, bsuid: FIXTURE.amina.bsuid, phone_e164: `+${FIXTURE.amina.wa}`, display_name: 'Amina (saved)' });
    expect(await count(sql(), 'conversations')).toBe(1);
    expect(await count(sql(), 'messages', `conversation_id = '${liveConvo}'`)).toBe(3);
    expect(await count(sql(), 'drafts', `conversation_id = '${liveConvo}'`)).toBe(1);
    expect(await count(sql(), 'tasks', `conversation_id = '${liveConvo}'`)).toBe(1);
    expect(await count(sql(), 'audit_log', `action = 'contact.merge'`)).toBe(1);
    // The window comes from the merged thread: the newest customer message, not the imported owner reply.
    expect((await conversationRow(liveConvo))?.last_inbound_at).toEqual(T0);
  });

  it('REFUSES to merge two different people: a BSUID that differs from the phone owner’s is kept apart and flagged', async () => {
    const owner = await seedContact(sql(), { bsuid: 'UG.11111111111111111111', phone: `+${FIXTURE.amina.wa}`, name: 'Previous owner of the number' });
    await seedConversation(sql(), owner);

    await ingestFixture('text-message');

    const contacts = await sql()<Array<{ id: string; bsuid: string; phone_e164: string | null }>>`SELECT id, bsuid, phone_e164 FROM contacts ORDER BY created_at`;
    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toMatchObject({ id: owner, bsuid: 'UG.11111111111111111111', phone_e164: `+${FIXTURE.amina.wa}` });
    expect(contacts[1]).toMatchObject({ bsuid: FIXTURE.amina.bsuid, phone_e164: null });
    expect(await count(sql(), 'conversations')).toBe(2);
    expect(await count(sql(), 'audit_log', `action = 'contact.merge'`)).toBe(0);
    expect(await count(sql(), 'notifications', `kind = 'alert:identity_conflict'`)).toBe(1);
  });

  it('REFUSES to merge when the BSUID record has a different phone than the one the payload brings', async () => {
    const byBsuid = await seedContact(sql(), { bsuid: FIXTURE.amina.bsuid, phone: '+256711000000' });
    const byPhone = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}`, name: 'Someone else' });

    await ingestFixture('text-message');

    expect(await count(sql(), 'contacts')).toBe(2);
    const message = await messageRow('wamid.IN.TEXT.1');
    const [conversation] = await sql()<Array<{ contact_id: string }>>`SELECT contact_id FROM conversations WHERE id = ${message?.conversation_id ?? ''}`;
    expect(conversation?.contact_id).toBe(byBsuid);
    expect((await sql()<Array<{ phone_e164: string }>>`SELECT phone_e164 FROM contacts WHERE id = ${byPhone}`)[0]?.phone_e164).toBe(`+${FIXTURE.amina.wa}`);
    expect(await count(sql(), 'notifications', `kind = 'alert:identity_conflict'`)).toBe(1);
  });

  it('REFUSES to merge when the phone record already belongs to a DIFFERENT BSUID, even though the BSUID record has no phone', async () => {
    const byBsuid = await seedContact(sql(), { bsuid: FIXTURE.amina.bsuid });
    const byPhone = await seedContact(sql(), { bsuid: 'UG.11111111111111111111', phone: `+${FIXTURE.amina.wa}` });

    await ingestFixture('text-message');

    expect(await count(sql(), 'contacts')).toBe(2);
    expect((await sql()<Array<{ phone_e164: string | null }>>`SELECT phone_e164 FROM contacts WHERE id = ${byBsuid}`)[0]?.phone_e164).toBeNull();
    expect((await sql()<Array<{ bsuid: string }>>`SELECT bsuid FROM contacts WHERE id = ${byPhone}`)[0]?.bsuid).toBe('UG.11111111111111111111');
    expect(await count(sql(), 'audit_log', `action = 'contact.merge'`)).toBe(0);
    expect(await count(sql(), 'notifications', `kind = 'alert:identity_conflict'`)).toBe(1);
  });

  it('serialises concurrent webhooks for the same new customer: one contact, one conversation, both messages', async () => {
    const a = cloneFixture('text-message') as { entry: Array<{ changes: Array<{ value: { messages: Array<{ id: string }> } }> }> };
    const b = cloneFixture('text-message') as typeof a;
    const first = a.entry[0]?.changes[0]?.value.messages[0];
    const second = b.entry[0]?.changes[0]?.value.messages[0];
    if (first) first.id = 'wamid.RACE.1';
    if (second) second.id = 'wamid.RACE.2';

    await Promise.all([ingestPayload(a), ingestPayload(b)]);

    expect(await count(sql(), 'contacts')).toBe(1);
    expect(await count(sql(), 'conversations')).toBe(1);
    expect(await count(sql(), 'messages')).toBe(2);
  });

  it('parks a message that names nobody, with an alert, instead of guessing or crashing', async () => {
    const payload = envelopeOf('messages', { messages: [{ id: 'wamid.NOBODY', timestamp: '1791100000', type: 'text', text: { body: 'who am i' } }] });
    const result = await ingestPayload(payload);
    expect(result.outcomes).toEqual(['processed']);
    expect(await count(sql(), 'messages')).toBe(0);
    expect(await count(sql(), 'notifications', `kind = 'alert:message_without_identity'`)).toBe(1);
  });
});
