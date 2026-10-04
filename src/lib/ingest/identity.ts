import 'server-only';
import { eq } from 'drizzle-orm';
import { writeAudit } from '@/lib/audit';
import type { Tx } from '@/lib/db';
import { contacts } from '@/lib/db/schema';
import { isBsuid } from '@/lib/whatsapp/phone';
import type { AppStateItem, MessageItem, UserIdUpdateItem } from '@/lib/whatsapp/webhook-schema';
import { type HandlerResult, nothing } from './context';
import { conflictEffects, findContactByBsuid, lockIdentity, mergeContacts, resolveContact } from './contacts';
import { inboundIdentity } from './sender';

/**
 * A customer's BSUID changed (they changed their phone number). Rewrites `previous` to `current`:
 *   - we know `previous` only        -> rewrite it;
 *   - we know both (a message with the new id raced ahead of this notice and created a second record) -> merge the two,
 *     keeping the older record, and take the new id;
 *   - we know `current` only or neither -> nothing to do.
 * Returns what happened, for the audit trail and the tests.
 */
export async function applyBsuidRewrite(tx: Tx, previous: string, current: string): Promise<'rewritten' | 'merged' | 'unchanged'> {
  if (!isBsuid(previous) || !isBsuid(current) || previous === current) return 'unchanged';
  await lockIdentity(tx, previous, null);
  await lockIdentity(tx, current, null);

  const older = await findContactByBsuid(tx, previous);
  if (!older) return 'unchanged';
  const newer = await findContactByBsuid(tx, current);

  if (newer && newer.id !== older.id) {
    await mergeContacts(tx, older.id, newer.id, 'user_id_update');
    await tx.update(contacts).set({ bsuid: current, updatedAt: new Date() }).where(eq(contacts.id, older.id));
    await writeAudit(tx, { actor: 'system', action: 'contact.bsuid_rewritten', entityType: 'contact', entityId: older.id, metadata: { merged: true } });
    return 'merged';
  }
  if (newer) return 'unchanged';

  await tx.update(contacts).set({ bsuid: current, updatedAt: new Date() }).where(eq(contacts.id, older.id));
  await writeAudit(tx, { actor: 'system', action: 'contact.bsuid_rewritten', entityType: 'contact', entityId: older.id, metadata: { merged: false } });
  return 'rewritten';
}

/** The `user_id_update` webhook field. The phone number in it is deliberately not trusted for rewriting (old or new is unclear). */
export async function applyUserIdUpdate(tx: Tx, item: UserIdUpdateItem): Promise<HandlerResult> {
  const { previous, current } = item.update.user_id;
  const outcome = await applyBsuidRewrite(tx, previous, current);
  return nothing(outcome === 'unchanged' ? 'user_id_update_no_matching_contact' : undefined);
}

/**
 * System messages are notices about the customer, not chat: they never become a message row, never touch the window
 * or the status. `user_changed_number` moves the phone; `user_changed_user_id` rewrites the BSUID.
 */
export async function applySystemMessage(tx: Tx, item: MessageItem): Promise<HandlerResult> {
  const { message } = item;
  const system = message.system;
  if (!system) return nothing('system_message_ignored');

  switch (system.type) {
    case 'user_changed_number': {
      const identity = inboundIdentity(message, item.contacts);
      const resolved = await resolveContact(
        tx,
        { bsuid: system.user_id ?? identity.bsuid, phone: system.wa_id },
        // A notice about someone we never talked to is not a reason to create a record for them.
        { withConversation: false, create: false, replacePhone: true },
      );
      return resolved ? { effects: conflictEffects(resolved) } : nothing('system_message_unknown_customer');
    }
    case 'user_changed_user_id': {
      const previous = system.previous_user_id;
      const current = system.user_id ?? message.from_user_id;
      if (previous === undefined || current === undefined) return nothing('system_message_incomplete');
      await applyBsuidRewrite(tx, previous, current);
      return nothing();
    }
    default:
      return nothing('system_message_ignored');
  }
}

/**
 * `smb_app_state_sync`: the owner's Business app tells us what it calls a contact. That name outranks the customer's
 * WhatsApp profile name. A contact the owner removed from the phone is left alone: we keep the conversation history.
 */
export async function applyAppState(tx: Tx, item: AppStateItem): Promise<HandlerResult> {
  const contact = item.contact;
  if (!contact) {
    return item.errors && item.errors.length > 0
      ? {
          effects: [{ type: 'alert', alert: { kind: 'app_state_sync_error', severity: 'warning', entityId: item.request_id, dedupeKey: `app_state_sync_error:${item.request_id ?? 'none'}` } }],
          note: 'app_state_sync_error',
        }
      : nothing('app_state_empty');
  }
  if (contact.removed === true) return nothing('contact_removal_ignored');

  const resolved = await resolveContact(
    tx,
    { bsuid: contact.user_id, phone: contact.wa_id, profileName: contact.profile?.name, username: contact.profile?.username },
    // Names only: a contact without a conversation does not appear in the inbox until they actually write.
    { withConversation: false, nameFrom: 'owner' },
  );
  return resolved ? { effects: conflictEffects(resolved) } : nothing('app_state_contact_without_identity');
}
