/** Queue catalog (spec 5.3). Names are used as BullMQ queue names; they must not contain ':'. */
export const QUEUE_NAMES = [
  'process-webhook-event',
  'download-media',
  'generate-draft',
  'outbound-send',
  'autopilot-send',
  'post-send-analysis',
  'style-extract',
  'scheduled',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Job names that run on the `scheduled` queue as BullMQ job schedulers. */
export const SCHEDULED_JOB_NAMES = [
  'sweep-webhook-events',
  'alerts-scan',
  'token-health',
  'purge-payloads',
  'autopilot-digest',
] as const;

export type ScheduledJobName = (typeof SCHEDULED_JOB_NAMES)[number];
