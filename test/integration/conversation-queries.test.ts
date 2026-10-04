import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { encodeCursor } from '@/lib/conversations/cursor';
import { type ListFilter, getThread, listConversations, oneLine, toPrefixTsQuery } from '@/lib/conversations/queries';
import { T0, seedContact, seedConversation, seedDraft, seedMessage, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();
const db = () => getDb();

let counter = 0;
/** A conversation with one message at `at`, so it is listed. */
async function seedListed(o: { name?: string | null; phone?: string | null; username?: string | null; bsuid?: string | null; status?: 'open' | 'waiting_on_me' | 'waiting_on_customer' | 'resolved'; at?: Date; content?: string } = {}) {
  counter += 1;
  const contact = await seedContact(sql(), {
    name: o.name === undefined ? `Customer ${counter}` : o.name,
    phone: o.phone === undefined ? `+2567${String(counter).padStart(8, '0')}` : o.phone,
    username: o.username ?? null,
    bsuid: o.bsuid ?? null,
  });
  const conversation = await seedConversation(sql(), contact, { status: o.status ?? 'waiting_on_me' });
  const at = o.at ?? new Date(T0.getTime() + counter * 1000);
  const message = await seedMessage(sql(), conversation, { content: o.content ?? 'hello', occurredAt: at });
  await sql()`UPDATE conversations SET last_message_at = ${at} WHERE id = ${conversation}`;
  return { contact, conversation, message, at };
}

describe('listConversations', () => {
  it('lists newest activity first, with the name, the identifier line and a one-line preview', async () => {
    const older = await seedListed({ name: 'Older', at: new Date(T0.getTime() - 3600_000), content: 'first' });
    const newer = await seedListed({ name: 'Newer', username: 'newer_u', at: T0, content: '  line one\n\n   line two  ' });

    const page = await listConversations(db());
    expect(page.items.map((item) => item.id)).toEqual([newer.conversation, older.conversation]);
    expect(page.items[0]).toMatchObject({ name: 'Newer', status: 'waiting_on_me', pendingDrafts: 0 });
    // Raw SQL returns timestamps as strings; the page formats them with Date methods, so they MUST come out as Dates.
    expect(page.items[0]?.lastMessageAt).toBeInstanceOf(Date);
    expect(page.items[0]?.lastMessageAt.toISOString()).toBe(T0.toISOString());
    expect(page.items[0]?.secondary).toContain('@newer_u');
    expect(page.items[0]?.preview).toEqual({ direction: 'inbound', text: 'line one line two', status: 'received' });
    expect(page.nextCursor).toBeNull();
  });

  it('does not list a conversation that has no messages yet', async () => {
    const contact = await seedContact(sql(), { phone: '+256700000042' });
    await seedConversation(sql(), contact);
    expect((await listConversations(db())).items).toEqual([]);
  });

  it('names a customer with only a BSUID and no name, never blank', async () => {
    await seedListed({ name: null, phone: null, bsuid: 'UG.99999999999999999999' });
    expect((await listConversations(db())).items[0]?.name).toBe('Unknown customer');
  });

  it('previews the last REAL message: a reaction never becomes the preview, a deleted message shows a tombstone, media shows its kind', async () => {
    const { conversation } = await seedListed({ content: 'the real last message', at: new Date(T0.getTime() - 5000) });
    await seedMessage(sql(), conversation, { type: 'reaction', content: '👍', occurredAt: T0 });
    expect((await listConversations(db())).items[0]?.preview?.text).toBe('the real last message');

    const deleted = await seedMessage(sql(), conversation, { content: 'secret', occurredAt: new Date(T0.getTime() + 1000) });
    await sql()`UPDATE messages SET deleted_at = now() WHERE id = ${deleted}`;
    expect((await listConversations(db())).items[0]?.preview?.text).toBe('This message was deleted');

    await seedMessage(sql(), conversation, { type: 'image', content: null, occurredAt: new Date(T0.getTime() + 2000) });
    expect((await listConversations(db())).items[0]?.preview?.text).toBe('Photo');
  });

  it('counts open drafts', async () => {
    const { conversation } = await seedListed();
    await seedDraft(sql(), conversation, 'pending');
    await seedDraft(sql(), conversation, 'scheduled');
    await seedDraft(sql(), conversation, 'approved');
    expect((await listConversations(db())).items[0]?.pendingDrafts).toBe(2);
  });

  describe('filters', () => {
    it.each<[ListFilter, string[]]>([
      ['all', ['open', 'needs', 'waiting', 'resolved']],
      ['needs_reply', ['open', 'needs']],
      ['waiting', ['waiting']],
      ['resolved', ['resolved']],
    ])('%s', async (filter, expected) => {
      await seedListed({ name: 'open', status: 'open' });
      await seedListed({ name: 'needs', status: 'waiting_on_me' });
      await seedListed({ name: 'waiting', status: 'waiting_on_customer' });
      await seedListed({ name: 'resolved', status: 'resolved' });
      const names = (await listConversations(db(), { filter })).items.map((item) => item.name).sort();
      expect(names).toEqual([...expected].sort());
    });
  });

  describe('keyset pagination', () => {
    const walk = async (limit: number, between?: () => Promise<void>) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<typeof listConversations>> = await listConversations(db(), { limit, cursor });
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        pages += 1;
        if (pages === 1) await between?.();
      } while (cursor !== null && pages < 50);
      return { seen, pages };
    };

    it('walks 75 conversations in pages of 30 with no repeats and no gaps', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 75; i += 1) ids.push((await seedListed({ at: new Date(T0.getTime() + i * 60_000) })).conversation);
      const { seen, pages } = await walk(30);
      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].reverse());
    });

    it('is stable when rows tie on the same instant (the id breaks the tie)', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 25; i += 1) ids.push((await seedListed({ at: T0 })).conversation);
      const { seen } = await walk(7);
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
      expect(seen).toEqual([...ids].sort().reverse());
    });

    it('does not skip or repeat rows whose timestamps differ only in MICROseconds (a millisecond cursor would)', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 12; i += 1) ids.push((await seedListed({ at: T0 })).conversation);
      for (let i = 0; i < ids.length; i += 1) {
        await sql()`UPDATE conversations SET last_message_at = '2026-10-04 07:46:40.123000+00'::timestamptz + make_interval(secs => ${i * 0.000123}) WHERE id = ${ids[i] ?? ''}`;
      }
      const { seen } = await walk(5);
      expect(seen).toEqual([...ids].reverse());
    });

    it('is not disturbed by a newer conversation arriving between pages', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 20; i += 1) ids.push((await seedListed({ at: new Date(T0.getTime() + i * 60_000) })).conversation);
      const { seen } = await walk(8, async () => {
        await seedListed({ at: new Date(T0.getTime() + 999 * 60_000) });
      });
      // The page-1 snapshot, then the older rows continue exactly where they left off.
      expect(seen).toEqual([...ids].reverse());
    });

    it('treats a garbage or forged cursor as "start from the top", never an error or an injection', async () => {
      await seedListed();
      for (const cursor of ['garbage', encodeCursor({ t: '2026-10-04T00:00:00.000Z', id: "00000000-0000-4000-8000-000000000000" }), "'; DROP TABLE conversations; --"]) {
        await expect(listConversations(db(), { cursor })).resolves.toBeDefined();
      }
      expect(await sql().unsafe('SELECT count(*)::int AS n FROM conversations')).toEqual([{ n: 1 }]);
    });
  });

  describe('search', () => {
    it('finds a customer by part of the name, case-insensitively', async () => {
      const amina = await seedListed({ name: 'Amina Customer' });
      await seedListed({ name: 'Brian Buyer' });
      expect((await listConversations(db(), { q: 'amI' })).items.map((i) => i.id)).toEqual([amina.conversation]);
    });

    it('finds a customer by username and by phone digits however the number is written', async () => {
      const kato = await seedListed({ name: null, phone: null, bsuid: 'UG.99999999999999999999', username: 'kato_k' });
      const amina = await seedListed({ name: 'Amina', phone: '+256700123456' });
      expect((await listConversations(db(), { q: 'kato' })).items.map((i) => i.id)).toEqual([kato.conversation]);
      expect((await listConversations(db(), { q: '0700 123' })).items.map((i) => i.id)).toEqual([amina.conversation]);
      expect((await listConversations(db(), { q: '+256 700 123 456' })).items.map((i) => i.id)).toEqual([amina.conversation]);
      expect((await listConversations(db(), { q: '0700123456' })).items.map((i) => i.id)).toEqual([amina.conversation]); // the local form, with its leading 0
      expect((await listConversations(db(), { q: '0999 888' })).items).toEqual([]);
    });

    it('finds a conversation by the words inside any message, matching word beginnings', async () => {
      const dress = await seedListed({ name: 'A', content: 'do you have the blue dress in size M' });
      await seedListed({ name: 'B', content: 'what time do you open' });
      expect((await listConversations(db(), { q: 'dress' })).items.map((i) => i.id)).toEqual([dress.conversation]);
      expect((await listConversations(db(), { q: 'dre' })).items.map((i) => i.id)).toEqual([dress.conversation]);
      expect((await listConversations(db(), { q: 'blue dress' })).items.map((i) => i.id)).toEqual([dress.conversation]);
      expect((await listConversations(db(), { q: 'blue ghost' })).items).toEqual([]);
    });

    it('does not reveal a deleted message through search (its text is gone)', async () => {
      const { conversation, message } = await seedListed({ name: 'A', content: 'unique-secret-phrase' });
      await sql()`UPDATE messages SET content = NULL, deleted_at = now() WHERE id = ${message}`;
      expect((await listConversations(db(), { q: 'unique-secret-phrase' })).items).toEqual([]);
      expect(conversation).toBeDefined();
    });

    it('treats LIKE wildcards literally: "50%" does not match everything', async () => {
      await seedListed({ name: 'Alpha' });
      await seedListed({ name: '50% Off Shop' });
      expect((await listConversations(db(), { q: '50%' })).items.map((i) => i.name)).toEqual(['50% Off Shop']);
      expect((await listConversations(db(), { q: '%' })).items.map((i) => i.name)).toEqual(['50% Off Shop']);
      expect((await listConversations(db(), { q: '_' })).items).toEqual([]);
    });

    it.each(["Robert'); DROP TABLE messages;--", '& | ! ( ) : * <->', 'a'.repeat(500), '\\', '"', '   ', ''])('survives hostile search text %j', async (q) => {
      await seedListed({ name: 'Alpha' });
      await expect(listConversations(db(), { q })).resolves.toBeDefined();
      expect(await sql().unsafe('SELECT count(*)::int AS n FROM messages')).toEqual([{ n: 1 }]);
    });

    it('combines with filters', async () => {
      await seedListed({ name: 'Amina One', status: 'waiting_on_me' });
      const two = await seedListed({ name: 'Amina Two', status: 'resolved' });
      expect((await listConversations(db(), { q: 'amina', filter: 'resolved' })).items.map((i) => i.id)).toEqual([two.conversation]);
    });
  });
});

