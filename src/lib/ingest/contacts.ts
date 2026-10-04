import 'server-only';
import { type SQL, eq, inArray, sql } from 'drizzle-orm';
import { writeAudit } from '@/lib/audit';
import type { Tx } from '@/lib/db';
import { contacts, conversations, drafts, messages, tasks, webhookEvents } from '@/lib/db/schema';
import { isBsuid, normalizePhone } from '@/lib/whatsapp/phone';
import { type ConversationRow, type ConversationStatus, ensureConversation, refreshConversationAggregates } from './conversations';
import type { Effect } from './effects';

export type ContactRow = typeof contacts.$inferSelect;

/**
 * What a payload says about one person. Either identifier may be missing (a username user has a BSUID and no phone;
 * an imported or phone-app contact has a phone and, until their first webhook, no BSUID). Never assume a phone exists.
 */
export interface Identity {
  bsuid?: string | null | undefined;
  /** Any phone-ish value (`wa_id`, `from`, `to`); normalised to +E.164 here. */
  phone?: string | null | undefined;
  /** The name from the customer's WhatsApp profile. */
  profileName?: string | null | undefined;
  username?: string | null | undefined;
}

export interface ResolveOptions {
  /** Create and return the conversation too (default true). A name sync from the phone app only needs the contact. */
  withConversation?: boolean;
  /**
   * Who is naming the contact. `profile` (default) only fills a blank name; `owner` is the Business app's saved name
   * (smb_app_state_sync) and overwrites. Priority: owner-saved > existing > WhatsApp profile.
   */
  nameFrom?: 'profile' | 'owner';
  /** Create the contact when nobody matches (default true). System events about a customer we never met pass false. */
  create?: boolean;
  /** Status of a conversation created by this call (existing conversations are never touched). History sync passes `resolved`. */
  conversationStatus?: ConversationStatus;
  /**
   * Let this payload REPLACE a phone number already on file (default false: a phone is only ever filled in when blank).
   * Only an explicit `user_changed_number` notice sets it. Webhooks are retried for ~36 hours and arrive out of order, so
   * a message may carry an OLDER number than the one we hold; trusting it would point replies at a number that may now
   * belong to someone else.
   */
  replacePhone?: boolean;
}

export type IdentityConflict = 'phone_owned_by_other_person' | 'bsuid_differs_from_phone_owner' | 'phone_differs_for_bsuid';

export interface ResolvedContact {
  contact: ContactRow;
  conversation: ConversationRow | null;
  created: boolean;
  /** Set when the identifiers pointed at two DIFFERENT people: we refused to merge them and kept them apart. */
  conflict: IdentityConflict | null;
}

const MAX_NAME_LENGTH = 200;

function cleanName(value: string | null | undefined): string | null {
  const trimmed = value?.trim().slice(0, MAX_NAME_LENGTH);
  return trimmed ? trimmed : null;
}

const present = (value: string | null): value is string => value !== null;

/**
 * Serialises work on one person. Two webhooks for the same customer are processed concurrently (the worker runs several
 * jobs at once), and without this both could miss the contact and race to create it. Identifiers are locked in sorted
 * order so two jobs can never deadlock on each other.
 */
