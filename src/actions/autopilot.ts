'use server';

import { z } from 'zod';
import { ActionRefusal, type ActionResult } from '@/lib/actions/owner-action-core';
import { cancelScheduled, sendNow } from '@/lib/autopilot/controls';
import { AutopilotRefused, changeReplyMode, markMessageBad, replyModeInputSchema } from '@/lib/autopilot/mode';
import { applyAutopilotSettings, autopilotSettingsSchema } from '@/lib/autopilot/settings';
import { getDb } from '@/lib/db';
import { drafts } from '@/lib/db/schema';
import { runEffects } from '@/lib/ingest/effects';
import { eq } from 'drizzle-orm';
import { ownerAction } from './owner-action';

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AutopilotRefused) throw new ActionRefusal(error.code, error.message);
    throw error;
  }
}

// ------------------------------------------------------------------------------------------------------ reply mode

const modeAction = ownerAction({
  name: 'autopilot.setReplyMode',
  schema: replyModeInputSchema,
  handler: async ({ input, tx }) => {
    const change = await refusing(() => changeReplyMode(tx, input));
    return {
      data: { conversationId: change.conversationId, mode: change.mode, until: change.until?.toISOString() ?? null },
      audit: {
        action: change.mode === 'autopilot' ? 'conversation.autopilot_on' : 'conversation.autopilot_off',
        entityType: 'conversation',
        entityId: change.conversationId,
        metadata: { previous: change.previous, until: change.until?.toISOString() ?? null, cancelledDrafts: change.cancelledDraftIds.length },
      },
      afterCommit: () => runEffects(change.effects),
    };
  },
});

/**
 * Puts one conversation on autopilot (only while the system-wide checks pass and autopilot is not paused; refused with the failing numbers
 * otherwise), or takes it off (always allowed; a running countdown for it stops).
 */
export async function setReplyMode(input: unknown): Promise<ActionResult<{ conversationId: string; mode: 'approval' | 'autopilot'; until: string | null }>> {
  return modeAction(input);
}

// ------------------------------------------------------------------------------------------------------ mark bad

const markBadAction = ownerAction({
  name: 'autopilot.markBad',
  schema: z.object({ messageId: z.uuid() }),
  handler: async ({ input, tx }) => {
    const result = await refusing(() => markMessageBad(tx, input.messageId));
    return {
      data: { conversationId: result.conversationId, demoted: result.demoted },
      audit: { action: 'message.mark_bad', entityType: 'message', entityId: input.messageId, metadata: { conversationId: result.conversationId, alreadyMarked: result.alreadyMarked, demoted: result.demoted } },
      afterCommit: () => runEffects(result.effects),
    };
  },
});

/** "This automatic reply was bad": flags it for review and takes the conversation off autopilot. */
export async function markAutopilotBad(input: unknown): Promise<ActionResult<{ conversationId: string; demoted: boolean }>> {
  return markBadAction(input);
}

// ------------------------------------------------------------------------------------------------------ the countdown

const cancelAction = ownerAction({
  name: 'autopilot.cancel',
  schema: z.object({ draftId: z.uuid() }),
  handler: async ({ input, tx }) => {
    const result = await cancelScheduled(tx, input.draftId);
    if (result.outcome !== 'done') throw new ActionRefusal(result.outcome, result.outcome === 'not_found' ? 'That reply no longer exists.' : 'It was already sent, replaced or handled.');
    return {
      data: { conversationId: result.conversationId ?? '' },
      audit: { action: 'autopilot.cancel', entityType: 'draft', entityId: input.draftId, metadata: { conversationId: result.conversationId, via: 'dashboard' } },
      afterCommit: () => runEffects(result.effects),
    };
  },
});

/** Cancel: the reply is not sent automatically and waits in Approvals. */
export async function cancelAutopilotSend(input: unknown): Promise<ActionResult<{ conversationId: string }>> {
  return cancelAction(input);
}

const sendNowAction = ownerAction({
  name: 'autopilot.sendNow',
  schema: z.object({ draftId: z.uuid() }),
  handler: async ({ input, tx }) => {
    const [draft] = await tx.select({ status: drafts.status, conversationId: drafts.conversationId }).from(drafts).where(eq(drafts.id, input.draftId)).limit(1);
    if (!draft) throw new ActionRefusal('not_found', 'That reply no longer exists.');
    if (draft.status !== 'scheduled') throw new ActionRefusal('already_handled', 'It was already sent, replaced or handled.');
    return {
      data: { conversationId: draft.conversationId },
      audit: { action: 'autopilot.send_now', entityType: 'draft', entityId: input.draftId, metadata: { conversationId: draft.conversationId, via: 'dashboard' } },
      // The network work (Redis) happens after the commit. It still goes through the re-check and the send path.
      afterCommit: async () => {
        await sendNow(getDb(), input.draftId);
      },
    };
  },
});

/** Send now: skips the rest of the countdown (the final checks still run). */
export async function sendAutopilotNow(input: unknown): Promise<ActionResult<{ conversationId: string }>> {
  return sendNowAction(input);
}

// ------------------------------------------------------------------------------------------------------ settings

const settingsAction = ownerAction({
  name: 'autopilot.updateSettings',
  schema: autopilotSettingsSchema,
  handler: async ({ input, tx }) => {
    const changed = await applyAutopilotSettings(tx, input);
    return { data: { changed }, audit: { action: 'settings.autopilot', entityType: 'settings', entityId: '1', metadata: { changed } } };
  },
});

/** Delay, limits, allowed kinds of message and the disclosure line. (Turning autopilot on is the kill switch; each conversation is switched separately.) */
export async function updateAutopilotSettings(input: unknown): Promise<ActionResult<{ changed: string[] }>> {
  return settingsAction(input);
}
