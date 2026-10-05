import { type Processor, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { autopilotSend } from '@/lib/autopilot/send';

const jobDataSchema = z.object({ draftId: z.uuid() });

/**
 * `autopilot-send`: the countdown of one scheduled draft is over (spec 10.3). One attempt, never retried by the queue: `autopilotSend` decides
 * everything (it re-checks, then sends through the one send path at most once, or puts the draft back in the owner's queue). A crash before it
 * commits changes nothing; a crash after is harmless because the message's idempotency key is the draft's id.
 */
export const autopilotSendProcessor: Processor = async (job) => {
  const data = jobDataSchema.safeParse(job.data);
  if (!data.success) throw new UnrecoverableError('autopilot-send job without a draft id');
  return autopilotSend(data.data.draftId);
};
