import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '@/lib/audit';
import type { Tx } from '@/lib/db';
import { conversations, drafts } from '@/lib/db/schema';
import type { Effect } from '@/lib/ingest/effects';
import { draftStatusesAllowing } from '@/lib/state/draft-machine';

/**
 * Taking a conversation off autopilot (spec 10.3 "Demotion"). Two automatic triggers (the customer complained, was angry, or asked for a person)
 * and two owner triggers ("Mark bad" on an automatic reply, and the owner switching the conversation back themselves) all end the same way: the
 * conversation is in approval mode again, any countdown still running for it stops, and the change is audited.
 */

export type DemotionReason = 'complaint' | 'angry_customer' | 'asks_for_human' | 'marked_bad';

/** Pure: does this draft show that the customer needs a person? (spec 10.3: complaint, angry_customer, asks_for_human) */
export function demotionReasonFor(draft: { intent: string; riskFlags: readonly string[] }): DemotionReason | null {
  if (draft.intent === 'asks_for_human') return 'asks_for_human';
  if (draft.intent === 'complaint' || draft.riskFlags.includes('complaint')) return 'complaint';
  if (draft.riskFlags.includes('angry_customer')) return 'angry_customer';
  return null;
}

/**
 * Puts the conversation back in approval mode. Conditional on it being on autopilot, so a repeat changes nothing and writes nothing.
 * Returns whether anything changed.
 */
export async function demoteToApproval(
  tx: Tx,
  conversationId: string,
  input: { reason: DemotionReason; actor: 'autopilot' | 'owner'; entityId: string; entityType: 'draft' | 'message' | 'conversation' },
): Promise<boolean> {
  const changed = await tx
    .update(conversations)
    .set({ replyMode: 'approval', autopilotUntil: null, updatedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.replyMode, 'autopilot')))
    .returning({ id: conversations.id });
  if (changed.length === 0) return false;
  await writeAudit(tx, {
    actor: input.actor,
    action: 'autopilot.demote',
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: { conversationId, reason: input.reason },
  });
  return true;
}

/**
 * Every draft of the conversation that is counting down goes back to `pending` (state machine `cancel_scheduled`): used when the conversation or
 * the whole autopilot is switched off. Returns their ids so the caller can end the countdowns and close the Telegram messages after commit.
 */
export async function cancelScheduledForConversation(tx: Tx, conversationId: string): Promise<string[]> {
  const rows = await tx
    .update(drafts)
    .set({ status: 'pending', scheduledSendAt: null })
    .where(and(eq(drafts.conversationId, conversationId), inArray(drafts.status, draftStatusesAllowing('cancel_scheduled'))))
    .returning({ id: drafts.id });
  return rows.map((row) => row.id);
}

/** After commit: the countdowns of these drafts end and their Telegram messages lose their buttons. */
export function retireEffects(conversationId: string, draftIds: readonly string[], note: string): Effect[] {
  return draftIds.flatMap((draftId): Effect[] => [
    { type: 'retire_autopilot', draftId, note },
    { type: 'publish', event: { type: 'autopilot:cancelled', payload: { conversationId, draftId } } },
    { type: 'publish', event: { type: 'draft:updated', payload: { conversationId, draftId, status: 'pending' } } },
  ]);
}
