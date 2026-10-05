import { type Processor, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { generateDraftForConversation } from '@/lib/drafts/generate';

const jobDataSchema = z.object({ conversationId: z.uuid(), waits: z.number().int().min(0).max(100).optional(), manual: z.boolean().optional() });

/**
 * `generate-draft`: one job per conversation burst (debounced). Everything is decided by `generateDraftForConversation`; a provider outage
 * is the only thing that throws (the queue retries it with backoff, 3 attempts), everything else is an outcome the log can show.
 */
export const generateDraftProcessor: Processor = async (job) => {
  const data = jobDataSchema.safeParse(job.data);
  if (!data.success) throw new UnrecoverableError('generate-draft job without a conversation id');
  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  return generateDraftForConversation(data.data.conversationId, { finalAttempt, ...(data.data.waits ? { waits: data.data.waits } : {}) });
};
