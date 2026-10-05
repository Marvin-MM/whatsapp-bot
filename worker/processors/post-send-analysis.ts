import { type Processor, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { analyzeAfterMessage } from '@/lib/analysis/analyze';

const jobDataSchema = z.object({ messageId: z.uuid() });

/**
 * `post-send-analysis`: the rolling summary and the task changes after one accepted outbound message (spec 9.5). A provider outage or a
 * conversation that changed under the model throws and is retried with backoff (3 attempts); everything else is an outcome for the log.
 */
export const postSendAnalysisProcessor: Processor = async (job) => {
  const data = jobDataSchema.safeParse(job.data);
  if (!data.success) throw new UnrecoverableError('post-send-analysis job without a message id');
  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  return analyzeAfterMessage(data.data.messageId, { finalAttempt });
};
