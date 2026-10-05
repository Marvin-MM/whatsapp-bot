'use server';

import { z } from 'zod';
import { ActionRefusal, type ActionResult } from '@/lib/actions/owner-action-core';
import { DraftRefused, approveDraft as approve, regenerateDraft as regenerate, rejectDraft as reject, requestDraftFor } from '@/lib/drafts/decide';
import { enqueueDraftNow } from '@/lib/drafts/trigger';
import { publishEvent } from '@/lib/realtime/publish';
import { refusingOnSendRefused } from '@/lib/send/refusal';
import { announceQueued } from '@/lib/send/send-message';
import { ownerAction } from './owner-action';

const idempotencyKey = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await refusingOnSendRefused(run);
  } catch (error) {
    if (error instanceof DraftRefused) throw new ActionRefusal(error.code, error.message);
    throw error;
  }
}

/** Best effort: the owner's decision is committed; a lost dashboard event only means the page refreshes a moment later. */
const tell = (conversationId: string, draftId: string, status: string) => publishEvent({ type: 'draft:updated', payload: { conversationId, draftId, status } }).catch(() => undefined);

export interface ApprovedDraft {
  messageId: string;
  conversationId: string;
  edited: boolean;
  duplicate: boolean;
}

const approveAction = ownerAction({
  name: 'drafts.approve',
  schema: z.object({
    draftId: z.uuid(),
    /** What is in the text box when the owner presses the button: the draft as written, or their edit of it. */
    text: z.string().max(20_000),
    /** "Send anyway": the customer wrote again after this draft was made. */
    overrideStale: z.boolean().default(false),
    idempotencyKey,
  }),
  handler: async ({ input, tx }) => {
    const result = await refusing(() => approve(tx, { draftId: input.draftId, finalContent: input.text, overrideStale: input.overrideStale, idempotencyKey: input.idempotencyKey }));
    return {
      data: { messageId: result.queued.messageId, conversationId: result.conversationId, edited: result.edited, duplicate: result.queued.duplicate } satisfies ApprovedDraft,
      // Lengths and the distance only: the audit log is not a second copy of the conversation.
      audit: {
        action: result.edited ? 'draft.approve_edited' : 'draft.approve',
        entityType: 'draft',
        entityId: input.draftId,
        metadata: { messageId: result.queued.messageId, conversationId: result.conversationId, editDistance: Number(result.editDistance.toFixed(4)), overrideStale: input.overrideStale, duplicate: result.queued.duplicate },
      },
      afterCommit: async () => {
        await announceQueued(result.queued);
        await tell(result.conversationId, input.draftId, result.edited ? 'edited' : 'approved');
      },
    };
  },
});

/**
 * Sends an AI draft: as written (provenance `ai_unedited`) or as edited by the owner (`ai_edited`, the edit distance is recorded). Goes through
 * the one send path: a `[[placeholder]]`, a closed window, a paused switch or a newer customer message refuses it with a reason and the draft stays pending.
 */
export async function approveDraft(input: unknown): Promise<ActionResult<ApprovedDraft>> {
  return approveAction(input);
}

const rejectAction = ownerAction({
  name: 'drafts.reject',
  schema: z.object({ draftId: z.uuid() }),
  handler: async ({ input, tx }) => {
    const { conversationId } = await refusing(() => reject(tx, input.draftId));
    return {
      data: { conversationId },
      audit: { action: 'draft.reject', entityType: 'draft', entityId: input.draftId, metadata: { conversationId } },
      afterCommit: () => tell(conversationId, input.draftId, 'rejected'),
    };
  },
});

/** "No, not this one." The customer stays waiting; the owner can reply by hand or ask for a new draft. */
export async function rejectDraft(input: unknown): Promise<ActionResult<{ conversationId: string }>> {
  return rejectAction(input);
}

const regenerateAction = ownerAction({
  name: 'drafts.regenerate',
  schema: z.object({ draftId: z.uuid() }),
  handler: async ({ input, tx }) => {
    const { conversationId } = await refusing(() => regenerate(tx, input.draftId));
    return {
      data: { conversationId },
      audit: { action: 'draft.regenerate', entityType: 'draft', entityId: input.draftId, metadata: { conversationId } },
      afterCommit: async () => {
        await enqueueDraftNow(conversationId);
        await tell(conversationId, input.draftId, 'superseded');
      },
    };
  },
});

/** Throws this draft away and writes a new one for the same messages (also the way to retry a draft that failed). */
export async function regenerateDraft(input: unknown): Promise<ActionResult<{ conversationId: string }>> {
  return regenerateAction(input);
}

const requestAction = ownerAction({
  name: 'drafts.request',
  schema: z.object({ conversationId: z.uuid() }),
  handler: async ({ input, tx }) => {
    await refusing(() => requestDraftFor(tx, input.conversationId));
    return {
      data: { conversationId: input.conversationId },
      audit: { action: 'draft.request', entityType: 'conversation', entityId: input.conversationId, metadata: {} },
      afterCommit: () => enqueueDraftNow(input.conversationId),
    };
  },
});

/** "Draft a reply" for a conversation that has no draft (AI was paused, or the last draft was rejected). */
export async function requestDraft(input: unknown): Promise<ActionResult<{ conversationId: string }>> {
  return requestAction(input);
}
