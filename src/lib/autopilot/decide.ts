import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '@/lib/audit';
import { type Db, type Tx } from '@/lib/db';
import { type AutopilotDecision, conversations, drafts } from '@/lib/db/schema';
import { type Effect, runEffects } from '@/lib/ingest/effects';
import { logger } from '@/lib/logger';
import { isDraftStale } from '@/lib/send/send-message';
import { draftStatusesAllowing } from '@/lib/state/draft-machine';
import { demotionReasonFor, demoteToApproval } from './demote';
import { type DraftFacts, loadDraftFacts } from './facts';
import { enqueueAutopilotSend } from './jobs';
import { type RouteReason, checkPreVerifier, decideAutopilot, ruleGate, ruleMode } from './policy';
import { notifyAutopilotScheduled } from './telegram';
import { verifyReply } from './verify';

/**
 * What the autopilot does with a draft that was just written (spec 10.2 / 10.3).
 *
 *   not in autopilot mode        -> nothing: the owner is told about the draft as usual.
 *   the customer needs a person  -> the conversation goes back to approval mode (and the owner is told); the draft goes to approval.
 *   "ok" / "thanks"              -> closed silently (rejected, reason no_reply_needed): there is nothing to approve.
 *   any rule fails               -> the draft stays `pending` with the reasons recorded: it goes to the owner's approval queue.
 *   all rules pass               -> ask the independent verifier; if it passes too, the draft becomes `scheduled` and a countdown starts.
 *
 * It NEVER throws and NEVER sends: the worst it can do is leave the draft where it already is (pending, in the owner's queue). An error anywhere is
 * `error`, and the caller treats the draft as an ordinary one.
 */
export type AutopilotOutcome =
  | { kind: 'not_applicable' }
  | { kind: 'scheduled'; scheduledSendAt: Date }
  | { kind: 'routed'; reasons: RouteReason[] }
  | { kind: 'closed_no_reply' }
  | { kind: 'error' };

const decisionOf = (reasons: readonly string[], verifier: AutopilotDecision['verifier']): AutopilotDecision => ({ eligible: reasons.length === 0, reasons: [...reasons], verifier });

async function recordDecision(db: Db | Tx, draftId: string, decision: AutopilotDecision): Promise<void> {
  await db
    .update(drafts)
    .set({ autopilotDecision: decision })
    .where(and(eq(drafts.id, draftId), inArray(drafts.status, draftStatusesAllowing('schedule'))));
}

async function demote(db: Db, facts: DraftFacts, reason: NonNullable<ReturnType<typeof demotionReasonFor>>): Promise<void> {
  const changed = await db.transaction((tx) => demoteToApproval(tx, facts.conversationId, { reason, actor: 'autopilot', entityId: facts.draft.id, entityType: 'draft' }));
  if (!changed) return;
  await runEffects([
    { type: 'publish', event: { type: 'conversation:updated', payload: { conversationId: facts.conversationId } } },
    { type: 'alert', alert: { kind: 'autopilot_demoted', severity: 'warning', entityId: facts.conversationId, dedupeKey: `autopilot_demoted:${facts.draft.id}` } },
  ]);
}

async function closeNoReply(db: Db, facts: DraftFacts): Promise<boolean> {
  const effects = await db.transaction(async (tx): Promise<Effect[] | null> => {
    await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, facts.conversationId)).for('update');
    const closed = await tx
      .update(drafts)
      .set({ status: 'rejected', autopilotDecision: decisionOf(['no_reply_needed'], null) })
      .where(and(eq(drafts.id, facts.draft.id), inArray(drafts.status, draftStatusesAllowing('reject'))))
      .returning({ id: drafts.id });
    if (closed.length === 0) return null;
    await writeAudit(tx, { actor: 'autopilot', action: 'draft.reject', entityType: 'draft', entityId: facts.draft.id, metadata: { conversationId: facts.conversationId, reason: 'no_reply_needed' } });
    return [{ type: 'publish', event: { type: 'draft:updated', payload: { conversationId: facts.conversationId, draftId: facts.draft.id, status: 'rejected' } } }];
  });
  if (effects === null) return false;
  await runEffects(effects);
  return true;
}

type ScheduleResult = { kind: 'gone' } | { kind: 'routed'; reasons: RouteReason[] } | { kind: 'scheduled'; scheduledSendAt: Date; delaySeconds: number };

