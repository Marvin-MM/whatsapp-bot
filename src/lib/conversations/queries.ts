import 'server-only';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { type MessageError, contacts, conversations } from '@/lib/db/schema';
import { type Cursor, decodeCursor, encodeCursor } from './cursor';
import { displayName, escapeLike, secondaryLine } from './display';

export const LIST_PAGE_SIZE = 30;
export const THREAD_PAGE_SIZE = 40;

export type ListFilter = 'all' | 'needs_reply' | 'waiting' | 'resolved';
export const LIST_FILTERS: readonly ListFilter[] = ['all', 'needs_reply', 'waiting', 'resolved'];

type ConversationStatus = typeof conversations.$inferSelect.status;
type MessageType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contacts' | 'interactive' | 'button' | 'reaction' | 'template' | 'unsupported';
type MessageStatus = 'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown';
type Provenance = 'customer' | 'owner_manual' | 'owner_app_echo' | 'imported' | 'ai_unedited' | 'ai_edited' | 'ai_autopilot';

/**
 * Raw `db.execute(sql...)` bypasses Drizzle's column mappers, and Drizzle turns the driver's own date parsing OFF, so
 * timestamps arrive as ISO-ish STRINGS even though the typed builders return Dates. Every raw timestamp goes through here;
 * the row types say `string` so the compiler refuses to let one through unconverted.
 */
type RawTimestamp = string | Date;
export function toDate(value: RawTimestamp): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('unparseable timestamp from the database');
  return date;
}
const toDateOrNull = (value: RawTimestamp | null): Date | null => (value === null ? null : toDate(value));

/** A cursor timestamp carries MICROseconds (what Postgres stores): a millisecond cursor would skip or repeat rows that tie. */
const MICROS = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

// ---------------------------------------------------------------------------------------------------- list

export interface ConversationListItem {
  id: string;
  name: string;
  secondary: string | null;
  status: ConversationStatus;
  lastMessageAt: Date;
  windowExpiresAt: Date | null;
  preview: { direction: 'inbound' | 'outbound'; text: string; status: MessageStatus } | null;
  pendingDrafts: number;
  replyMode: 'approval' | 'autopilot';
}

export interface ConversationPage {
  items: ConversationListItem[];
  /** Pass back as `cursor` for the next (older) page; null when this was the last. */
  nextCursor: string | null;
}

export interface ListParams {
  filter?: ListFilter;
  /** Free text: matches names, handles, phone numbers and the words of any message. */
  q?: string | undefined;
  cursor?: string | null | undefined;
  limit?: number;
}

/** Collapses whitespace and shortens, so a preview is one line whatever the message was. */
export function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const TYPE_LABEL: Readonly<Record<string, string>> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Voice message',
  document: 'Document',
  sticker: 'Sticker',
  location: 'Location',
  contacts: 'Shared contact',
  reaction: 'Reaction',
  template: 'Template',
  unsupported: 'Unsupported message',
};

function previewOf(type: string, content: string | null, deleted: boolean): string {
  if (deleted) return 'This message was deleted';
  return content !== null && content.trim() !== '' ? oneLine(content) : (TYPE_LABEL[type] ?? 'Message');
}

/**
 * A tsquery from free text that CANNOT inject syntax: only letter/digit runs survive, each as a prefix match ("dre" finds
 * "dress"), AND-ed together. Returns null when nothing searchable is left.
 */
export function toPrefixTsQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  return words.length === 0 ? null : words.map((word) => `${word}:*`).join(' & ');
}

function filterSql(filter: ListFilter) {
  switch (filter) {
    case 'needs_reply':
      return sql`AND c.status IN ('open', 'waiting_on_me')`;
    case 'waiting':
      return sql`AND c.status = 'waiting_on_customer'`;
    case 'resolved':
      return sql`AND c.status = 'resolved'`;
    case 'all':
      return sql``;
  }
}

