import type { Processor } from 'bullmq';
import { sweepWebhookEvents } from '@/lib/ingest/sweep';
import { logger } from '@/lib/logger';
import { scanSends } from '@/lib/ops/alerts-scan';
import { purgeOldPayloads } from '@/lib/ops/purge-payloads';
import { checkTokenHealth } from '@/lib/ops/token-health';
import type { ScheduledJobName } from '@/lib/queue/names';

type Handler = () => Promise<unknown>;

/**
 * Handlers for the recurring jobs on the `scheduled` queue. Phases add theirs here (autopilot-digest in Phase 7); a job name
 * with no handler is logged and skipped rather than retried forever.
 */
const HANDLERS: Partial<Record<ScheduledJobName, Handler>> = {
  'sweep-webhook-events': () => sweepWebhookEvents(),
  'alerts-scan': () => scanSends(),
  'token-health': () => checkTokenHealth(),
  'purge-payloads': async () => {
    const purged = await purgeOldPayloads();
    logger.info({ purged }, 'purged old webhook payloads');
  },
};

export const scheduledProcessor: Processor = async (job) => {
  const handler = HANDLERS[job.name as ScheduledJobName];
  if (!handler) {
    logger.warn({ job: job.name }, 'scheduled job has no handler');
    return;
  }
  await handler();
};
