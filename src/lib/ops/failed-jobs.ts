import 'server-only';
import type { Job, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { withDeadline } from '@/lib/async';
import { type Db, getDb } from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { QUEUE_NAMES, type QueueName } from '@/lib/queue/names';
import { getQueue } from '@/lib/queue/queues';

/**
 * The failed-jobs panel (spec 5.3): BullMQ has no dead-letter queue, so a job that used up its attempts stays in the queue's failed set for 30
 * days. The owner can see what failed and why, retry the ones that are safe to retry, and dismiss the rest.
 *
 * What is shown is deliberately thin: the queue, the job's own name, when it failed, the error's text (our errors name types and fields, never
 * message text) and the ids from the job's data. Never a message body, a template value or a phone number: those are not in an id.
 */

export interface FailedJob {
  queue: QueueName;
  id: string;
  name: string;
  failedAt: Date | null;
  attemptsMade: number;
  /** The error's own words, shortened. */
  error: string;
  /** Ids from the job's data (message, conversation, draft, event), for finding the thing it was about. */
  subject: Array<{ label: string; value: string }>;
  retry: { allowed: true } | { allowed: false; reason: string };
}

const SUBJECT_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['messageId', 'Message'],
  ['conversationId', 'Conversation'],
  ['draftId', 'Draft'],
  ['dedupeKey', 'Event'],
];
const MAX_ERROR_CHARS = 200;
const MAX_VALUE_CHARS = 80;
const LIST_LIMIT = 25;
const REDIS_DEADLINE_MS = 3000;

function subjectOf(data: unknown): FailedJob['subject'] {
  if (typeof data !== 'object' || data === null) return [];
  const record = data as Record<string, unknown>;
  return SUBJECT_KEYS.flatMap(([key, label]) => {
    const value = record[key];
    return typeof value === 'string' && value !== '' ? [{ label, value: value.slice(0, MAX_VALUE_CHARS) }] : [];
  });
}

/**
 * Whether the owner may press "Retry". An `outbound-send` job is the dangerous one: running it again must never send a customer a second
 * message, so it is allowed ONLY for a message that was never stamped as started (the job failed before anything could have reached Meta).
 * Everything else the queues run is idempotent (a draft, a summary, a download, an ingest event) and may simply run again.
 */
export async function retryVerdict(db: Db, queue: QueueName, data: unknown): Promise<FailedJob['retry']> {
  if (queue !== 'outbound-send' && queue !== 'autopilot-send') return { allowed: true };
  const messageId = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).messageId : undefined;
  if (queue === 'autopilot-send') return { allowed: false, reason: 'A scheduled automatic reply is decided again from the conversation, never replayed.' };
  if (typeof messageId !== 'string') return { allowed: false, reason: 'This job names no message, so there is nothing to retry. Dismiss it.' };
  const [message] = await db.select({ status: messages.status, stamped: messages.sendStartedAt, wamid: messages.wamid }).from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!message) return { allowed: false, reason: 'The message no longer exists.' };
  if (message.status === 'unknown') return { allowed: false, reason: 'It may or may not have been sent. Check your phone, then mark it sent or send it again from the conversation: retrying here could send it twice.' };
  if (message.status === 'queued' && message.stamped === null && message.wamid === null) return { allowed: true };
  if (message.status === 'queued') return { allowed: false, reason: 'Sending had already started when the worker stopped, so it may have reached the customer. It will be marked "not confirmed" shortly: then check your phone.' };
  if (message.status === 'failed') return { allowed: false, reason: 'The message failed for good. Send it again from the conversation.' };
  return { allowed: false, reason: 'This message was already sent.' };
}

export async function listFailedJobs(options: { db?: Db; queues?: Partial<Record<QueueName, Queue>> } = {}): Promise<FailedJob[]> {
  const db = options.db ?? getDb();
  const lists = await Promise.all(
    QUEUE_NAMES.map(async (name) => {
      const queue = options.queues?.[name] ?? getQueue(name);
      const jobs = await withDeadline(queue.getFailed(0, LIST_LIMIT - 1), REDIS_DEADLINE_MS, () => new Error('queue read timed out'));
      return Promise.all(
        jobs.map(
          async (job): Promise<FailedJob> => ({
            queue: name,
            id: job.id ?? '',
            name: job.name,
            failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
            attemptsMade: job.attemptsMade,
            error: (job.failedReason ?? 'unknown error').replace(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS),
            subject: subjectOf(job.data),
            retry: await retryVerdict(db, name, job.data),
          }),
        ),
      );
    }),
  );
  return lists.flat().sort((a, b) => (b.failedAt?.getTime() ?? 0) - (a.failedAt?.getTime() ?? 0));
}

export class FailedJobRefused extends Error {
  constructor(
    readonly code: 'not_found' | 'not_failed' | 'blocked',
    message: string,
  ) {
    super(message);
    this.name = 'FailedJobRefused';
  }
}

async function failedJob(queue: Queue, id: string): Promise<Job> {
  const job = await withDeadline(queue.getJob(id), REDIS_DEADLINE_MS, () => new Error('queue read timed out'));
  if (!job) throw new FailedJobRefused('not_found', 'That job no longer exists (it may have been retried or removed already).');
  if ((await job.getState()) !== 'failed') throw new FailedJobRefused('not_failed', 'That job is no longer in the failed list.');
  return job;
}

/** Puts a failed job back in its queue. Refuses where `retryVerdict` says it is unsafe. */
export async function retryFailedJob(name: QueueName, id: string, options: { db?: Db; queue?: Queue } = {}): Promise<void> {
  const queue = options.queue ?? getQueue(name);
  const job = await failedJob(queue, id);
  const verdict = await retryVerdict(options.db ?? getDb(), name, job.data);
  if (!verdict.allowed) throw new FailedJobRefused('blocked', verdict.reason);
  await withDeadline(job.retry('failed'), REDIS_DEADLINE_MS, () => new Error('queue write timed out'));
}

/** Removes a failed job from the list (nothing is retried). Allowed for every queue: it only clears the record. */
export async function dismissFailedJob(name: QueueName, id: string, options: { queue?: Queue } = {}): Promise<void> {
  const queue = options.queue ?? getQueue(name);
  const job = await failedJob(queue, id);
  await withDeadline(job.remove(), REDIS_DEADLINE_MS, () => new Error('queue write timed out'));
}