function searchSql(q: string | undefined) {
  const text = q?.trim().slice(0, 100);
  if (!text) return sql``;
  const like = `%${escapeLike(text)}%`;
  const digits = text.replace(/\D/g, '');
  // People type a local number ("0700 123 456"); E.164 has no national leading zero ("+256700123456"). Match both forms.
  const national = digits.replace(/^0+/, '');
  const phoneForms = [...new Set([digits, national])].filter((form) => form.length >= 3);
  const tsquery = toPrefixTsQuery(text);
  return sql`AND (
    ct.display_name ILIKE ${like} ESCAPE '\\'
    OR ct.username ILIKE ${like} ESCAPE '\\'
    ${phoneForms.length > 0 ? sql`OR ${sql.join(phoneForms.map((form) => sql`ct.phone_e164 LIKE ${`%${form}%`}`), sql` OR `)}` : sql``}
    ${tsquery ? sql`OR EXISTS (SELECT 1 FROM messages sm WHERE sm.conversation_id = c.id AND sm.content_tsv @@ to_tsquery('simple', ${tsquery}))` : sql``}
  )`;
}

interface ListRow extends Record<string, unknown> {
  id: string;
  status: ConversationStatus;
  last_message_at: RawTimestamp;
  cursor_t: string;
  window_expires_at: RawTimestamp | null;
  display_name: string | null;
  username: string | null;
  phone_e164: string | null;
  bsuid: string | null;
  lm_direction: 'inbound' | 'outbound' | null;
  lm_type: string | null;
  lm_content: string | null;
  lm_status: MessageStatus | null;
  lm_deleted_at: RawTimestamp | null;
  pending_drafts: number;
  reply_mode: 'approval' | 'autopilot';
}

/**
 * The conversation list, newest activity first, keyset-paginated on (last_message_at, id) so rows arriving while the owner
 * pages can neither repeat nor skip. Empty conversations (no message yet) are not listed.
 */
export async function listConversations(db: Db, params: ListParams = {}): Promise<ConversationPage> {
  const limit = Math.min(Math.max(params.limit ?? LIST_PAGE_SIZE, 1), 100);
  const cursor = decodeCursor(params.cursor);
  const after = cursor?.t
    ? sql`AND (c.last_message_at < ${cursor.t}::timestamptz OR (c.last_message_at = ${cursor.t}::timestamptz AND c.id < ${cursor.id}::uuid))`
    : sql``;

  const rows = await db.execute<ListRow>(sql`
    SELECT c.id, c.status, c.reply_mode, c.last_message_at, c.window_expires_at,
           to_char(c.last_message_at AT TIME ZONE 'UTC', ${MICROS}) AS cursor_t,
           ct.display_name, ct.username, ct.phone_e164, ct.bsuid,
           lm.direction AS lm_direction, lm.type AS lm_type, lm.content AS lm_content, lm.status AS lm_status, lm.deleted_at AS lm_deleted_at,
           (SELECT count(*)::int FROM drafts d WHERE d.conversation_id = c.id AND d.status IN ('pending', 'scheduled')) AS pending_drafts
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN LATERAL (
      SELECT m.direction, m.type, m.content, m.status, m.deleted_at
      FROM messages m
      WHERE m.conversation_id = c.id AND m.type <> 'reaction'
      ORDER BY m.occurred_at DESC, m.id DESC
      LIMIT 1
    ) lm ON true
    WHERE c.last_message_at IS NOT NULL
      ${filterSql(params.filter ?? 'all')}
      ${searchSql(params.q)}
      ${after}
    ORDER BY c.last_message_at DESC, c.id DESC
    LIMIT ${limit + 1}
  `);

  const page = [...rows].slice(0, limit);
  const last = page.at(-1);
  const items = page.map(
    (row): ConversationListItem => ({
      id: row.id,
      name: displayName({ displayName: row.display_name, username: row.username, phoneE164: row.phone_e164, bsuid: row.bsuid }),
      secondary: secondaryLine({ displayName: row.display_name, username: row.username, phoneE164: row.phone_e164, bsuid: row.bsuid }),
      status: row.status,
      lastMessageAt: toDate(row.last_message_at),
      windowExpiresAt: toDateOrNull(row.window_expires_at),
      preview:
        row.lm_direction && row.lm_type && row.lm_status
          ? { direction: row.lm_direction, text: previewOf(row.lm_type, row.lm_content, row.lm_deleted_at !== null), status: row.lm_status }
          : null,
      pendingDrafts: row.pending_drafts,
      replyMode: row.reply_mode,
    }),
  );
  return { items, nextCursor: rows.length > limit && last ? encodeCursor({ t: last.cursor_t, id: last.id }) : null };
}

