import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { supersedeDraftsTriggeredBy, supersedeOpenDrafts } from '@/lib/drafts/supersede';
import type { MessageItem, WebhookMessage } from '@/lib/whatsapp/webhook-schema';
import { type IngestContext, type HandlerResult, RetryLaterError, nothing } from './context';
import { conflictEffects, resolveContact } from './contacts';
import { refreshConversationAggregates, setConversationStatus } from './conversations';
import type { Effect } from './effects';
import { applySystemMessage } from './identity';
import { mapMessage, occurredAtOf } from './render';
import { inboundIdentity } from './sender';

export type Direction = 'inbound' | 'outbound';

export const mediaJob = (messageId: string): Effect => ({
  type: 'enqueue',
  queue: 'download-media',
  name: 'download',
  data: { messageId },
  opts: { jobId: `media:${messageId}` },
});

/** The row id of a message we already hold, by its wamid. */
export async function messageIdByWamid(tx: Tx, wamid: string | undefined): Promise<string | null> {
  if (!wamid) return null;
  const [row] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.wamid, wamid)).limit(1);
  return row?.id ?? null;
}

/**
 * Applies an edit or a delete-for-everyone to the message it refers to. Meta's exact shape is unconfirmed (see
 * D-031): the target is looked up by `context.id` first and by the message's own id second, so both plausible shapes work.
 *
 * Revoked: the row stays (thread order and replies keep pointing at it) but its text and transcript are blanked and
 * `deleted_at` is set. The customer deleted it; we do not keep showing it to the owner or feeding it to the model.
 * Edited: the content is replaced and `edited_at` set. Drafts that answered the old text are superseded.
 */
export async function applyEditOrRevoke(
  tx: Tx,
  message: WebhookMessage,
  direction: Direction,
  ctx: IngestContext,
): Promise<{ handled: false } | { handled: true; result: HandlerResult }> {
  const candidates = [message.context?.id, message.id].filter((value): value is string => Boolean(value));
  const found = await tx
    .select()
    .from(messages)
    .where(and(inArray(messages.wamid, candidates), eq(messages.direction, direction)))
    .for('update');
  const target = candidates.map((wamid) => found.find((row) => row.wamid === wamid)).find((row) => row !== undefined);
  if (!target) return { handled: false };

  const at = occurredAtOf(message, ctx.now);
  const effects: Effect[] = [];

  if (message.revoked === true) {
    await tx.update(messages).set({ deletedAt: at, content: null, contentSource: null }).where(eq(messages.id, target.id));
  } else {
    const mapped = mapMessage(message, { transcribeAudio: false, transcribable: false });
    if (mapped.content === null) return { handled: true, result: nothing('edit_without_content') };
    await tx.update(messages).set({ content: mapped.content, contentSource: mapped.contentSource, editedAt: at }).where(eq(messages.id, target.id));
  }

  if (direction === 'inbound') {
    for (const draftId of await supersedeDraftsTriggeredBy(tx, target.conversationId, target.id)) {
      effects.push({ type: 'publish', event: { type: 'draft:updated', payload: { conversationId: target.conversationId, draftId, status: 'superseded' } } });
    }
  }
  effects.push({ type: 'publish', event: { type: 'conversation:updated', payload: { conversationId: target.conversationId } } });
  return { handled: true, result: { effects } };
}

/**
 * One inbound customer message (spec 6.1 steps after the webhook). Idempotent: `messages.wamid` is UNIQUE, so a replay
 * inserts nothing and emits no events, yet still re-derives the media download so a crash between commit and enqueue
 * loses nothing.
 */
export async function ingestInboundMessage(tx: Tx, item: MessageItem, ctx: IngestContext): Promise<HandlerResult> {
  const message = item.message;
  if (message.group_id) return nothing('group_message_ignored');
  if (message.type === 'system') return applySystemMessage(tx, item);

  if (message.edited === true || message.revoked === true) {
    const outcome = await applyEditOrRevoke(tx, message, 'inbound', ctx);
    if (outcome.handled) return outcome.result;
    // The original may simply not have been processed yet (Meta does not guarantee order): wait, then settle.
    if (!ctx.finalAttempt) throw new RetryLaterError('edit_or_revoke_target_unknown');
    if (message.revoked === true) return nothing('revoke_target_unknown');
    // An edit whose original we never saw is still the customer's words: store it as a message below.
  }

  const resolved = await resolveContact(tx, inboundIdentity(message, item.contacts));
  if (!resolved || !resolved.conversation) {
    return {
      effects: [{ type: 'alert', alert: { kind: 'message_without_identity', severity: 'warning', dedupeKey: `message_without_identity:${message.id}` } }],
      note: 'no_customer_identity',
    };
  }
  const conversationId = resolved.conversation.id;
  const effects: Effect[] = [...conflictEffects(resolved)];

  const mapped = mapMessage(message, { transcribeAudio: ctx.transcribeAudio, transcribable: true });
  const occurredAt = occurredAtOf(message, ctx.now);
  const replyToMessageId = await messageIdByWamid(tx, mapped.type === 'reaction' ? mapped.reactionTarget ?? undefined : message.context?.id);

  const inserted = await tx
    .insert(messages)
    .values({
      conversationId,
      direction: 'inbound',
      wamid: message.id,
      type: mapped.type,
      content: mapped.content,
      contentSource: mapped.contentSource,
      mediaId: mapped.mediaId,
      mediaMime: mapped.mediaMime,
      replyToMessageId,
      provenance: 'customer',
      status: 'received',
      transcriptionStatus: mapped.transcription,
      editedAt: message.edited === true ? occurredAt : null,
      occurredAt,
    })
    .onConflictDoNothing({ target: messages.wamid })
    .returning({ id: messages.id });

  const insertedId = inserted[0]?.id;
  if (insertedId === undefined) {
    // Replay: nothing new to tell the dashboard, but a media download that never got enqueued must still happen.
    const [existing] = await tx
      .select({ id: messages.id, mediaId: messages.mediaId, mediaPath: messages.mediaPath })
      .from(messages)
      .where(eq(messages.wamid, message.id))
      .limit(1);
    if (existing?.mediaId && !existing.mediaPath) effects.push(mediaJob(existing.id));
    return { effects };
  }

  if (mapped.mediaId !== null) effects.push(mediaJob(insertedId));

  if (mapped.type === 'reaction') {
    // A reaction is not a new message to answer: it never touches the window, the status, the list order or drafts.
    effects.push({ type: 'publish', event: { type: 'message:new', payload: { conversationId, messageId: insertedId } } });
    return { effects };
  }

  await refreshConversationAggregates(tx, conversationId);
  await setConversationStatus(tx, conversationId, 'waiting_on_me');
  // A new customer message makes any open draft stale (Phase 4 then drafts again for the whole unanswered batch).
  for (const draftId of await supersedeOpenDrafts(tx, conversationId)) {
    effects.push({ type: 'publish', event: { type: 'draft:updated', payload: { conversationId, draftId, status: 'superseded' } } });
  }
  effects.push(
    { type: 'publish', event: { type: 'message:new', payload: { conversationId, messageId: insertedId } } },
    { type: 'publish', event: { type: 'conversation:updated', payload: { conversationId } } },
  );
  return { effects };
}
