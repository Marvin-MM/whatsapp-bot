import 'server-only';
import { eq } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { conversations, messages } from '@/lib/db/schema';
import { supersedeOpenDrafts } from '@/lib/drafts/supersede';
import type { EchoItem } from '@/lib/whatsapp/webhook-schema';
import { type HandlerResult, RetryLaterError, type IngestContext, nothing } from './context';
import { conflictEffects, resolveContact } from './contacts';
import { refreshConversationAggregates, setConversationStatus } from './conversations';
import type { Effect } from './effects';
import { applyEditOrRevoke, mediaJob, messageIdByWamid } from './messages';
import { mapMessage, occurredAtOf } from './render';
import { echoCounterpart } from './sender';

/**
 * A message the owner sent from the WhatsApp Business app (Coexistence). It is stored as an outbound message with
 * provenance `owner_app_echo`, which is exactly the signal the style learner wants. Effects on the conversation:
 *   - it goes `waiting_on_customer`;
 *   - consecutive_auto_replies resets (a human just spoke);
 *   - every open draft is superseded: the owner already answered;
 *   - the 24h window is NOT touched: only the customer opens it (`refreshConversationAggregates` is the one definition).
 */
export async function ingestEcho(tx: Tx, item: EchoItem, ctx: IngestContext): Promise<HandlerResult> {
  const message = item.message;
  if (message.group_id) return nothing('group_message_ignored');

  if (message.edited === true || message.revoked === true) {
    const outcome = await applyEditOrRevoke(tx, message, 'outbound', ctx);
    if (outcome.handled) return outcome.result;
    if (!ctx.finalAttempt) throw new RetryLaterError('edit_or_revoke_target_unknown');
    if (message.revoked === true) return nothing('revoke_target_unknown');
  }

  const counterpart = echoCounterpart(message, ctx.ownNumber);
  if (counterpart === null) {
    return {
      effects: [{ type: 'alert', alert: { kind: 'echo_recipient_unknown', severity: 'warning', dedupeKey: `echo_recipient_unknown:${ctx.eventKey}` } }],
      note: 'echo_recipient_unknown',
    };
  }
  const resolved = await resolveContact(tx, counterpart);
  if (!resolved || !resolved.conversation) return nothing('echo_recipient_unknown');
  const conversationId = resolved.conversation.id;
  const effects: Effect[] = [...conflictEffects(resolved)];

  const mapped = mapMessage(message, { transcribeAudio: false, transcribable: false });
  const occurredAt = occurredAtOf(message, ctx.now);
  const replyToMessageId = await messageIdByWamid(tx, mapped.type === 'reaction' ? mapped.reactionTarget ?? undefined : message.context?.id);

  const inserted = await tx
    .insert(messages)
    .values({
      conversationId,
      direction: 'outbound',
      wamid: message.id,
      type: mapped.type,
      content: mapped.content,
      contentSource: mapped.contentSource,
      mediaId: mapped.mediaId,
      mediaMime: mapped.mediaMime,
      replyToMessageId,
      provenance: 'owner_app_echo',
      // Already sent from the phone; delivery statuses (if Meta sends them for app messages) move it forward.
      status: 'sent',
      editedAt: message.edited === true ? occurredAt : null,
      occurredAt,
    })
    .onConflictDoNothing({ target: messages.wamid })
    .returning({ id: messages.id });

  const insertedId = inserted[0]?.id;
  if (insertedId === undefined) {
    const [existing] = await tx
      .select({ id: messages.id, mediaId: messages.mediaId, mediaPath: messages.mediaPath })
      .from(messages)
      .where(eq(messages.wamid, message.id))
      .limit(1);
    if (existing?.mediaId && !existing.mediaPath) effects.push(mediaJob(existing.id));
    return { effects };
  }

  if (mapped.mediaId !== null) effects.push(mediaJob(insertedId));
  effects.push({ type: 'publish', event: { type: 'message:new', payload: { conversationId, messageId: insertedId } } });
  if (mapped.type === 'reaction') return { effects };

  await refreshConversationAggregates(tx, conversationId);
  await setConversationStatus(tx, conversationId, 'waiting_on_customer');
  await tx.update(conversations).set({ consecutiveAutoReplies: 0 }).where(eq(conversations.id, conversationId));
  for (const draftId of await supersedeOpenDrafts(tx, conversationId)) {
    effects.push({ type: 'publish', event: { type: 'draft:updated', payload: { conversationId, draftId, status: 'superseded' } } });
  }
  effects.push({ type: 'publish', event: { type: 'conversation:updated', payload: { conversationId } } });
  return { effects };
}