// ---------------------------------------------------------------------------------------------------- thread

export type MediaState = 'none' | 'pending' | 'ready' | 'unavailable';

export interface ThreadMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  type: MessageType;
  /** Null for a message the customer deleted: we do not keep showing what they took back. */
  content: string | null;
  contentSource: 'text' | 'caption' | 'transcript' | 'rendered' | 'template' | null;
  status: MessageStatus;
  provenance: Provenance;
  occurredAt: Date;
  editedAt: Date | null;
  deleted: boolean;
  media: { state: MediaState; url: string | null; mime: string | null };
  transcriptionStatus: 'pending' | 'done' | 'failed' | 'low_confidence' | null;
  error: MessageError | null;
  replyTo: { id: string; direction: 'inbound' | 'outbound'; preview: string } | null;
  reactions: Array<{ emoji: string; by: 'customer' | 'owner' }>;
  /** The owner flagged this automatic reply as bad ("Mark bad"). */
  markedBad: boolean;
}

export interface Thread {
  conversation: {
    id: string;
    name: string;
    secondary: string | null;
    status: ConversationStatus;
    windowExpiresAt: Date | null;
    lastInboundAt: Date | null;
    summary: string | null;
    consecutiveAutoReplies: number;
    replyMode: 'approval' | 'autopilot';
    autopilotUntil: Date | null;
    /** False for a name-only imported contact: there is nobody to send to, so the composer says so instead of failing. */
    canReceive: boolean;
  };
  /** Oldest first, ready to render top to bottom. */
  messages: ThreadMessage[];
  /** Pass back as `before` to load the earlier page; null when the start of the conversation is on screen. */
  olderCursor: string | null;
}

interface MessageRow extends Record<string, unknown> {
  id: string;
  direction: 'inbound' | 'outbound';
  type: MessageType;
  content: string | null;
  content_source: ThreadMessage['contentSource'];
  status: MessageStatus;
  provenance: Provenance;
  occurred_at: RawTimestamp;
  occurred_us: string;
  edited_at: RawTimestamp | null;
  deleted_at: RawTimestamp | null;
  media_id: string | null;
  media_path: string | null;
  media_mime: string | null;
  transcription_status: ThreadMessage['transcriptionStatus'];
  error: MessageError | null;
  reply_to_message_id: string | null;
  marked_bad_at: RawTimestamp | null;
}

const MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'document', 'sticker']);

function mediaOf(row: MessageRow): ThreadMessage['media'] {
  if (!MEDIA_TYPES.has(row.type) || row.deleted_at !== null) return { state: 'none', url: null, mime: null };
  if (row.media_path !== null) return { state: 'ready', url: `/api/media/${row.id}`, mime: row.media_mime };
  return { state: row.media_id !== null ? 'pending' : 'unavailable', url: null, mime: null };
}

/**
 * One page of a conversation, oldest first, plus everything needed to render it without further queries: the reply quotes
 * (even when the quoted message is on an earlier page) and the reactions attached to each message (the latest per side;
 * an empty reaction means it was removed). Reaction rows themselves are never shown as messages.
 */
