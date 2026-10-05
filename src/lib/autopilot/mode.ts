import 'server-only';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { conversations, drafts, messages, settings } from '@/lib/db/schema';
import type { Effect } from '@/lib/ingest/effects';
import { draftStatusesAllowing } from '@/lib/state/draft-machine';
import { cancelScheduledForConversation, demoteToApproval, retireEffects } from './demote';
import { type Eligibility, getEligibility } from './eligibility';

/**
 * Who may be on autopilot, and how the owner takes a conversation off it. Every function runs in the caller's transaction (an `ownerAction`) and
 * returns the effects to run after commit.
 */

export class AutopilotRefused extends Error {
  constructor(
    readonly code: 'gate_failed' | 'paused' | 'invalid_until' | 'not_found' | 'not_autopilot_message',
    message: string,
  ) {
    super(message);
    this.name = 'AutopilotRefused';
  }
}

/** The failed checks, in the owner's words, for a refusal message. */
export function failedChecksText(eligibility: Eligibility): string {
  return eligibility.checks
    .filter((check) => !check.ok)
    .map((check) => `${check.title}: ${check.detail}`)
    .join(' ');
}

/** "Until" may be at most this far ahead (a typo like year 2206 must not mean "forever"). */
export const MAX_UNTIL_DAYS = 365;

export const replyModeInputSchema = z.object({
  conversationId: z.uuid(),
  mode: z.enum(['approval', 'autopilot']),
  /** Optional end of the autopilot period (ISO date-time). Ignored for `approval`. */
  until: z.iso.datetime({ offset: true }).nullable().default(null),
});
export type ReplyModeInput = z.infer<typeof replyModeInputSchema>;

export interface ModeChange {
  conversationId: string;
  mode: 'approval' | 'autopilot';
  previous: 'approval' | 'autopilot';
  until: Date | null;
  /** Drafts that were counting down and went back to the owner's queue. */
  cancelledDraftIds: string[];
  effects: Effect[];
}

/**
 * Switches one conversation. To `autopilot`: only when the system-wide gate passes AND autopilot is not paused (spec 10.1), with an optional end
 * date in the future. To `approval`: always allowed, and any countdown running for this conversation stops.
 */
export async function changeReplyMode(tx: Tx, input: ReplyModeInput, now: Date = new Date()): Promise<ModeChange> {
  const [conversation] = await tx.select({ id: conversations.id, mode: conversations.replyMode }).from(conversations).where(eq(conversations.id, input.conversationId)).for('update');
  if (!conversation) throw new AutopilotRefused('not_found', 'That conversation no longer exists.');

  let until: Date | null = null;
  if (input.mode === 'autopilot') {
    const [setting] = await tx.select({ paused: settings.autopilotPaused }).from(settings).limit(1);
    if (setting?.paused ?? true) throw new AutopilotRefused('paused', 'Autopilot is paused. Turn it on in Settings -> Autopilot first (it only turns on once the checks there pass).');
    const eligibility = await getEligibility(tx, now);
    if (!eligibility.eligible) throw new AutopilotRefused('gate_failed', `Autopilot has not earned its trust yet. ${failedChecksText(eligibility)}`);
    if (input.until !== null) {
      until = new Date(input.until);
      if (until.getTime() <= now.getTime()) throw new AutopilotRefused('invalid_until', 'The end date must be in the future.');
      if (until.getTime() > now.getTime() + MAX_UNTIL_DAYS * 24 * 60 * 60 * 1000) throw new AutopilotRefused('invalid_until', `The end date can be at most ${MAX_UNTIL_DAYS} days away.`);
    }
    await tx.update(conversations).set({ replyMode: 'autopilot', autopilotUntil: until, updatedAt: now }).where(eq(conversations.id, input.conversationId));
    return { conversationId: input.conversationId, mode: 'autopilot', previous: conversation.mode, until, cancelledDraftIds: [], effects: [{ type: 'publish', event: { type: 'conversation:updated', payload: { conversationId: input.conversationId } } }] };
  }

  await tx.update(conversations).set({ replyMode: 'approval', autopilotUntil: null, updatedAt: now }).where(eq(conversations.id, input.conversationId));
  const cancelled = await cancelScheduledForConversation(tx, input.conversationId);
  return {
    conversationId: input.conversationId,
    mode: 'approval',
    previous: conversation.mode,
    until: null,
    cancelledDraftIds: cancelled,
    effects: [
      { type: 'publish', event: { type: 'conversation:updated', payload: { conversationId: input.conversationId } } },
      ...retireEffects(input.conversationId, cancelled, 'Cancelled: this conversation is back in approval mode. It is waiting in Approvals.'),
    ],
  };
}

/**
 * "Mark bad" on an automatic reply (spec 10.3): the message is flagged for review, the conversation goes back to approval mode, and any countdown for
 * it stops. Marking twice changes nothing more.
 */
export async function markMessageBad(tx: Tx, messageId: string, now: Date = new Date()): Promise<{ conversationId: string; alreadyMarked: boolean; demoted: boolean; effects: Effect[] }> {
  const [message] = await tx
    .select({ conversationId: messages.conversationId, direction: messages.direction, provenance: messages.provenance, markedBadAt: messages.markedBadAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .for('update');
  if (!message) throw new AutopilotRefused('not_found', 'That message no longer exists.');
  if (message.direction !== 'outbound' || message.provenance !== 'ai_autopilot') throw new AutopilotRefused('not_autopilot_message', 'Only a reply the autopilot sent can be marked bad.');

  const alreadyMarked = message.markedBadAt !== null;
  if (!alreadyMarked) await tx.update(messages).set({ markedBadAt: now }).where(eq(messages.id, messageId));

  const demoted = await demoteToApproval(tx, message.conversationId, { reason: 'marked_bad', actor: 'owner', entityId: messageId, entityType: 'message' });
  const cancelled = demoted ? await cancelScheduledForConversation(tx, message.conversationId) : [];
  return {
    conversationId: message.conversationId,
    alreadyMarked,
    demoted,
    effects: [
      { type: 'publish', event: { type: 'conversation:updated', payload: { conversationId: message.conversationId } } },
      ...retireEffects(message.conversationId, cancelled, 'Cancelled: you marked an automatic reply bad. It is waiting in Approvals.'),
    ],
  };
}

/**
 * Turning the whole autopilot off (the kill switch): every countdown that is running stops and its draft goes back to the owner's queue. A
 * paused autopilot would refuse them at the re-check anyway; this is faster, and the owner's phone stops offering buttons for them.
 */
export async function cancelAllScheduled(tx: Tx): Promise<Effect[]> {
  const rows = await tx
    .update(drafts)
    .set({ status: 'pending', scheduledSendAt: null })
    .where(inArray(drafts.status, draftStatusesAllowing('cancel_scheduled')))
    .returning({ id: drafts.id, conversationId: drafts.conversationId });
  return rows.flatMap((row) => retireEffects(row.conversationId, [row.id], 'Cancelled: autopilot was paused. It is waiting in Approvals.'));
}
