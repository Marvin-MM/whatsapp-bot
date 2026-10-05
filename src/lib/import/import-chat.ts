import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { writeAudit } from '@/lib/audit';
import { type Db, type Tx } from '@/lib/db';
import { contacts, messages } from '@/lib/db/schema';
import { ensureConversation, refreshConversationAggregates } from '@/lib/ingest/conversations';
import { classifyIdentifier, normalizePhone } from '@/lib/whatsapp/phone';
import type { ParsedExport } from './parse-export';
import { isValidTimeZone, wallTimeToUtc } from './zoned-time';

/**
 * Stores a parsed WhatsApp export as `imported` messages. Everything here exists to make a re-run harmless and a wrong guess visible:
 *
 *  - IDEMPOTENT: every message gets a key derived from (contact, who, the exact minute, the n-th identical message in that minute,
 *    the text), so importing the same file twice inserts nothing the second time.
 *  - NEVER A DOUBLE of what WhatsApp already delivered: if the conversation already holds a message from the same side, in the same
 *    minute, with the same text (a live message, or Coexistence history), the imported copy is skipped.
 *  - NEVER OPENS THE 24h WINDOW: both sides are provenance `imported`, and the window is defined by live customer messages only.
 *  - ORDER KEPT: an export has minute resolution, so messages in the same minute are spaced a millisecond apart in file order.
 *  - NEW conversations are `resolved` (history, not something waiting on a reply); an existing conversation keeps its status.
 *  - NO GUESSED PEOPLE: a customer is matched by phone number when the export names one, otherwise by an exact name among earlier name-only
 *    imports; it is never linked to a live contact by name (two customers share a first name). `contactId` links it explicitly.
 */

export class ImportError extends Error {
  constructor(
    readonly code: 'me_not_found' | 'no_counterpart' | 'contact_not_found' | 'invalid_time_zone',
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportOptions {
  /** Which author is the owner. Matched ignoring case and surrounding space. */
  me: string;
  /** The phone's time zone when it exported (the owner's: `OWNER_TIMEZONE`). */
  timeZone: string;
  /** Link the chat to this existing contact instead of resolving the customer by phone or name. */
  contactId?: string;
  /** Recorded in the audit entry (a file name, never content). */
  fileLabel?: string;
}

export interface ImportResult {
  contactId: string;
  conversationId: string;
  createdContact: boolean;
  createdConversation: boolean;
  counterpart: string;
  /** Messages in the file that are real messages (not system lines), including the ones skipped below. */
  inFile: number;
  inserted: number;
  ownerInserted: number;
  customerInserted: number;
  /** Already imported earlier (same key). */
  alreadyImported: number;
  /** Already in the conversation from WhatsApp itself (same side, minute and text). */
  alreadyPresent: number;
  skippedDeleted: number;
  mediaPlaceholders: number;
  firstAt: Date | null;
  lastAt: Date | null;
}

const BATCH = 500;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

type Role = 'owner' | 'customer';

interface Prepared {
  role: Role;
  occurredAt: Date;
  text: string;
  media: boolean;
  key: string;
  minute: string;
}

/** Who is the customer in this file, and which author is the owner. */
export function resolveRoles(parsed: ParsedExport, me: string): { owner: string; counterpart: string } {
  const wanted = me.trim().toLowerCase();
  const owner = parsed.authors.find((author) => author.trim().toLowerCase() === wanted);
  if (owner === undefined) throw new ImportError('me_not_found', `"${me}" is not one of the senders in this file (${parsed.authors.join(', ')}).`);
  const counterpart = parsed.authors.find((author) => author !== owner);
  if (counterpart === undefined) throw new ImportError('no_counterpart', 'Only you wrote in this file, so there is no customer to attach it to.');
  return { owner, counterpart };
}

async function resolveContact(tx: Tx, counterpart: string, explicit: string | undefined): Promise<{ id: string; created: boolean }> {
  if (explicit !== undefined) {
    const [existing] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, explicit)).limit(1);
    if (!existing) throw new ImportError('contact_not_found', `No contact has the id ${explicit}.`);
    return { id: existing.id, created: false };
  }
  if (classifyIdentifier(counterpart) === 'phone') {
    const phone = normalizePhone(counterpart);
    if (phone !== null) {
      const [existing] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.phoneE164, phone)).limit(1);
      if (existing) return { id: existing.id, created: false };
      const [created] = await tx.insert(contacts).values({ phoneE164: phone, source: 'import_phone' }).returning({ id: contacts.id });
      if (!created) throw new Error('contact insert returned nothing');
      return { id: created.id, created: true };
    }
  }
  const [existing] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.source, 'import_name'), sql`lower(${contacts.displayName}) = lower(${counterpart})`))
    .limit(1);
  if (existing) return { id: existing.id, created: false };
  const [created] = await tx.insert(contacts).values({ displayName: counterpart, source: 'import_name' }).returning({ id: contacts.id });
  if (!created) throw new Error('contact insert returned nothing');
  return { id: created.id, created: true };
}

