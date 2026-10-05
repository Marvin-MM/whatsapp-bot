import { type Processor, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { performSend } from '@/lib/send/send-message';

const jobDataSchema = z.object({
  messageId: z.uuid(),
  template: z
    .object({
      name: z.string().min(1),
      language: z.string().min(1),
      components: z.array(z.record(z.string(), z.unknown())),
    })
    .optional(),
});

/**
 * `outbound-send`: deliver one queued message (spec 6.5). `performSend` decides everything: it sends at most once, ever. The only
 * error it throws is `SendRetryError`, for failures where Meta definitively did NOT send; BullMQ then retries with backoff.
 * Anything else (including a bug) must NOT be retried blindly (a retry could double-send), so it becomes unrecoverable and the
 * message is left `queued`/stamped for alerts-scan to turn into `unknown` and alert.
 */
export const outboundSendProcessor: Processor = async (job) => {
  const data = jobDataSchema.safeParse(job.data);
  if (!data.success) throw new UnrecoverableError('outbound-send job without a valid message id');
  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  try {
    return await performSend(data.data.messageId, { finalAttempt, template: data.data.template });
  } catch (error) {
    if (error instanceof Error && error.name === 'SendRetryError') throw error;
    throw new UnrecoverableError(error instanceof Error ? error.name : 'send failed');
  }
};
