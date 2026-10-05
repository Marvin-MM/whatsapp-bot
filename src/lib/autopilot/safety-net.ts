import 'server-only';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { writeAudit } from '@/lib/audit';
import { type Db } from '@/lib/db';
import { type AutopilotDecision, conversations, drafts, notifications } from '@/lib/db/schema';
import { type Effect, runEffects } from '@/lib/ingest/effects';
import { logger } from '@/lib/logger';
import { notifyDraftReady } from '@/lib/notify/draft-ready';
import { toJobId } from '@/lib/queue/enqueue';
import { getQueue } from '@/lib/queue/queues';
import { draftStatusesAllowing } from '@/lib/state/draft-machine';
import { autopilotJobKey, enqueueAutopilotSend } from './jobs';

/**
 * The safety net under the autopilot countdown (run by `alerts-scan` every 5 minutes). A draft is `scheduled` only while a delayed job counts
 * down to its send; if that job is lost (Redis was flushed, the enqueue failed after the commit) the draft would wait forever, looking busy.
 *
 *   - Overdue by a minute or more and no live job: start one now, ONCE per draft (the job's own re-check decides, exactly as for any countdown).
 *   - Overdue by a quarter of an hour: the conversation has moved on too far for a delayed send to be wise. The draft goes back to the owner's
 *     approval queue (`countdown_lost`), who is told the ordinary way. Nothing is ever sent late on the autopilot's own initiative.
 */

export const COUNTDOWN_OVERDUE_MS = 60 * 1000;
export const COUNTDOWN_LOST_MS = 15 * 60 * 1000;

const LIVE_JOB_STATES = new Set(['delayed', 'waiting', 'active', 'prioritized', 'waiting-children']);

async function jobIsLive(draftId: string): Promise<boolean> {
  const job = await getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(draftId)));
  if (!job) return false;
  return LIVE_JOB_STATES.has(await job.getState());
}

export async function repairAutopilotCountdowns(db: Db, now: Date): Promise<{ restarted: number; returned: number }> {
  const overdue = await db
    .select({ id: drafts.id, conversationId: drafts.conversationId, scheduledSendAt: drafts.scheduledSendAt, decision: drafts.autopilotDecision })
    .from(drafts)
    .where(and(eq(drafts.status, 'scheduled'), lt(drafts.scheduledSendAt, new Date(now.getTime() - COUNTDOWN_OVERDUE_MS))))
    .limit(20);

  let restarted = 0;
  let returned = 0;
  for (const draft of overdue) {
    const lateBy = now.getTime() - (draft.scheduledSendAt?.getTime() ?? now.getTime());
    if (lateBy >= COUNTDOWN_LOST_MS) {
      const effects = await db.transaction(async (tx): Promise<Effect[] | null> => {
        await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, draft.conversationId)).for('update');
        const decision: AutopilotDecision = { eligible: false, reasons: ['countdown_lost'], verifier: (draft.decision as AutopilotDecision | null)?.verifier ?? null };
        const moved = await tx
          .update(drafts)
          .set({ status: 'pending', scheduledSendAt: null, autopilotDecision: decision })
          .where(and(eq(drafts.id, draft.id), inArray(drafts.status, draftStatusesAllowing('recheck_failed'))))
          .returning({ id: drafts.id });
        if (moved.length === 0) return null;
        await writeAudit(tx, { actor: 'system', action: 'autopilot.recheck_failed', entityType: 'draft', entityId: draft.id, metadata: { conversationId: draft.conversationId, reasons: ['countdown_lost'] } });
        return [
          { type: 'retire_autopilot', draftId: draft.id, note: 'Not sent: the countdown was lost. It is waiting in Approvals.' },
          { type: 'publish', event: { type: 'autopilot:cancelled', payload: { conversationId: draft.conversationId, draftId: draft.id } } },
          { type: 'publish', event: { type: 'draft:updated', payload: { conversationId: draft.conversationId, draftId: draft.id, status: 'pending' } } },
        ];
      });
      if (effects === null) continue;
      await runEffects(effects);
      await notifyDraftReady(db, { conversationId: draft.conversationId, draftId: draft.id, now });
      returned += 1;
      continue;
    }

    if (await jobIsLive(draft.id)) continue;
    // Once per draft: if the restarted countdown fails too, the quarter-hour rule above takes over.
    const claimed = await db.insert(notifications).values({ kind: 'autopilot_restart', dedupeKey: `autopilot_restart:${draft.id}` }).onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id: notifications.id });
    if (claimed.length === 0) continue;
    await enqueueAutopilotSend(draft.id, 0);
    restarted += 1;
  }
  if (restarted + returned > 0) logger.warn({ restarted, returned }, 'alerts-scan repaired autopilot countdowns');
  return { restarted, returned };
}