function prepare(parsed: ParsedExport, owner: string, contactId: string, timeZone: string): { rows: Prepared[]; skippedDeleted: number; media: number } {
  const seenMinute = new Map<string, number>();
  const seenIdentical = new Map<string, number>();
  const rows: Prepared[] = [];
  let skippedDeleted = 0;
  let media = 0;

  for (const message of parsed.messages) {
    if (message.kind === 'deleted') {
      skippedDeleted += 1;
      continue;
    }
    const role: Role = message.author === owner ? 'owner' : 'customer';
    const base = wallTimeToUtc(message.wall, timeZone);
    const minuteKey = base.toISOString();
    // Same-minute messages keep file order: 1 ms apart (a minute has room for 60,000 of them).
    const order = seenMinute.get(minuteKey) ?? 0;
    seenMinute.set(minuteKey, order + 1);
    const occurredAt = new Date(base.getTime() + Math.min(order, 999));

    const text = message.kind === 'media' ? '[Media omitted]' : message.text;
    const identical = `${role}|${minuteKey}|${text}`;
    const nth = seenIdentical.get(identical) ?? 0;
    seenIdentical.set(identical, nth + 1);
    if (message.kind === 'media') media += 1;

    rows.push({
      role,
      occurredAt,
      text,
      media: message.kind === 'media',
      key: `import:${sha(`${contactId}|${identical}|${nth}`)}`,
      minute: minuteKey.slice(0, 16),
    });
  }
  return { rows, skippedDeleted, media };
}

/** Imports one parsed export inside the caller's transaction. */
export async function importChat(tx: Tx, parsed: ParsedExport, options: ImportOptions): Promise<ImportResult> {
  if (!isValidTimeZone(options.timeZone)) throw new ImportError('invalid_time_zone', `"${options.timeZone}" is not a time zone.`);
  const { owner, counterpart } = resolveRoles(parsed, options.me);

  // One import per customer at a time: two parallel runs must not both create the contact.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`import:${counterpart.toLowerCase()}`}, 0))`);
  const contact = await resolveContact(tx, counterpart, options.contactId);
  const conversationsBefore = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM conversations WHERE contact_id = ${contact.id}::uuid`);
  const conversation = await ensureConversation(tx, contact.id, 'resolved');
  const createdConversation = (conversationsBefore[0]?.n ?? 0) === 0;

  const { rows, skippedDeleted, media } = prepare(parsed, owner, contact.id, options.timeZone);
  const first = rows.reduce<Date | null>((min, row) => (min === null || row.occurredAt < min ? row.occurredAt : min), null);
  const last = rows.reduce<Date | null>((max, row) => (max === null || row.occurredAt > max ? row.occurredAt : max), null);

  // What WhatsApp itself already gave us for this conversation in the same stretch of time.
  // (Earlier imports are excluded here: their keys already make a re-run harmless, and they should be reported as "already imported".)
  // A count, not a flag: two identical live messages in a minute cover two identical imported ones, not three.
  const present = new Map<string, number>();
  if (first && last) {
    const existing = await tx
      .select({ direction: messages.direction, content: messages.content, occurredAt: messages.occurredAt })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          ne(messages.provenance, 'imported'),
          gte(messages.occurredAt, new Date(first.getTime() - 120_000)),
          lte(messages.occurredAt, new Date(last.getTime() + 120_000)),
        ),
      );
    for (const message of existing) {
      if (message.content === null) continue;
      const key = `${message.direction === 'outbound' ? 'owner' : 'customer'}|${message.occurredAt.toISOString().slice(0, 16)}|${message.content}`;
      present.set(key, (present.get(key) ?? 0) + 1);
    }
  }

  const fresh = rows.filter((row) => {
    const key = `${row.role}|${row.minute}|${row.text}`;
    const remaining = present.get(key) ?? 0;
    if (remaining === 0) return true;
    present.set(key, remaining - 1);
    return false;
  });
  const alreadyPresent = rows.length - fresh.length;

  let inserted = 0;
  let ownerInserted = 0;
  for (let offset = 0; offset < fresh.length; offset += BATCH) {
    const batch = fresh.slice(offset, offset + BATCH);
    const returned = await tx
      .insert(messages)
      .values(
        batch.map((row) => ({
          conversationId: conversation.id,
          direction: row.role === 'owner' ? ('outbound' as const) : ('inbound' as const),
          type: row.media ? ('unsupported' as const) : ('text' as const),
          content: row.text,
          contentSource: row.media ? ('rendered' as const) : ('text' as const),
          provenance: 'imported' as const,
          status: row.role === 'owner' ? ('sent' as const) : ('received' as const),
          idempotencyKey: row.key,
          occurredAt: row.occurredAt,
        })),
      )
      .onConflictDoNothing({ target: messages.idempotencyKey })
      .returning({ key: messages.idempotencyKey });
    const insertedKeys = new Set(returned.map((row) => row.key));
    inserted += returned.length;
    ownerInserted += batch.filter((row) => row.role === 'owner' && insertedKeys.has(row.key)).length;
  }

  if (inserted > 0) await refreshConversationAggregates(tx, conversation.id);

  const result: ImportResult = {
    contactId: contact.id,
    conversationId: conversation.id,
    createdContact: contact.created,
    createdConversation,
    counterpart,
    inFile: rows.length,
    inserted,
    ownerInserted,
    customerInserted: inserted - ownerInserted,
    alreadyImported: fresh.length - inserted,
    alreadyPresent,
    skippedDeleted,
    mediaPlaceholders: media,
    firstAt: first,
    lastAt: last,
  };
  await writeAudit(tx, {
    actor: 'system',
    action: 'import.chat',
    entityType: 'conversation',
    entityId: conversation.id,
    metadata: { file: options.fileLabel ?? null, inserted, alreadyImported: result.alreadyImported, alreadyPresent, skippedDeleted, format: parsed.format, dateOrder: parsed.dateOrder, dateOrderCertain: parsed.dateOrderCertain },
  });
  return result;
}

/** Convenience for scripts and tests: one export, one transaction. */
export function importChatInDb(db: Db, parsed: ParsedExport, options: ImportOptions): Promise<ImportResult> {
  return db.transaction((tx) => importChat(tx, parsed, options));
}
