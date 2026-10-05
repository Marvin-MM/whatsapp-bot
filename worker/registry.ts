import type { Processor } from 'bullmq';
import type { QueueName } from '@/lib/queue/names';
import { downloadMediaProcessor } from './processors/download-media';
import { generateDraftProcessor } from './processors/generate-draft';
import { outboundSendProcessor } from './processors/outbound-send';
import { postSendAnalysisProcessor } from './processors/post-send-analysis';
import { processWebhookEventProcessor } from './processors/process-webhook-event';
import { scheduledProcessor } from './processors/scheduled';
import { styleExtractProcessor } from './processors/style-extract';

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
  { queue: 'download-media', processor: downloadMediaProcessor },
  { queue: 'generate-draft', processor: generateDraftProcessor },
  { queue: 'outbound-send', processor: outboundSendProcessor },
  { queue: 'post-send-analysis', processor: postSendAnalysisProcessor },
  { queue: 'style-extract', processor: styleExtractProcessor },
  { queue: 'scheduled', processor: scheduledProcessor },
];
