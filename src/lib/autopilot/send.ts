import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '@/lib/audit';
import { type Db, type Tx, getDb } from '@/lib/db';
import { type AutopilotDecision, conversations, drafts } from '@/lib/db/schema';
import { type Effect, runEffects } from '@/lib/ingest/effects';
import { logger } from '@/lib/logger';
import { notifyDraftReady } from '@/lib/notify/draft-ready';
import { type QueuedMessage, SendRefused, announceQueued, queueMessage } from '@/lib/send/send-message';
import type { PrecheckCode } from '@/lib/send/precheck';
import { draftStatusesAllowing } from '@/lib/state/draft-machine';
import { type DraftFacts, disclosedWithin24h, loadDraftFacts } from './facts';
import { ROUTE_REASON_TEXT, type RouteReason, checkAtSend } from './policy';
import { retireAutopilotDraft } from './telegram';

/**
 * The delayed `autopilot-send` job (spec 10.3): the countdown is over.
 *
 *   1. Reload everything under the conversation lock. The draft must still be `scheduled`; if the owner handled it, the customer wrote again, or it
 *      was replaced, there is nothing to do (a scheduled draft is only ever released from `scheduled`).
 *   2. Ask the state-dependent rules again (1, 2, 6, 7, 8, 9: mode, gate/pause, window, limits, loop guard, quiet hours). Any failure puts the draft
 *      BACK in the approval queue with the reasons, and the owner gets the ordinary "draft ready" ping.
 *   3. Release it through THE send path (`queueMessage`, `autopilot: true`): the send path's own pre-check (kill switch, window, placeholder, staleness)
 *      has the last word; a refusal rolls the attempt back and routes the draft to approval too. Provenance is `ai_autopilot`.
 *   4. The first automatic reply in a 24-hour period carries the disclosure line.
 *
 * It runs with ONE attempt and can only send what `queueMessage` accepts, once (the message's idempotency key is the draft's id).
 */

export type AutopilotSendOutcome = { outcome: 'sent'; messageId: string } | { outcome: 'routed'; reasons: RouteReason[] } | { outcome: 'skipped' };

const REFUSAL_REASON: Partial<Record<PrecheckCode | 'not_found' | 'resend_not_supported' | 'not_unknown', RouteReason>> = {
  sending_paused: 'sending_paused',
  draft_stale: 'draft_stale',
  window_closed: 'window_closing',
  placeholder_unresolved: 'placeholder',
};

type TxResult =
  | { kind: 'skipped' }
  | { kind: 'sent'; queued: QueuedMessage; conversationId: string }
  | { kind: 'routed'; reasons: RouteReason[]; conversationId: string };

/** scheduled -> pending (state machine `recheck_failed`), with the reasons recorded on the draft and in the audit log. */
async function backToApproval(tx: Tx, facts: DraftFacts, reasons: RouteReason[]): Promise<boolean> {
  const previous = facts.draft.autopilotDecision as AutopilotDecision | null;
  const moved = await tx
    .update(drafts)
    .set({ status: 'pending', scheduledSendAt: null, autopilotDecision: { eligible: false, reasons, verifier: previous?.verifier ?? null } })
    .where(and(eq(drafts.id, facts.draft.id), inArray(drafts.status, draftStatusesAllowing('recheck_failed'))))
    .returning({ id: drafts.id });
  if (moved.length === 0) return false;
  await writeAudit(tx, { actor: 'autopilot', action: 'autopilot.recheck_failed', entityType: 'draft', entityId: facts.draft.id, metadata: { conversationId: facts.conversationId, reasons } });
  return true;
}

export async function autopilotSend(draftId: string, options: { now?: Date; db?: Db } = {}): Promise<AutopilotSendOutcome> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();

  const result = await db.transaction(async (tx): Promise<TxResult> => {
    const [pre] = await tx.select({ conversationId: drafts.conversationId, status: drafts.status }).from(drafts).where(eq(drafts.id, draftId)).limit(1);
    if (!pre || pre.status !== 'scheduled') return { kind: 'skipped' };
    await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, pre.conversationId)).for('update');

    const facts = await loadDraftFacts(tx, draftId, now);
    if (!facts || facts.draft.status !== 'scheduled') return { kind: 'skipped' };

    const reasons = checkAtSend(facts.input);
    if (reasons.length > 0) return (await backToApproval(tx, facts, reasons)) ? { kind: 'routed', reasons, conversationId: facts.conversationId } : { kind: 'skipped' };

    const disclosure = facts.settings.autopilotDisclosure.trim();
    const addDisclosure = disclosure !== '' && !(await disclosedWithin24h(tx, facts.conversationId, now));
    const finalContent = addDisclosure ? `${facts.draft.content.trimEnd()}\n\n${disclosure}` : facts.draft.content;

    try {
      // A savepoint: a refusal undoes whatever `queueMessage` did, and this transaction carries on to put the draft back in the queue.
      const queued = await tx.transaction((inner) =>
        queueMessage(inner, {
          conversationId: facts.conversationId,
          message: { kind: 'text', content: finalContent },
          idempotencyKey: `autopilot:${draftId}`,
          source: { kind: 'draft', draftId, finalContent, overrideStale: false, autopilot: true },
          now,
        }),
      );
      await writeAudit(tx, { actor: 'autopilot', action: 'autopilot.send', entityType: 'message', entityId: queued.messageId, metadata: { draftId, conversationId: facts.conversationId, disclosure: addDisclosure } });
      return { kind: 'sent', queued, conversationId: facts.conversationId };
    } catch (error) {
      if (!(error instanceof SendRefused)) throw error;
      if (error.code === 'draft_not_open') return { kind: 'skipped' };
      const reason = REFUSAL_REASON[error.code] ?? 'send_refused';
      return (await backToApproval(tx, facts, [reason])) ? { kind: 'routed', reasons: [reason], conversationId: facts.conversationId } : { kind: 'skipped' };
    }
  });

  if (result.kind === 'skipped') return { outcome: 'skipped' };

  if (result.kind === 'sent') {
    // Committed. Hand it to the worker; if that enqueue fails, alerts-scan re-enqueues any queued message that was never started.
    await announceQueued(result.queued).catch((error: Error) => logger.warn({ error: error.name, draftId }, 'autopilot send not announced (alerts-scan will start it)'));
    await runEffects([{ type: 'publish', event: { type: 'autopilot:sent', payload: { conversationId: result.conversationId, draftId, messageId: result.queued.messageId } } }] satisfies Effect[]).catch(() => undefined);
    await retireAutopilotDraft(db, draftId, 'Sent.');
    return { outcome: 'sent', messageId: result.queued.messageId };
  }

  // Routed back to the owner: say so on the phone, and ask for the decision the way every draft does.
  const first = result.reasons[0];
  await retireAutopilotDraft(db, draftId, `Not sent: ${first ? ROUTE_REASON_TEXT[first] : 'it needs your decision'}. It is waiting in Approvals.`);
  await runEffects([
    { type: 'publish', event: { type: 'autopilot:cancelled', payload: { conversationId: result.conversationId, draftId } } },
    { type: 'publish', event: { type: 'draft:updated', payload: { conversationId: result.conversationId, draftId, status: 'pending' } } },
  ]).catch(() => undefined);
  await notifyDraftReady(db, { conversationId: result.conversationId, draftId, now });
  return { outcome: 'routed', reasons: result.reasons };
}
