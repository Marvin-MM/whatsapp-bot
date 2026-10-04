import { type Processor, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { processWebhookEvent } from '@/lib/ingest/process-event';

const jobDataSchema = z.object({ dedupeKey: z.string().min(1) });

/**
 * `process-webhook-event`: one job per stored webhook event. The job carries only the dedupe key; the payload is read
 * from the database, which is the source of truth (and survives a Redis flush).
 */
export const processWebhookEventProcessor: Processor = async (job) => {
  const data = jobDataSchema.safeParse(job.data);
  if (!data.success) throw new UnrecoverableError('process-webhook-event job without a dedupeKey');

  const attempts = job.opts.attempts ?? 1;
  // attemptsMade counts attempts already finished; this one is the last when it makes up the difference.
  const finalAttempt = job.attemptsMade + 1 >= attempts;
  return processWebhookEvent(data.data.dedupeKey, { finalAttempt });
};