export async function getThread(db: Db, conversationId: string, params: { before?: string | null | undefined; limit?: number } = {}): Promise<Thread | null> {
  const [head] = await db
    .select({
      id: conversations.id,
      status: conversations.status,
      windowExpiresAt: conversations.windowExpiresAt,
      lastInboundAt: conversations.lastInboundAt,
      summary: conversations.summary,
      consecutiveAutoReplies: conversations.consecutiveAutoReplies,
      replyMode: conversations.replyMode,
      autopilotUntil: conversations.autopilotUntil,
      displayName: contacts.displayName,
      username: contacts.username,
      phoneE164: contacts.phoneE164,
      bsuid: contacts.bsuid,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!head) return null;

  const limit = Math.min(Math.max(params.limit ?? THREAD_PAGE_SIZE, 1), 200);
  const before: Cursor | null = decodeCursor(params.before);
  const olderThan = before?.t ? sql`AND (m.occurred_at < ${before.t}::timestamptz OR (m.occurred_at = ${before.t}::timestamptz AND m.id < ${before.id}::uuid))` : sql``;

  const newestFirst = await db.execute<MessageRow>(sql`
    SELECT m.id, m.direction, m.type, m.content, m.content_source, m.status, m.provenance, m.occurred_at,
           to_char(m.occurred_at AT TIME ZONE 'UTC', ${MICROS}) AS occurred_us,
           m.edited_at, m.deleted_at, m.media_id, m.media_path, m.media_mime, m.transcription_status, m.error, m.reply_to_message_id, m.marked_bad_at
    FROM messages m
    WHERE m.conversation_id = ${conversationId} AND m.type <> 'reaction' ${olderThan}
    ORDER BY m.occurred_at DESC, m.id DESC
    LIMIT ${limit + 1}
  `);
  const hasMore = newestFirst.length > limit;
  const page = [...newestFirst].slice(0, limit).reverse();
  const oldest = page[0];

  const ids = page.map((row) => row.id);
  const quotedIds = [...new Set(page.map((row) => row.reply_to_message_id).filter((value): value is string => value !== null))];

  const quoted = new Map<string, { direction: 'inbound' | 'outbound'; preview: string }>();
  if (quotedIds.length > 0) {
    const rows = await db.execute<{ id: string; direction: 'inbound' | 'outbound'; type: string; content: string | null; deleted_at: RawTimestamp | null }>(sql`
      SELECT id, direction, type, content, deleted_at FROM messages WHERE id IN (${sql.join(quotedIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `);
    for (const row of rows) quoted.set(row.id, { direction: row.direction, preview: previewOf(row.type, row.content, row.deleted_at !== null) });
  }

  // Latest reaction per (message, side); later rows overwrite earlier ones, an empty emoji removes it.
  const reactions = new Map<string, Map<'customer' | 'owner', string>>();
  if (ids.length > 0) {
    const rows = await db.execute<{ reply_to_message_id: string; direction: 'inbound' | 'outbound'; content: string | null }>(sql`
      SELECT reply_to_message_id, direction, content FROM messages
      WHERE type = 'reaction' AND reply_to_message_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      ORDER BY occurred_at ASC, id ASC
    `);
    for (const row of rows) {
      const bySide = reactions.get(row.reply_to_message_id) ?? new Map<'customer' | 'owner', string>();
      const side = row.direction === 'inbound' ? 'customer' : 'owner';
      if (row.content) bySide.set(side, row.content);
      else bySide.delete(side);
      reactions.set(row.reply_to_message_id, bySide);
    }
  }

  const messages = page.map((row): ThreadMessage => {
    const deleted = row.deleted_at !== null;
    const quote = row.reply_to_message_id ? quoted.get(row.reply_to_message_id) : undefined;
    return {
      id: row.id,
      direction: row.direction,
      type: row.type,
      content: deleted ? null : row.content,
      contentSource: deleted ? null : row.content_source,
      status: row.status,
      provenance: row.provenance,
      occurredAt: toDate(row.occurred_at),
      editedAt: toDateOrNull(row.edited_at),
      deleted,
      media: mediaOf(row),
      transcriptionStatus: row.transcription_status,
      error: row.error,
      replyTo: row.reply_to_message_id && quote ? { id: row.reply_to_message_id, ...quote } : null,
      reactions: [...(reactions.get(row.id) ?? new Map<'customer' | 'owner', string>()).entries()].map(([by, emoji]) => ({ emoji, by })),
      markedBad: row.marked_bad_at !== null,
    };
  });

  return {
    conversation: {
      id: head.id,
      name: displayName(head),
      secondary: secondaryLine(head),
      status: head.status,
      windowExpiresAt: head.windowExpiresAt,
      lastInboundAt: head.lastInboundAt,
      summary: head.summary,
      consecutiveAutoReplies: head.consecutiveAutoReplies,
      replyMode: head.replyMode,
      autopilotUntil: head.autopilotUntil,
      canReceive: head.phoneE164 !== null || head.bsuid !== null,
    },
    messages,
    olderCursor: hasMore && oldest ? encodeCursor({ t: oldest.occurred_us, id: oldest.id }) : null,
  };
}
