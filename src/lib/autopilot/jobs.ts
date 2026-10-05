import 'server-only';
import { toJobId, enqueue } from '@/lib/queue/enqueue';
import { getQueue } from '@/lib/queue/queues';
import { logger } from '@/lib/logger';

/** The delayed `autopilot-send` job for a draft (spec 10.3). One per draft: the key is the draft's id. */
export const autopilotJobKey = (draftId: string): string => `autopilot:${draftId}`;

/**
 * Starts the countdown. BullMQ ignores an `add` for an id that already exists, including a finished one, so a leftover job for this draft
 * (it cannot normally exist: a draft is scheduled once) is removed first.
 */
export async function enqueueAutopilotSend(draftId: string, delayMs: number): Promise<void> {
  const queue = getQueue('autopilot-send');
  const leftover = await queue.getJob(toJobId(autopilotJobKey(draftId)));
  if (leftover && (await leftover.isDelayed().catch(() => false)) === false) await leftover.remove().catch(() => undefined);
  await enqueue('autopilot-send', 'send', { draftId }, { jobId: autopilotJobKey(draftId), delay: Math.max(0, delayMs) });
}

/** Removes a draft's countdown. `busy` = the job is running right now (its own re-check will see the draft is no longer scheduled). Never throws. */
export async function removeAutopilotJob(draftId: string): Promise<'removed' | 'absent' | 'busy'> {
  try {
    const job = await getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(draftId)));
    if (!job) return 'absent';
    await job.remove();
    return 'removed';
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.name : 'unknown', draftId }, 'autopilot job not removed');
    return 'busy';
  }
}

/** "Send now": runs the countdown's job immediately. It still goes through the re-check. Idempotent: a second call finds nothing delayed. */
export async function promoteAutopilotJob(draftId: string): Promise<'promoted' | 'not_waiting' | 'absent'> {
  const job = await getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(draftId)));
  if (!job) return 'absent';
  if (!(await job.isDelayed())) return 'not_waiting';
  await job.promote();
  return 'promoted';
}
