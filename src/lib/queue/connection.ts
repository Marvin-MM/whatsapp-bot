import 'server-only';
import { Redis } from 'ioredis';
import { getEnv } from '@/lib/env';

/**
 * Two kinds of Redis connection, because they need opposite failure behavior:
 *
 * - Producers (web request handlers, pub/sub publish) must FAIL FAST. A webhook that cannot reach
 *   Redis must answer 500 within seconds so Meta retries, not hang behind an unbounded command queue.
 * - Workers need `maxRetriesPerRequest: null` (BullMQ requires it) so blocking commands survive reconnects.
 */

/** Fail-fast connection for enqueueing jobs and publishing events from request handlers. */
export function createProducerConnection(url: string = getEnv().REDIS_URL): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    commandTimeout: 3000,
    connectTimeout: 3000,
  });
}

/** Connection for BullMQ Workers and QueueEvents (blocking commands; never gives up on a command). */
export function createWorkerConnection(url: string = getEnv().REDIS_URL): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

let producer: Redis | undefined;

/** Shared producer connection for the process. */
export function getProducerConnection(): Redis {
  producer ??= createProducerConnection();
  return producer;
}

export async function closeProducerConnection(): Promise<void> {
  const current = producer;
  producer = undefined;
  await current?.quit().catch(() => current.disconnect());
}
