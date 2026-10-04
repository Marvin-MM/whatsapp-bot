import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

const TEST_REDIS_DB = 15;

function testRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set (test/setup/env.ts should have provided it)');
  const db = new URL(url).pathname.replace(/^\//, '');
  if (db !== String(TEST_REDIS_DB)) {
    throw new Error(`Refusing to use Redis db "${db}" in tests: expected /${TEST_REDIS_DB}`);
  }
  return url;
}

/** A BullMQ-compatible connection (maxRetriesPerRequest must be null for workers). */
export function createTestRedis(): Redis {
  return new Redis(testRedisUrl(), { maxRetriesPerRequest: null });
}

/** Unique per-test-file prefix so concurrent or stale runs never share queue keys. */
export function uniquePrefix(): string {
  return `wab-test-${randomUUID().slice(0, 8)}`;
}

/** Deletes every key under a BullMQ prefix. */
export async function cleanupPrefix(redis: Redis, prefix: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}