async function schedule(db: Db, facts: DraftFacts, verifier: NonNullable<AutopilotDecision['verifier']>, now: Date): Promise<ScheduleResult> {
  return db.transaction(async (tx): Promise<ScheduleResult> => {
    // Lock order everywhere: conversation, then draft. The verifier took seconds; look at everything again under the lock.
    await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, facts.conversationId)).for('update');
    const fresh = await loadDraftFacts(tx, facts.draft.id, now);
    if (!fresh || fresh.draft.status !== 'pending') return { kind: 'gone' };
    // The customer wrote again meanwhile: this draft answers an old state of the conversation, and a newer job is already writing the next one.
    if (await isDraftStale(tx, facts.conversationId, fresh.draft.triggerMessageIds)) return { kind: 'gone' };
    const reasons = checkPreVerifier(fresh.input);
    if (reasons.length > 0) {
      await recordDecision(tx, facts.draft.id, decisionOf(reasons, verifier));
      return { kind: 'routed', reasons };
    }
    const delaySeconds = fresh.settings.autopilotDelaySeconds;
    const scheduledSendAt = new Date(now.getTime() + delaySeconds * 1000);
    const scheduled = await tx
      .update(drafts)
      .set({ status: 'scheduled', scheduledSendAt, autopilotDecision: decisionOf([], verifier) })
      .where(and(eq(drafts.id, facts.draft.id), inArray(drafts.status, draftStatusesAllowing('schedule'))))
      .returning({ id: drafts.id });
    if (scheduled.length === 0) return { kind: 'gone' };
    await writeAudit(tx, { actor: 'autopilot', action: 'autopilot.schedule', entityType: 'draft', entityId: facts.draft.id, metadata: { conversationId: facts.conversationId, delaySeconds } });
    return { kind: 'scheduled', scheduledSendAt, delaySeconds };
  });
}

export async function runAutopilotForDraft(db: Db, draftId: string, now: Date = new Date()): Promise<AutopilotOutcome> {
  try {
    const facts = await loadDraftFacts(db, draftId, now);
    if (!facts || facts.draft.status !== 'pending') return { kind: 'not_applicable' };
    if (facts.input.conversation.replyMode !== 'autopilot') return { kind: 'not_applicable' };

    const demotion = demotionReasonFor(facts.draft);
    if (demotion !== null) await demote(db, facts, demotion);

    // Autopilot is genuinely running for this conversation (mode on, not expired, gate passing, not paused) and the customer only said "ok": stay silent.
    if (facts.draft.noReplyNeeded && ruleMode(facts.input).length === 0 && ruleGate(facts.input).length === 0 && demotion === null) {
      if (await closeNoReply(db, facts)) return { kind: 'closed_no_reply' };
      return { kind: 'not_applicable' };
    }

    const reasons = checkPreVerifier(facts.input);
    if (reasons.length > 0) {
      await recordDecision(db, draftId, decisionOf(reasons, null));
      return { kind: 'routed', reasons };
    }

    const verifier = await verifyReply(db, { conversationId: facts.conversationId, burstMessageIds: facts.draft.triggerMessageIds, reply: facts.draft.content, draftId, now });
    const decision = decideAutopilot(facts.input, verifier);
    const detail = verifier === 'error' ? null : { verdict: verifier.verdict, unsupportedClaims: [...verifier.unsupportedClaims], commitments: [...verifier.commitments], answersTheCustomer: verifier.answersTheCustomer, toneRisk: verifier.toneRisk };
    if (decision.action === 'route_to_approval') {
      await recordDecision(db, draftId, decisionOf(decision.reasons, detail));
      return { kind: 'routed', reasons: decision.reasons };
    }
    if (detail === null) return { kind: 'routed', reasons: ['verifier_error'] };

    const result = await schedule(db, facts, detail, now);
    if (result.kind === 'gone') return { kind: 'not_applicable' };
    if (result.kind === 'routed') return { kind: 'routed', reasons: result.reasons };

    // After commit. The countdown job failing to start is survivable (alerts-scan starts it for any scheduled draft that is overdue); the owner's phone is best effort.
    await runEffects([
      { type: 'publish', event: { type: 'autopilot:scheduled', payload: { conversationId: facts.conversationId, draftId, scheduledSendAt: result.scheduledSendAt.toISOString() } } },
      { type: 'publish', event: { type: 'draft:updated', payload: { conversationId: facts.conversationId, draftId, status: 'scheduled' } } },
    ]);
    await enqueueAutopilotSend(draftId, result.delaySeconds * 1000).catch((error: Error) => logger.warn({ error: error.name, draftId }, 'autopilot countdown not started (alerts-scan will start it)'));
    await notifyAutopilotScheduled(db, { draftId, delaySeconds: result.delaySeconds });
    return { kind: 'scheduled', scheduledSendAt: result.scheduledSendAt };
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.name : 'unknown', draftId }, 'autopilot decision failed; the draft stays in approval');
    return { kind: 'error' };
  }
}