describe('toPrefixTsQuery and oneLine', () => {
  it('turns free text into a prefix query that cannot carry tsquery syntax', () => {
    expect(toPrefixTsQuery('Blue  Dress!')).toBe('blue:* & dress:*');
    expect(toPrefixTsQuery("'; & | ! ( ) :")).toBeNull();
    expect(toPrefixTsQuery('naïve café')).toBe('naïve:* & café:*');
    expect(toPrefixTsQuery('a b c d e f g h i j')?.split(' & ')).toHaveLength(8);
  });

  it('flattens whitespace and shortens with an ellipsis', () => {
    expect(oneLine('a\n\n b\t c')).toBe('a b c');
    expect(oneLine('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`);
  });
});

describe('getThread', () => {
  async function seedThread() {
    const contact = await seedContact(sql(), { name: 'Amina', phone: '+256700123456', username: 'amina_u' });
    const conversation = await seedConversation(sql(), contact, { status: 'waiting_on_me' });
    return { contact, conversation };
  }
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

  it('returns null for an unknown conversation', async () => {
    expect(await getThread(db(), '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee')).toBeNull();
  });

  it('returns real Date objects for every timestamp (raw SQL gives strings; the UI calls Date methods on them)', async () => {
    const { conversation } = await seedThread();
    const id = await seedMessage(sql(), conversation, { content: 'x', occurredAt: at(1) });
    await sql()`UPDATE messages SET edited_at = ${at(2)}, deleted_at = ${at(3)} WHERE id = ${id}`;
    // (a conversation is only listed once it has a last_message_at)
    await sql()`UPDATE conversations SET window_expires_at = ${at(60)}, last_message_at = ${at(1)} WHERE id = ${conversation}`;
    const thread = await getThread(db(), conversation);
    const message = thread?.messages[0];
    expect(message?.occurredAt).toBeInstanceOf(Date);
    expect(message?.occurredAt.toISOString()).toBe(at(1).toISOString());
    expect(message?.editedAt).toBeInstanceOf(Date);
    expect(thread?.conversation.windowExpiresAt).toBeInstanceOf(Date);
    const listed = (await listConversations(db())).items[0];
    expect(listed?.windowExpiresAt).toBeInstanceOf(Date);
  });

  it('returns the header and the messages oldest first', async () => {
    const { conversation } = await seedThread();
    await seedMessage(sql(), conversation, { content: 'two', occurredAt: at(2) });
    await seedMessage(sql(), conversation, { content: 'one', occurredAt: at(1) });
    await seedMessage(sql(), conversation, { content: 'three', direction: 'outbound', occurredAt: at(3) });

    const thread = await getThread(db(), conversation);
    expect(thread?.conversation).toMatchObject({ name: 'Amina', status: 'waiting_on_me', secondary: '+256700123456 · @amina_u' });
    expect(thread?.messages.map((m) => m.content)).toEqual(['one', 'two', 'three']);
    expect(thread?.messages[2]).toMatchObject({ direction: 'outbound', provenance: 'owner_manual', status: 'sent' });
    expect(thread?.olderCursor).toBeNull();
  });

  it('attaches the LATEST reaction per side, drops a removed one, and never lists a reaction as a message', async () => {
    const { conversation } = await seedThread();
    const target = await seedMessage(sql(), conversation, { direction: 'outbound', content: 'Is it this one?', occurredAt: at(1) });
    const react = async (direction: 'inbound' | 'outbound', content: string, minutes: number) => {
      const id = await seedMessage(sql(), conversation, { type: 'reaction', direction, content, occurredAt: at(minutes) });
      await sql()`UPDATE messages SET reply_to_message_id = ${target} WHERE id = ${id}`;
    };
    await react('inbound', '👍', 2);
    await react('inbound', '❤️', 3); // the customer changed their mind
    await react('outbound', '🙏', 4);
    await react('outbound', '', 5); // the owner removed theirs

    const thread = await getThread(db(), conversation);
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]?.reactions).toEqual([{ emoji: '❤️', by: 'customer' }]);
  });

  it('quotes the message a reply answers, even when it is on an earlier page, and tombstones a deleted quote', async () => {
    const { conversation } = await seedThread();
    const quoted = await seedMessage(sql(), conversation, { content: 'what is your price', occurredAt: at(1) });
    const deleted = await seedMessage(sql(), conversation, { content: 'oops wrong chat', occurredAt: at(2) });
    await sql()`UPDATE messages SET deleted_at = now() WHERE id = ${deleted}`;
    const reply = await seedMessage(sql(), conversation, { direction: 'outbound', content: '10k', occurredAt: at(10) });
    const replyToDeleted = await seedMessage(sql(), conversation, { content: 'sorry', occurredAt: at(11) });
    await sql()`UPDATE messages SET reply_to_message_id = ${quoted} WHERE id = ${reply}`;
    await sql()`UPDATE messages SET reply_to_message_id = ${deleted} WHERE id = ${replyToDeleted}`;

    const thread = await getThread(db(), conversation, { limit: 2 }); // only the last two messages are on this page
    expect(thread?.messages.map((m) => m.content)).toEqual(['10k', 'sorry']);
    expect(thread?.messages[0]?.replyTo).toEqual({ id: quoted, direction: 'inbound', preview: 'what is your price' });
    expect(thread?.messages[1]?.replyTo?.preview).toBe('This message was deleted');
  });

  it('hides what a customer deleted: no text, no media, a flag for the tombstone', async () => {
    const { conversation } = await seedThread();
    const id = await seedMessage(sql(), conversation, { type: 'image', content: 'a caption', occurredAt: at(1) });
    await sql()`UPDATE messages SET media_path = '2026/10/x.jpg', media_mime = 'image/jpeg', deleted_at = now() WHERE id = ${id}`;
    const [message] = (await getThread(db(), conversation))?.messages ?? [];
    expect(message).toMatchObject({ deleted: true, content: null, contentSource: null, media: { state: 'none', url: null, mime: null } });
  });

  it('reports each media state honestly: ready (with a URL), still downloading, unavailable, not media', async () => {
    const { conversation } = await seedThread();
    const ready = await seedMessage(sql(), conversation, { type: 'image', occurredAt: at(1), mediaId: 'M1' });
    await sql()`UPDATE messages SET media_path = '2026/10/x.jpg', media_mime = 'image/jpeg' WHERE id = ${ready}`;
    const pending = await seedMessage(sql(), conversation, { type: 'audio', occurredAt: at(2), mediaId: 'M2' });
    const gone = await seedMessage(sql(), conversation, { type: 'video', occurredAt: at(3) });
    const text = await seedMessage(sql(), conversation, { type: 'text', occurredAt: at(4) });

    const messages = (await getThread(db(), conversation))?.messages ?? [];
    const media = (id: string) => messages.find((m) => m.id === id)?.media;
    expect(media(ready)).toEqual({ state: 'ready', url: `/api/media/${ready}`, mime: 'image/jpeg' });
    expect(media(pending)).toEqual({ state: 'pending', url: null, mime: null });
    expect(media(gone)).toEqual({ state: 'unavailable', url: null, mime: null });
    expect(media(text)).toEqual({ state: 'none', url: null, mime: null });
  });

  it('carries a failed send’s reason, the transcription state and the provenance', async () => {
    const { conversation } = await seedThread();
    const failed = await seedMessage(sql(), conversation, { direction: 'outbound', status: 'failed', occurredAt: at(1) });
    await sql()`UPDATE messages SET error = ${sql().json({ kind: 'permanent', code: '131047', message: 'Re-engagement message' })} WHERE id = ${failed}`;
    const voice = await seedMessage(sql(), conversation, { type: 'audio', occurredAt: at(2) });
    await sql()`UPDATE messages SET transcription_status = 'low_confidence' WHERE id = ${voice}`;

    const messages = (await getThread(db(), conversation))?.messages ?? [];
    expect(messages[0]).toMatchObject({ status: 'failed', error: { code: '131047', message: 'Re-engagement message' } });
    expect(messages[1]?.transcriptionStatus).toBe('low_confidence');
  });

  it('pages backwards through a long conversation without repeats or gaps, ties included', async () => {
    const { conversation } = await seedThread();
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) ids.push(await seedMessage(sql(), conversation, { content: `m${i}`, occurredAt: i < 10 ? T0 : at(i) }));

    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const thread: Awaited<ReturnType<typeof getThread>> = await getThread(db(), conversation, { limit: 8, before });
      seen.unshift(...(thread?.messages.map((m) => m.id) ?? []));
      before = thread?.olderCursor ?? null;
      pages += 1;
    } while (before !== null && pages < 20);

    expect(pages).toBe(4);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    // Chronological, and within the tied group ordered by id: exactly the order the cursor pages by.
    const expected = await sql()<Array<{ id: string }>>`SELECT id FROM messages WHERE conversation_id = ${conversation} ORDER BY occurred_at ASC, id ASC`;
    expect(seen).toEqual(expected.map((row) => row.id));
    expect(new Set(seen)).toEqual(new Set(ids));
  });
});
