'use server';

import { z } from 'zod';
import { ActionRefusal, type ActionResult } from '@/lib/actions/owner-action-core';
import { FailedJobRefused, dismissFailedJob, retryFailedJob } from '@/lib/ops/failed-jobs';
import { QUEUE_NAMES } from '@/lib/queue/names';
import { ownerAction } from './owner-action';

const input = z.object({ queue: z.enum(QUEUE_NAMES), jobId: z.string().min(1).max(300) });

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FailedJobRefused) throw new ActionRefusal(error.code, error.message);
    throw error;
  }
}

const retryAction = ownerAction({
  name: 'jobs.retry',
  schema: input,
  handler: async ({ input: { queue, jobId } }) => {
    await refusing(() => retryFailedJob(queue, jobId));
    // Ids only: what the job was about is in the queue, and nothing of a message goes in the audit log.
    return { data: { queue, jobId }, audit: { action: 'job.retry', entityType: 'job', entityId: `${queue}/${jobId}`.slice(0, 200), metadata: { queue } } };
  },
});

/** Runs a failed job again. Refused (with the reason) for a send that might already have reached the customer. */
export async function retryJob(raw: unknown): Promise<ActionResult<{ queue: string; jobId: string }>> {
  return retryAction(raw);
}

const dismissAction = ownerAction({
  name: 'jobs.dismiss',
  schema: input,
  handler: async ({ input: { queue, jobId } }) => {
    await refusing(() => dismissFailedJob(queue, jobId));
    return { data: { queue, jobId }, audit: { action: 'job.dismiss', entityType: 'job', entityId: `${queue}/${jobId}`.slice(0, 200), metadata: { queue } } };
  },
});

/** Removes a failed job from the list without running it. */
export async function dismissJob(raw: unknown): Promise<ActionResult<{ queue: string; jobId: string }>> {
  return dismissAction(raw);
}
