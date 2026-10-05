import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { type Db, type Tx } from '@/lib/db';
import { conversations, drafts } from '@/lib/db/schema';
import type { Effect } from '@/lib/ingest/effects';
import { draftStatusesAllowing } from '@/lib/state/draft-machine';
import { enqueueAutopilotSend, promoteAutopilotJob } from './jobs';

/**
 * The owner's two controls over a countdown, the same from Telegram's buttons and from the dashboard. Both are idempotent: a second tap, or a
 * tap on a draft that has since been sent, replaced or handled, changes nothing and says so.
 */

/** `in_progress`: Send now was already pressed (the countdown's job is running or about to): a repeated tap, which changes nothing. */
export type ControlOutcome = 'done' | 'already_handled' | 'in_progress' | 'not_found';

/** Where the owner pressed it (recorded in the audit entry by the caller; the actor is always the owner). */
export type ControlVia = 'telegram' | 'dashboard';

/**
 * Cancel: `scheduled -> pending` (state machine `cancel_scheduled`): the draft is back in the owner's approval queue and nothing will be sent
 * automatically. Runs in the caller's transaction (an `ownerAction`, or the Telegram handler's own), which also writes the audit entry
 * (`autopilot.cancel`, with `via`). The effects to run after commit are returned.
 */
export async function cancelScheduled(tx: Tx, draftId: string): Promise<{ outcome: ControlOutcome; conversationId: string | null; effects: Effect[] }> {
  const [draft] = await tx.select({ conversationId: drafts.conversationId }).from(drafts).where(eq(drafts.id, draftId)).limit(1);
  if (!draft) return { outcome: 'not_found', conversationId: null, effects: [] };
  await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, draft.conversationId)).for('update');
  const moved = await tx
    .update(drafts)
    .set({ status: 'pending', scheduledSendAt: null })
    .where(and(eq(drafts.id, draftId), inArray(drafts.status, draftStatusesAllowing('cancel_scheduled'))))
    .returning({ id: drafts.id });
  if (moved.length === 0) return { outcome: 'already_handled', conversationId: draft.conversationId, effects: [] };
  return {
    outcome: 'done',
    conversationId: draft.conversationId,
    effects: [
      { type: 'retire_autopilot', draftId, note: 'Cancelled by you. It is waiting in Approvals.' },
      { type: 'publish', event: { type: 'autopilot:cancelled', payload: { conversationId: draft.conversationId, draftId } } },
      { type: 'publish', event: { type: 'draft:updated', payload: { conversationId: draft.conversationId, draftId, status: 'pending' } } },
    ],
  };
}

/**
 * Send now: skips the rest of the countdown. It does NOT bypass anything: the job runs at once and goes through the same re-check and the same send
 * path as one that waited. If the countdown's job has been lost (Redis was flushed), a new one is started with no delay. The caller writes the audit
 * entry (`autopilot.send_now`, with `via`).
 */
export async function sendNow(db: Db, draftId: string): Promise<{ outcome: ControlOutcome; conversationId: string | null }> {
  const [draft] = await db.select({ status: drafts.status, conversationId: drafts.conversationId }).from(drafts).where(eq(drafts.id, draftId)).limit(1);
  if (!draft) return { outcome: 'not_found', conversationId: null };
  if (draft.status !== 'scheduled') return { outcome: 'already_handled', conversationId: draft.conversationId };
  const state = await promoteAutopilotJob(draftId);
  // The job is already running or already promoted: this is a repeated tap, and it changes nothing.
  if (state === 'not_waiting') return { outcome: 'in_progress', conversationId: draft.conversationId };
  if (state === 'absent') await enqueueAutopilotSend(draftId, 0);
  return { outcome: 'done', conversationId: draft.conversationId };
}
