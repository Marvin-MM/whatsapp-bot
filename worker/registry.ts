import type { Processor } from 'bullmq';
import type { QueueName } from '@/lib/queue/names';
import { processWebhookEventProcessor } from './processors/process-webhook-event';
import { scheduledProcessor } from './processors/scheduled';

export interface WorkerRegistration {
  queue: QueueName;
  processor: Processor;
  /** Overrides the catalog concurrency from QUEUE_SETTINGS. */
  concurrency?: number;
}

/**
 * Every queue processor in the system. Each phase appends its processors here:
 * Phase 1 process-webhook-event + download-media, Phase 2 outbound-send, and so on.
 */
export const WORKER_REGISTRATIONS: readonly WorkerRegistration[] = [
  { queue: 'process-webhook-event', processor: processWebhookEventProcessor },
  { queue: 'scheduled', processor: scheduledProcessor },
];