export async function lockIdentity(tx: Tx, bsuid: string | null, phone: string | null): Promise<void> {
  const keys = [bsuid === null ? null : `bsuid:${bsuid}`, phone === null ? null : `phone:${phone}`].filter(present).sort();
  for (const key of keys) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function findContact(tx: Tx, where: SQL): Promise<ContactRow | null> {
  const [row] = await tx.select().from(contacts).where(where).limit(1);
  return row ?? null;
}

export function findContactByBsuid(tx: Tx, bsuid: string): Promise<ContactRow | null> {
  return findContact(tx, eq(contacts.bsuid, bsuid));
}

export function findContactByPhone(tx: Tx, phone: string): Promise<ContactRow | null> {
  return findContact(tx, eq(contacts.phoneE164, phone));
}

/**
 * Finds or creates the contact for an identity (spec 6.3): match by BSUID, then by phone; when the two disagree about
 * which record is this person, merge them only if nothing contradicts that, otherwise keep them apart and say so.
 *
 *   - BSUID found, phone found, different records: the same person if neither side carries a CONFLICTING identifier
 *     (BSUID record without a phone or with this phone; phone record without a BSUID or with this BSUID) -> merge.
 *     Otherwise two real people share an identifier on paper (a recycled number, a changed BSUID we have not been told
 *     about): never merge two humans into one thread; use the BSUID record and flag it.
 *   - BSUID only: fill in a missing phone. A DIFFERENT phone is not trusted (it may be an older one arriving late): the
 *     number on file stays and the owner is told, unless an explicit `user_changed_number` notice asked to replace it.
 *   - phone only: adopt the BSUID if the record has none; if it already has a DIFFERENT one, that is a different WhatsApp
 *     user on a number we have on file: create a separate BSUID-keyed contact without the phone and flag it. Unless that
 *     BSUID is one the phone's owner USED to have (a retired id, per a stored `user_id_update`): then it is a late message
 *     from before the change and belongs to the same person.
 *   - neither: create.
 *
 * Returns null when the payload carries no usable identifier (or nobody matched and `create` is false).
 */
export async function resolveContact(tx: Tx, identity: Identity, options: ResolveOptions = {}): Promise<ResolvedContact | null> {
  const bsuid = identity.bsuid && isBsuid(identity.bsuid) ? identity.bsuid : null;
  const phone = normalizePhone(identity.phone);
  if (bsuid === null && phone === null) return null;

  await lockIdentity(tx, bsuid, phone);

  const byBsuid = bsuid === null ? null : await findContactByBsuid(tx, bsuid);
  const byPhone = phone === null ? null : await findContactByPhone(tx, phone);

  let contact: ContactRow;
  let created = false;
  let conflict: IdentityConflict | null = null;

  if (byBsuid && byPhone && byBsuid.id !== byPhone.id) {
    const samePerson = (byBsuid.phoneE164 === null || byBsuid.phoneE164 === phone) && (byPhone.bsuid === null || byPhone.bsuid === bsuid);
    if (samePerson) {
      contact = await mergeContacts(tx, byBsuid.id, byPhone.id, 'bsuid_and_phone_matched_different_records');
    } else {
      contact = byBsuid;
      conflict = 'phone_owned_by_other_person';
    }
  } else if (byBsuid) {
    contact = byBsuid;
    if (phone !== null && byBsuid.phoneE164 !== phone && !byPhone) {
      if (byBsuid.phoneE164 === null || options.replacePhone === true) {
        contact = await updateContact(tx, byBsuid.id, { phoneE164: phone });
        await writeAudit(tx, { actor: 'system', action: 'contact.phone_changed', entityType: 'contact', entityId: byBsuid.id, metadata: {} });
      } else {
        // Keep the number on file; the owner is told once. See ResolveOptions.replacePhone for why we do not just follow the payload.
        conflict = 'phone_differs_for_bsuid';
      }
    }
  } else if (byPhone) {
    if (bsuid === null || byPhone.bsuid === null) {
      contact = bsuid === null ? byPhone : await updateContact(tx, byPhone.id, { bsuid });
    } else if (await isRetiredBsuid(tx, bsuid, byPhone.bsuid)) {
      // A late or retried message from BEFORE the customer's id changed: same person, now known by `byPhone.bsuid`.
      contact = byPhone;
    } else {
      conflict = 'bsuid_differs_from_phone_owner';
      contact = await createContact(tx, { bsuid, phoneE164: null });
      created = true;
    }
  } else {
    if (options.create === false) return null;
    contact = await createContact(tx, { bsuid, phoneE164: phone });
    created = true;
  }

  contact = await applyNames(tx, contact, identity, options.nameFrom ?? 'profile');
  const conversation = options.withConversation === false ? null : await ensureConversation(tx, contact.id, options.conversationStatus);
  return { contact, conversation, created, conflict };
}

/** The ids a `user_id_update` replaced `bsuid` with, read from the events we stored (their dedupe key is `uidupd:{previous}:{current}`). */
async function successorsOf(tx: Tx, bsuid: string): Promise<string[]> {
  const prefix = `uidupd:${bsuid}:`;
  const rows = await tx.select({ key: webhookEvents.dedupeKey }).from(webhookEvents).where(sql`starts_with(${webhookEvents.dedupeKey}, ${prefix})`);
  return rows.map((row) => row.key.slice(prefix.length));
}

/**
 * True when `retired` was replaced (directly, or through up to three renames) by `current`. Needs no extra table: a
 * `user_id_update` event is stored forever (only its payload is purged), keyed by the pair of ids. This lookup runs only
 * on the rare path where a phone's owner has a different BSUID than the message brings.
 */
async function isRetiredBsuid(tx: Tx, retired: string, current: string): Promise<boolean> {
  const seen = new Set<string>([retired]);
  let frontier = [retired];
  for (let hop = 0; hop < 3 && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const successor of await successorsOf(tx, id)) {
        if (successor === current) return true;
        if (!seen.has(successor)) {
          seen.add(successor);
          next.push(successor);
        }
      }
    }
    frontier = next;
  }
  return false;
}

async function createContact(tx: Tx, ids: { bsuid: string | null; phoneE164: string | null }): Promise<ContactRow> {
  const [row] = await tx.insert(contacts).values({ ...ids, source: 'webhook' }).returning();
  if (!row) throw new Error('contact insert returned no row');
  return row;
}

async function updateContact(tx: Tx, id: string, patch: Partial<typeof contacts.$inferInsert>): Promise<ContactRow> {
  const [row] = await tx
    .update(contacts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(contacts.id, id))
    .returning();
  if (!row) throw new Error('contact vanished during update');
  return row;
}

