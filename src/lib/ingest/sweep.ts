import 'server-only';
import type { Queue } from 'bullmq';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import { raiseAlert } from '@/lib/alerts';
import { getDb } from '@/lib/db';
import { webhookEvents } from '@/lib/db/schema';
import { logger } from '@/lib/logger';
import { enqueueOn, toJobId } from '@/lib/queue/enqueue';
import { getQueue } from '@/lib/queue/queues';

export const SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
export const SWEEP_MAX_ATTEMPTS = 10;
const SWEEP_BATCH = 500;

export interface SweepResult {
  reenqueued: number;
  skipped: number;
  exhausted: number;
}

/**
 * Safety net for events that were stored but never processed (Redis was down during the webhook, a job exhausted its
 * retries, Redis was flushed). Every few minutes: re-enqueue unprocessed rows older than two minutes, counting attempts;
 * after ten attempts stop and raise an alert for the owner.
 *
 * BullMQ ignores `add` for an id that already exists, even in the failed set, so a finished job is removed first.
 * A job that is still waiting or running is left alone and does not consume an attempt.
 */
export async function sweepWebhookEvents(
  options: { now?: Date; olderThanMs?: number; maxAttempts?: number; queue?: Queue } = {},
): Promise<SweepResult> {
  const db = getDb();
  const queue = options.queue ?? getQueue('process-webhook-event');
  const maxAttempts = options.maxAttempts ?? SWEEP_MAX_ATTEMPTS;
  const cutoff = new Date((options.now ?? new Date()).getTime() - (options.olderThanMs ?? SWEEP_MIN_AGE_MS));

  const stale = await db
    .select({ id: webhookEvents.id, dedupeKey: webhookEvents.dedupeKey, attempts: webhookEvents.attempts })
    .from(webhookEvents)
    .where(and(isNull(webhookEvents.processedAt), lt(webhookEvents.receivedAt, cutoff)))
    .orderBy(asc(webhookEvents.receivedAt))
    .limit(SWEEP_BATCH);

  const result: SweepResult = { reenqueued: 0, skipped: 0, exhausted: 0 };

  for (const row of stale) {
    if (row.attempts >= maxAttempts) {
      result.exhausted += 1;
      await raiseAlert({ kind: 'webhook_event_stuck', severity: 'critical', entityId: row.id, dedupeKey: `webhook-stuck:${row.id}` });
      continue;
    }

    const existing = await queue.getJob(toJobId(row.dedupeKey));
    if (existing) {
      const state = await existing.getState();
      if (state !== 'failed' && state !== 'completed') {
        result.skipped += 1;
        continue;
      }
      await existing.remove();
    }

    await db
      .update(webhookEvents)
      .set({ attempts: sql`${webhookEvents.attempts} + 1` })
      .where(eq(webhookEvents.id, row.id));
    await enqueueOn(queue, 'process', { dedupeKey: row.dedupeKey }, { jobId: row.dedupeKey });
    result.reenqueued += 1;
  }

  if (result.reenqueued + result.exhausted > 0) logger.warn(result, 'webhook event sweep');
  return result;
}
