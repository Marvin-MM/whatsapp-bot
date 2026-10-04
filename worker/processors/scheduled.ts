import type { Processor } from 'bullmq';
import { sweepWebhookEvents } from '@/lib/ingest/sweep';
import { logger } from '@/lib/logger';
import type { ScheduledJobName } from '@/lib/queue/names';

type Handler = () => Promise<unknown>;

/**
 * Handlers for the recurring jobs on the `scheduled` queue. Phases add theirs here (alerts-scan, token-health,
 * purge-payloads in Phase 2, autopilot-digest in Phase 7); a job name with no handler is logged and skipped rather than
 * retried forever.
 */
const HANDLERS: Partial<Record<ScheduledJobName, Handler>> = {
  'sweep-webhook-events': () => sweepWebhookEvents(),
};

export const scheduledProcessor: Processor = async (job) => {
  const handler = HANDLERS[job.name as ScheduledJobName];
  if (!handler) {
    logger.warn({ job: job.name }, 'scheduled job has no handler');
    return;
  }
  await handler();
};
