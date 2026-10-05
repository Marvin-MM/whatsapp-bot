import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { ImportError, importChatInDb } from '@/lib/import/import-chat';
import { parseWhatsAppExport } from '@/lib/import/parse-export';
import { FIXTURE } from '../helpers/fixtures';
import { count, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();

const parse = (name: string, options = {}) => parseWhatsAppExport(readFileSync(`test/fixtures/exports/${name}.txt`, 'utf8'), options);
const run = (name: string, me = 'Marvin', extra: { contactId?: string; timeZone?: string } = {}) =>
  importChatInDb(getDb(), parse(name), { me, timeZone: extra.timeZone ?? 'Africa/Kampala', fileLabel: `${name}.txt`, ...(extra.contactId ? { contactId: extra.contactId } : {}) });

type Row = { direction: string; content: string; provenance: string; status: string; type: string; occurred_at: Date; content_source: string };
const rows = (conversationId: string) =>
  sql()<Row[]>`SELECT direction, content, provenance, status, type, occurred_at, content_source FROM messages WHERE conversation_id = ${conversationId} ORDER BY occurred_at, id`;

describe('importing an Android export', () => {
  it('imports exactly the right messages, with the right sides, text, times (Kampala wall clock -> UTC) and order', async () => {
    const result = await run('android-24h');

    // 9 messages in the file: 1 deleted (skipped), 1 media placeholder (kept as a note), 7 text.
    expect(result).toMatchObject({ inFile: 8, inserted: 8, ownerInserted: 3, customerInserted: 5, skippedDeleted: 1, mediaPlaceholders: 1, alreadyImported: 0, alreadyPresent: 0, counterpart: 'Amina Customer', createdContact: true, createdConversation: true });

    const imported = await rows(result.conversationId);
    expect(imported.map((r) => [r.direction, r.content])).toEqual([
      ['inbound', 'Hello, do you have the blue dress in size M?'],
      ['outbound', 'Hi Amina! Yes we do, UGX 50,000\nCome to the shop on Kampala Road\nor I can deliver tomorrow.'],
      ['inbound', '[Media omitted]'],
      ['inbound', 'ok'],
      ['inbound', 'ok'],
      ['outbound', 'Lovely, see you then 🙏'],
      ['outbound', 'Did you manage to come by?'],
      ['inbound', 'Thank you so much!'],
    ]);
    expect(imported[0]?.occurred_at.toISOString()).toBe('2024-03-12T06:15:00.000Z');
    expect(imported[6]?.occurred_at.toISOString()).toBe('2024-03-13T15:02:00.000Z');
    // two identical messages in one minute stay two, in file order, a millisecond apart
    expect((imported[4]?.occurred_at.getTime() ?? 0) - (imported[3]?.occurred_at.getTime() ?? 0)).toBe(1);
  });

  it('stores every message as `imported` (both sides), outbound as sent, inbound as received; the media note as rendered text', async () => {
    const { conversationId } = await run('android-24h');
    const imported = await rows(conversationId);
    expect(imported.every((r) => r.provenance === 'imported')).toBe(true);
    expect(imported.filter((r) => r.direction === 'outbound').every((r) => r.status === 'sent')).toBe(true);
    expect(imported.filter((r) => r.direction === 'inbound').every((r) => r.status === 'received')).toBe(true);
    expect(imported[2]).toMatchObject({ type: 'unsupported', content_source: 'rendered' });
    expect(imported[0]).toMatchObject({ type: 'text', content_source: 'text' });
  });

  it('creates the customer as a name-only contact and a RESOLVED conversation that does not open the 24h window', async () => {
    const { conversationId, contactId } = await run('android-24h');
    const [contact] = await sql()<{ source: string; display_name: string; phone_e164: string | null; bsuid: string | null }[]>`SELECT source, display_name, phone_e164, bsuid FROM contacts WHERE id = ${contactId}`;
    expect(contact).toEqual({ source: 'import_name', display_name: 'Amina Customer', phone_e164: null, bsuid: null });
    const [conversation] = await sql()<{ status: string; last_inbound_at: Date | null; window_expires_at: Date | null; last_message_at: Date }[]>`SELECT status, last_inbound_at, window_expires_at, last_message_at FROM conversations WHERE id = ${conversationId}`;
    expect(conversation?.status).toBe('resolved');
    expect(conversation?.window_expires_at).toBeNull();
    expect(conversation?.last_inbound_at).toBeNull();
    expect(conversation?.last_message_at.toISOString()).toBe('2024-03-15T05:00:00.000Z');
  });

  it('is IDEMPOTENT: importing the same file again inserts nothing and says so', async () => {
    const first = await run('android-24h');
    const second = await run('android-24h');
    expect(second).toMatchObject({ inserted: 0, alreadyImported: 8, createdContact: false, createdConversation: false, conversationId: first.conversationId, contactId: first.contactId });
    expect(await count(sql(), 'messages')).toBe(8);
    expect(await count(sql(), 'contacts')).toBe(1);
    expect(await count(sql(), 'conversations')).toBe(1);
  });

  it('a LATER export of the same chat adds only the new messages', async () => {
    await run('android-24h');
    const longer = readFileSync('test/fixtures/exports/android-24h.txt', 'utf8') + '16/03/2024, 10:00 - Marvin: Welcome back!\n16/03/2024, 10:02 - Amina Customer: Hi again\n';
    const result = await importChatInDb(getDb(), parseWhatsAppExport(longer), { me: 'marvin', timeZone: 'Africa/Kampala' });
    expect(result).toMatchObject({ inserted: 2, alreadyImported: 8, ownerInserted: 1, customerInserted: 1 });
    expect(await count(sql(), 'messages')).toBe(10);
  });

  it('audits the import with counts and the file name, never the text', async () => {
    await run('android-24h');
    const [entry] = await sql()<{ actor: string; action: string; metadata: Record<string, unknown> }[]>`SELECT actor, action, metadata FROM audit_log WHERE action = 'import.chat'`;
    expect(entry).toMatchObject({ actor: 'system', action: 'import.chat', metadata: { file: 'android-24h.txt', inserted: 8, skippedDeleted: 1 } });
    expect(JSON.stringify(entry)).not.toContain('blue dress');
  });
});

describe('the other formats', () => {
  it('iOS 24-hour with attachments and a continuation line', async () => {
    const result = await run('ios-24h');
    expect(result).toMatchObject({ inFile: 7, inserted: 7, skippedDeleted: 1, mediaPlaceholders: 2, ownerInserted: 3 });
    const imported = await rows(result.conversationId);
    expect(imported.at(-1)?.content).toBe('Welcome\nand see you soon');
    expect(imported[0]?.occurred_at.toISOString()).toBe('2024-03-12T06:15:10.000Z');
  });

  it('Android 12-hour month-first: 12:05 AM is five past midnight', async () => {
    const result = await run('android-12h-mdy', 'Marvin');
    const imported = await rows(result.conversationId);
    expect(result.inserted).toBe(6);
    expect(imported.map((r) => r.occurred_at.toISOString())).toEqual([
      '2024-03-12T06:15:00.000Z',
      '2024-03-12T06:17:00.000Z',
      '2024-03-12T21:05:00.000Z', // 3/13 00:05 Kampala
      '2024-03-12T21:30:00.000Z',
      '2024-03-13T09:10:00.000Z', // 12:10 PM
      '2024-03-13T10:45:00.000Z', // 1:45 PM
    ]);
  });

  it('a different owner zone shifts the instants (the phone’s zone is what matters)', async () => {
    const result = await run('android-24h', 'Marvin', { timeZone: 'Europe/London' });
    expect((await rows(result.conversationId))[0]?.occurred_at.toISOString()).toBe('2024-03-12T09:15:00.000Z');
  });
});

describe('who the customer is', () => {
  it('a phone-number author becomes a phone contact, and joins an existing live contact with that number', async () => {
    const live = await seedContact(sql(), { phone: '+256700123456', bsuid: FIXTURE.amina.bsuid, name: 'Amina Customer' });
    const liveConversation = await seedConversation(sql(), live, { status: 'waiting_on_me' });
    const result = await run('phone-author');
    expect(result).toMatchObject({ contactId: live, conversationId: liveConversation, createdContact: false, createdConversation: false });
    // an existing conversation keeps its status
    expect((await sql()<{ status: string }[]>`SELECT status FROM conversations WHERE id = ${liveConversation}`)[0]?.status).toBe('waiting_on_me');
  });

  it('a phone-number author with no live contact becomes an `import_phone` contact', async () => {
    const result = await run('phone-author');
    expect((await sql()<{ source: string; phone_e164: string }[]>`SELECT source, phone_e164 FROM contacts WHERE id = ${result.contactId}`)[0]).toEqual({ source: 'import_phone', phone_e164: '+256700123456' });
  });

  it('a name-only author is NEVER linked to a live contact by name (two customers share a first name)', async () => {
    const live = await seedContact(sql(), { phone: '+256700123456', name: 'Amina Customer' });
    const result = await run('android-24h');
    expect(result.contactId).not.toBe(live);
    expect(result.createdContact).toBe(true);
  });

  it('the same name in a later import is the same name-only contact (case-insensitively)', async () => {
    const a = await run('android-24h');
    const text = readFileSync('test/fixtures/exports/android-24h.txt', 'utf8').replaceAll('Amina Customer', 'AMINA CUSTOMER').replace('09:15 - AMINA', '09:16 - AMINA');
    const b = await importChatInDb(getDb(), parseWhatsAppExport(text), { me: 'Marvin', timeZone: 'Africa/Kampala' });
    expect(b.contactId).toBe(a.contactId);
    expect(await count(sql(), 'contacts')).toBe(1);
  });

  it('--contact links to an explicit contact, and an unknown id is refused', async () => {
    const chosen = await seedContact(sql(), { phone: '+256711111111', name: 'Someone Else' });
    const result = await run('android-24h', 'Marvin', { contactId: chosen });
    expect(result.contactId).toBe(chosen);
    expect(result.createdContact).toBe(false);
    await expect(run('android-24h', 'Marvin', { contactId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })).rejects.toMatchObject({ code: 'contact_not_found' });
  });
});

describe('never a double of what WhatsApp already delivered', () => {
  it('skips an imported message that is already in the conversation from the same side, minute and text', async () => {
    const live = await seedContact(sql(), { phone: '+256700123456', bsuid: FIXTURE.amina.bsuid });
    const conversationId = await seedConversation(sql(), live);
    // the real message arrived by webhook at 09:15:42 Kampala = 06:15:42Z, and the owner's reply at 09:17:10
    await seedMessage(sql(), conversationId, { direction: 'inbound', wamid: 'wamid.LIVE.1', content: 'Hello there', occurredAt: new Date('2024-03-12T06:15:42Z') });
    await seedMessage(sql(), conversationId, { direction: 'outbound', wamid: 'wamid.LIVE.2', content: 'Hi!', occurredAt: new Date('2024-03-12T06:17:10Z'), provenance: 'owner_app_echo' });
    const phoneFile = readFileSync('test/fixtures/exports/phone-author.txt', 'utf8');
    const result = await importChatInDb(getDb(), parseWhatsAppExport(phoneFile), { me: 'Marvin', timeZone: 'Africa/Kampala' });
    expect(result).toMatchObject({ inFile: 2, alreadyPresent: 2, inserted: 0 });
    expect(await count(sql(), 'messages')).toBe(2);
  });

  it('counts identical messages: one live "ok" covers one imported "ok", not both', async () => {
    const live = await seedContact(sql(), { phone: '+256700123456' });
    const conversationId = await seedConversation(sql(), live);
    await seedMessage(sql(), conversationId, { direction: 'inbound', wamid: 'wamid.LIVE.OK', content: 'ok', occurredAt: new Date('2024-03-12T06:15:30Z') });
    const text = '12/03/2024, 09:15 - +256 700 123 456: ok\n12/03/2024, 09:15 - +256 700 123 456: ok\n12/03/2024, 09:16 - Marvin: fine\n';
    const result = await importChatInDb(getDb(), parseWhatsAppExport(text), { me: 'Marvin', timeZone: 'Africa/Kampala' });
    expect(result).toMatchObject({ alreadyPresent: 1, inserted: 2 });
  });
});

describe('refusals', () => {
  it('"me" must be one of the senders, and a one-sided file has no customer', async () => {
    await expect(run('android-24h', 'Nobody')).rejects.toMatchObject({ code: 'me_not_found' });
    await expect(run('android-24h', 'Nobody')).rejects.toBeInstanceOf(ImportError);
    const oneSided = parseWhatsAppExport('12/03/2024, 09:15 - Marvin: hello\n12/03/2024, 09:16 - Marvin: anyone?\n');
    await expect(importChatInDb(getDb(), oneSided, { me: 'Marvin', timeZone: 'Africa/Kampala' })).rejects.toMatchObject({ code: 'no_counterpart' });
    expect(await count(sql(), 'messages')).toBe(0);
    expect(await count(sql(), 'contacts')).toBe(0);
  });

  it('an invalid time zone is refused before anything is written', async () => {
    await expect(run('android-24h', 'Marvin', { timeZone: 'Mars/Olympus' })).rejects.toMatchObject({ code: 'invalid_time_zone' });
    expect(await count(sql(), 'contacts')).toBe(0);
  });

  it('matches "me" ignoring case and padding', async () => {
    expect((await run('android-24h', '  MARVIN ')).ownerInserted).toBe(3);
  });
});