async function applyNames(tx: Tx, contact: ContactRow, identity: Identity, nameFrom: 'profile' | 'owner'): Promise<ContactRow> {
  const name = cleanName(identity.profileName);
  const username = cleanName(identity.username);
  const patch: Partial<typeof contacts.$inferInsert> = {};
  if (name !== null && (nameFrom === 'owner' ? contact.displayName !== name : contact.displayName === null)) patch.displayName = name;
  // A username is the customer's own handle, not something the owner assigned: always follow the latest.
  if (username !== null && contact.username !== username) patch.username = username;
  return Object.keys(patch).length === 0 ? contact : updateContact(tx, contact.id, patch);
}

/**
 * Folds `drop` into `keep` in the caller's transaction and returns the surviving contact. Messages, drafts and tasks move
 * to `keep`'s conversation (or the conversation itself is re-homed when `keep` has none), the conversation's time fields
 * are recomputed from the merged messages, identifiers and names are combined, and an audit entry records it.
 *
 * Name choice: a name from an import (the owner's own label for the customer) beats a WhatsApp profile name.
 * Used by `resolveContact`, `user_id_update`, and the importer / owner-initiated merge (name-only imported contacts).
 */
export async function mergeContacts(tx: Tx, keepId: string, dropId: string, reason: string): Promise<ContactRow> {
  if (keepId === dropId) throw new Error('cannot merge a contact into itself');

  // Row locks in id order: two concurrent merges of the same pair cannot deadlock.
  const locked = await tx.select().from(contacts).where(inArray(contacts.id, [keepId, dropId])).orderBy(contacts.id).for('update');
  const keep = locked.find((row) => row.id === keepId);
  const drop = locked.find((row) => row.id === dropId);
  if (!keep || !drop) throw new Error('contact to merge no longer exists');

  const [keepConversation] = await tx.select().from(conversations).where(eq(conversations.contactId, keepId)).limit(1);
  const [dropConversation] = await tx.select().from(conversations).where(eq(conversations.contactId, dropId)).limit(1);

  let movedMessages = 0;
  let touchedConversationId: string | null = keepConversation?.id ?? null;

  if (dropConversation && !keepConversation) {
    await tx.update(conversations).set({ contactId: keepId, updatedAt: new Date() }).where(eq(conversations.id, dropConversation.id));
    touchedConversationId = dropConversation.id;
  } else if (dropConversation && keepConversation) {
    const moved = await tx
      .update(messages)
      .set({ conversationId: keepConversation.id })
      .where(eq(messages.conversationId, dropConversation.id))
      .returning({ id: messages.id });
    movedMessages = moved.length;
    await tx.update(drafts).set({ conversationId: keepConversation.id }).where(eq(drafts.conversationId, dropConversation.id));
    await tx.update(tasks).set({ conversationId: keepConversation.id }).where(eq(tasks.conversationId, dropConversation.id));

    const patch: Partial<typeof conversations.$inferInsert> = {};
    if (!keepConversation.summary && dropConversation.summary) {
      patch.summary = dropConversation.summary;
      patch.summaryThroughMessageId = dropConversation.summaryThroughMessageId;
    }
    // A thread that still needs the owner must not be hidden by the other record's "resolved".
    if (keepConversation.status === 'resolved' && dropConversation.status !== 'resolved') patch.status = dropConversation.status;
    if (Object.keys(patch).length > 0) await tx.update(conversations).set(patch).where(eq(conversations.id, keepConversation.id));

    await tx.delete(conversations).where(eq(conversations.id, dropConversation.id));
  }

  // Delete first: it frees the unique bsuid / phone the survivor is about to take.
  await tx.delete(contacts).where(eq(contacts.id, dropId));

  const importedLabel = drop.source !== 'webhook' && drop.displayName ? drop.displayName : null;
  const mergedNotes = [keep.notes, drop.notes].filter((note): note is string => Boolean(note)).join('\n');
  const survivor = await updateContact(tx, keepId, {
    bsuid: keep.bsuid ?? drop.bsuid,
    phoneE164: keep.phoneE164 ?? drop.phoneE164,
    displayName: importedLabel ?? keep.displayName ?? drop.displayName,
    username: keep.username ?? drop.username,
    source: keep.source === 'webhook' || drop.source === 'webhook' ? 'webhook' : keep.source,
    notes: mergedNotes === '' ? null : mergedNotes,
  });

  if (touchedConversationId) await refreshConversationAggregates(tx, touchedConversationId);
  await writeAudit(tx, {
    actor: 'system',
    action: 'contact.merge',
    entityType: 'contact',
    entityId: keepId,
    metadata: { mergedContactId: dropId, reason, movedMessages },
  });
  return survivor;
}

/** The alert for a refused merge. Once per contact and kind: the owner decides, we do not nag. */
export function conflictEffects(resolved: ResolvedContact): Effect[] {
  if (resolved.conflict === null) return [];
  return [
    {
      type: 'alert',
      alert: {
        kind: 'identity_conflict',
        severity: 'warning',
        entityId: resolved.contact.id,
        dedupeKey: `identity_conflict:${resolved.contact.id}:${resolved.conflict}`,
      },
    },
  ];
}
