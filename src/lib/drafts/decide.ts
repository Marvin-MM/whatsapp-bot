import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { drafts, settings } from '@/lib/db/schema';
import { editDistance } from '@/lib/metrics/edit-distance';
import { type QueuedMessage, SendRefused, queueMessage } from '@/lib/send/send-message';
import { draftStatusesAllowing } from '@/lib/state/draft-machine';
import { loadUnanswered } from './unanswered';

/**
 * The owner's decisions about a draft. Each runs inside the caller's transaction (an `ownerAction`), so the decision, its audit entry and
 * (for an approval) the queued message commit or roll back together. Approving goes through THE send path (`queueMessage`): the same pre-check,
 * the same draft claim, the same idempotency.
 */

export interface Approval {
  conversationId: string;
  queued: QueuedMessage;
  /** The text that was sent differs from what the model wrote (after trimming): provenance `ai_edited`, draft status `edited`. */
  edited: boolean;
  editDistance: number;
}

export async function approveDraft(tx: Tx, input: { draftId: string; finalContent: string; overrideStale: boolean; idempotencyKey: string; now?: Date }): Promise<Approval> {
  const [draft] = await tx.select({ conversationId: drafts.conversationId, original: drafts.originalContent }).from(drafts).where(eq(drafts.id, input.draftId)).limit(1);
  if (!draft) throw new SendRefused('draft_not_open', 'That draft no longer exists.');

  const queued = await queueMessage(tx, {
    conversationId: draft.conversationId,
    message: { kind: 'text', content: input.finalContent },
    idempotencyKey: input.idempotencyKey,
    source: { kind: 'draft', draftId: input.draftId, finalContent: input.finalContent, overrideStale: input.overrideStale },
    ...(input.now ? { now: input.now } : {}),
  });

  // "Edited" is decided exactly as the send path decides provenance (trimmed comparison), so the audit entry, the draft status and the
  // message provenance can never disagree: a trailing newline is not an edit.
  const original = draft.original.trim();
  const final = input.finalContent.trim();
  const distance = editDistance(original, final);
  // A repeated submission (same key) changed nothing the first time did not: do not rewrite the draft.
  if (!queued.duplicate) await tx.update(drafts).set({ editDistance: distance }).where(eq(drafts.id, input.draftId));
  return { conversationId: draft.conversationId, queued, edited: original !== final, editDistance: distance };
}

export class DraftRefused extends Error {
  constructor(
    readonly code: 'draft_not_open' | 'ai_paused' | 'nothing_to_answer' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'DraftRefused';
  }
}

/** pending | scheduled -> rejected, conditional on the status (two clicks, or a click racing an approval, cannot both win). */
export async function rejectDraft(tx: Tx, draftId: string): Promise<{ conversationId: string }> {
  const [row] = await tx
    .update(drafts)
    .set({ status: 'rejected' })
    .where(and(eq(drafts.id, draftId), inArray(drafts.status, draftStatusesAllowing('reject'))))
    .returning({ conversationId: drafts.conversationId });
  if (!row) throw new DraftRefused('draft_not_open', 'This draft was already handled.');
  return row;
}

/**
 * "Regenerate": an open draft is superseded (state machine `regenerate`); a failed one is simply drafted again. The caller enqueues the job after
 * commit. Refused while AI drafting is paused (the job would silently do nothing) and when there is nothing left to answer.
 */
export async function regenerateDraft(tx: Tx, draftId: string): Promise<{ conversationId: string }> {
  const [setting] = await tx.select({ aiPaused: settings.aiPaused }).from(settings).where(eq(settings.id, 1)).limit(1);
  if (setting?.aiPaused) throw new DraftRefused('ai_paused', 'AI drafting is paused. Turn it back on in Settings first.');
  const [draft] = await tx.select({ conversationId: drafts.conversationId, status: drafts.status }).from(drafts).where(eq(drafts.id, draftId)).limit(1);
  if (!draft) throw new DraftRefused('not_found', 'That draft no longer exists.');
  if (draft.status !== 'failed') {
    const [changed] = await tx
      .update(drafts)
      .set({ status: 'superseded' })
      .where(and(eq(drafts.id, draftId), inArray(drafts.status, draftStatusesAllowing('regenerate'))))
      .returning({ id: drafts.id });
    if (!changed) throw new DraftRefused('draft_not_open', 'This draft was already handled.');
  }
  if ((await loadUnanswered(tx, draft.conversationId)).length === 0) throw new DraftRefused('nothing_to_answer', 'The customer’s last message has already been answered.');
  return { conversationId: draft.conversationId };
}

/** "Draft a reply" from a conversation that has none (AI was paused, or a draft was rejected). */
export async function requestDraftFor(tx: Tx, conversationId: string): Promise<void> {
  const [setting] = await tx.select({ aiPaused: settings.aiPaused }).from(settings).where(eq(settings.id, 1)).limit(1);
  if (setting?.aiPaused) throw new DraftRefused('ai_paused', 'AI drafting is paused. Turn it back on in Settings first.');
  if ((await loadUnanswered(tx, conversationId)).length === 0) throw new DraftRefused('nothing_to_answer', 'The customer’s last message has already been answered.');
}
