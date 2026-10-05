import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { HEARTBEAT_INTERVAL_SECONDS, HEARTBEAT_TTL_SECONDS, heartbeatKey } from '@/lib/ops/worker-health';
import { createWorkerConnection, getProducerConnection } from '@/lib/queue/connection';
import { QUEUE_SETTINGS } from '@/lib/queue/queues';
import type { WorkerRegistration } from './registry';

const HEARTBEAT_INTERVAL_MS = HEARTBEAT_INTERVAL_SECONDS * 1000;

// The key and its timing live with the reader (`lib/ops/worker-health.ts`) so the two cannot drift apart.
export { heartbeatKey };

export interface WorkerRuntime {
  workers: Worker[];
  /** Stops taking jobs, waits for active ones to finish, then releases every connection. */
  stop: () => Promise<void>;
}

/**
 * Starts one BullMQ Worker per registration plus a Redis heartbeat the web health check reads.
 *
 * outbound-send runs with maxStalledCount 0: if a worker dies after Meta accepted a message but before
 * we recorded it, BullMQ must NOT re-run the job (that would send twice). The send path's
 * `send_started_at` stamp is the second line of defence.
 */
export async function startWorkers(registrations: readonly WorkerRegistration[]): Promise<WorkerRuntime> {
  const prefix = getEnv().BULLMQ_PREFIX;

  // BullMQ does NOT close connections it is handed (verified): the runtime owns and closes them.
  const connections: Redis[] = [];

  const workers = registrations.map((registration) => {
    const connection = createWorkerConnection();
    connections.push(connection);
    const worker = new Worker(registration.queue, registration.processor, {
      connection,
      prefix,
      concurrency: registration.concurrency ?? QUEUE_SETTINGS[registration.queue].concurrency,
      ...(registration.queue === 'outbound-send' ? { maxStalledCount: 0 } : {}),
    });
    // An unhandled 'error' event would crash the process; log it and let BullMQ reconnect.
    worker.on('error', (error) => logger.error({ queue: registration.queue, error: error.name }, 'worker error'));
    worker.on('failed', (job, error) =>
      logger.warn({ queue: registration.queue, jobId: job?.id, name: job?.name, attemptsMade: job?.attemptsMade, error: error.name }, 'job failed'),
    );
    return worker;
  });

  const producer = getProducerConnection();
  const beat = () =>
    producer
      .set(heartbeatKey(prefix), new Date().toISOString(), 'EX', HEARTBEAT_TTL_SECONDS)
      .catch((error: Error) => logger.warn({ error: error.name }, 'heartbeat failed'));
  await beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      clearInterval(timer);
      await producer.del(heartbeatKey(prefix)).catch(() => undefined);
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all(connections.map((connection) => connection.quit().catch(() => connection.disconnect())));
    })();
    return stopping;
  };

  return { workers, stop };
}
