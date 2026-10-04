import 'server-only';
import { type JobsOptions, Queue } from 'bullmq';
import { getEnv } from '@/lib/env';
import { getProducerConnection } from './connection';
import type { QueueName } from './names';

const SECOND = 1000;
const DAY_SECONDS = 24 * 60 * 60;

export interface QueueSettings {
  /** Total attempts including the first. */
  attempts: number;
  /** Exponential backoff base in ms; undefined means no retry delay (single attempt). */
  backoffMs: number | undefined;
  /** Worker concurrency. */
  concurrency: number;
}

/**
 * Spec 5.3 catalog. `outbound-send` allows 3 attempts, but ONLY errors classified safe-to-retry may use
 * them: ambiguous failures throw UnrecoverableError (never retried), and the worker runs with
 * maxStalledCount 0 so a crashed worker's job is never re-run (see the send path in spec 6.5).
 */
export const QUEUE_SETTINGS: Record<QueueName, QueueSettings> = {
  'process-webhook-event': { attempts: 5, backoffMs: 2 * SECOND, concurrency: 5 },
  'download-media': { attempts: 5, backoffMs: 5 * SECOND, concurrency: 2 },
  'generate-draft': { attempts: 3, backoffMs: 5 * SECOND, concurrency: 2 },
  'outbound-send': { attempts: 3, backoffMs: 5 * SECOND, concurrency: 1 },
  'autopilot-send': { attempts: 1, backoffMs: undefined, concurrency: 1 },
  'post-send-analysis': { attempts: 3, backoffMs: 10 * SECOND, concurrency: 2 },
  'style-extract': { attempts: 2, backoffMs: 10 * SECOND, concurrency: 1 },
  scheduled: { attempts: 3, backoffMs: 10 * SECOND, concurrency: 1 },
};

export function defaultJobOptions(name: QueueName): JobsOptions {
  const { attempts, backoffMs } = QUEUE_SETTINGS[name];
  return {
    attempts,
    ...(backoffMs === undefined ? {} : { backoff: { type: 'exponential', delay: backoffMs } }),
    removeOnComplete: { age: DAY_SECONDS, count: 1000 },
    // BullMQ has no dead-letter queue: failed jobs stay in the failed set for the Failed jobs panel.
    removeOnFail: { age: 30 * DAY_SECONDS },
  };
}

const queues = new Map<QueueName, Queue>();

/** Shared producer-side queue handle (lazy; uses the fail-fast producer connection). */
export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: getProducerConnection(),
      prefix: getEnv().BULLMQ_PREFIX,
      defaultJobOptions: defaultJobOptions(name),
    });
    queues.set(name, queue);
  }
  return queue;
}

export async function closeQueues(): Promise<void> {
  const open = [...queues.values()];
  queues.clear();
  await Promise.all(open.map((queue) => queue.close()));
}
