import 'server-only';
import type { Job, JobsOptions, Queue } from 'bullmq';
import { withDeadline } from '@/lib/async';
import { getQueue } from './queues';
import type { QueueName } from './names';

/**
 * BullMQ rejects custom job ids containing ":" ("Custom Id cannot contain :", verified on 6.3), but the
 * spec's idempotency keys are `msg:{wamid}`, `send:{message_id}`, ... Percent-encoding keeps ids legal,
 * readable and injective, so callers can keep passing the spec's keys verbatim.
 */
export function toJobId(key: string): string {
  return encodeURIComponent(key);
}

export class QueueUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueUnavailableError';
  }
}

/** Upper bound for enqueueing from a request handler: Meta must get a 500 quickly so it retries. */
export const ENQUEUE_TIMEOUT_MS = 3000;

/**
 * `Queue.add` waits for Redis to become ready and never gives up (verified: against an unreachable Redis it
 * hangs indefinitely; connection-level maxRetriesPerRequest does not help). Request handlers must therefore
 * race it against a deadline.
 */
export async function enqueueOn<T>(
  queue: Queue,
  jobName: string,
  data: T,
  options: JobsOptions = {},
  timeoutMs: number = ENQUEUE_TIMEOUT_MS,
): Promise<Job> {
  const jobOptions: JobsOptions = options.jobId === undefined ? options : { ...options, jobId: toJobId(options.jobId) };
  return withDeadline(
    queue.add(jobName, data, jobOptions),
    timeoutMs,
    () => new QueueUnavailableError(`enqueue to "${queue.name}" timed out after ${timeoutMs}ms`),
  );
}

/** Enqueue onto a catalog queue with the catalog's default retry/backoff options. */
export function enqueue<T>(name: QueueName, jobName: string, data: T, options: JobsOptions = {}): Promise<Job> {
  return enqueueOn(getQueue(name), jobName, data, options);
}
