import { type Processor, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { downloadMediaForMessage } from '@/lib/ingest/media-job';

const jobDataSchema = z.object({ messageId: z.uuid() });

/**
 * `download-media`: fetch one message's media, store it, and transcribe a voice note. The job carries only the message id;
 * everything else is read from the database, so a retry always works from current state.
 */
export const downloadMediaProcessor: Processor = async (job) => {
  const data = jobDataSchema.safeParse(job.data);
  if (!data.success) throw new UnrecoverableError('download-media job without a message id');
  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  return downloadMediaForMessage(data.data.messageId, { finalAttempt });
};
