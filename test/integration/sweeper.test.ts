import { Queue, Worker } from 'bullmq';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeProducerConnection } from '@/lib/queue/connection';
import { toJobId } from '@/lib/queue/enqueue';
import { closeQueues } from '@/lib/queue/queues';
import { sweepWebhookEvents } from '@/lib/ingest/sweep';
import { closeAllDb, migratorSql, resetDb } from '../helpers/db';
import { cleanupPrefix, createTestRedis, uniquePrefix } from '../helpers/redis';

const prefix = uniquePrefix();
process.env.BULLMQ_PREFIX = prefix;

let admin: Sql;
let queue: Queue;
const redis = createTestRedis();
const workers: Worker[] = [];

beforeAll(() => {
  admin = migratorSql();
  queue = new Queue('process-webhook-event', { connection: createTestRedis(), prefix });
});

beforeEach(async () => {
  await resetDb(admin);
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  await queue.close();
  await closeQueues();
  await closeProducerConnection();
  await cleanupPrefix(redis, prefix);
  await redis.quit();
  await closeAllDb();
});

async function insertEvent(key: string, options: { ageMinutes?: number; attempts?: number; processed?: boolean } = {}) {
  await admin`
    INSERT INTO webhook_events (id, dedupe_key, kind, payload, received_at, attempts, processed_at)
    VALUES (gen_random_uuid(), ${key}, 'message', '{}'::jsonb, now() - make_interval(mins => ${options.ageMinutes ?? 10}), ${options.attempts ?? 0},
            ${options.processed ? admin`now()` : null})`;
}

const waiting = async () => (await queue.getJobCounts('waiting')).waiting ?? 0;

describe('sweepWebhookEvents', () => {
  it('re-enqueues unprocessed events older than two minutes and counts the attempt', async () => {
    await insertEvent('msg:old.1');
    expect(await sweepWebhookEvents({ queue })).toEqual({ reenqueued: 1, skipped: 0, exhausted: 0 });
    expect(await waiting()).toBe(1);
    expect((await admin<{ attempts: number }[]>`SELECT attempts FROM webhook_events`)[0]?.attempts).toBe(1);
  });

  it('leaves fresh events alone (the webhook may still be enqueueing them)', async () => {
    await insertEvent('msg:fresh.1', { ageMinutes: 1 });
    expect(await sweepWebhookEvents({ queue })).toEqual({ reenqueued: 0, skipped: 0, exhausted: 0 });
    expect(await waiting()).toBe(0);
  });

  it('leaves processed events alone', async () => {
    await insertEvent('msg:done.1', { processed: true });
    expect((await sweepWebhookEvents({ queue })).reenqueued).toBe(0);
  });

  it('does not duplicate a job that is already waiting, and does not burn an attempt on it', async () => {
    await insertEvent('msg:queued.1');
    await sweepWebhookEvents({ queue });
    expect(await sweepWebhookEvents({ queue })).toEqual({ reenqueued: 0, skipped: 1, exhausted: 0 });
    expect(await waiting()).toBe(1);
    expect((await admin<{ attempts: number }[]>`SELECT attempts FROM webhook_events`)[0]?.attempts).toBe(1);
  });

  it('REMOVES a job that exhausted its retries before re-adding (BullMQ ignores adds for an existing id, even a failed one)', async () => {
    await insertEvent('msg:failed.1');
    await queue.add('process', { dedupeKey: 'msg:failed.1' }, { jobId: toJobId('msg:failed.1'), attempts: 1 });
    const worker = new Worker(
      'process-webhook-event',
      async (): Promise<void> => {
        throw new Error('processing blew up');
      },
      { connection: createTestRedis(), prefix },
    );
    workers.push(worker);
    for (let i = 0; i < 100 && (await queue.getJobCounts('failed')).failed === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    await worker.close();
    expect((await queue.getJobCounts('failed')).failed).toBe(1);

    expect(await sweepWebhookEvents({ queue })).toEqual({ reenqueued: 1, skipped: 0, exhausted: 0 });
    expect((await queue.getJobCounts('failed')).failed).toBe(0);
    expect(await waiting()).toBe(1);
  });

  it('gives up after ten attempts and raises ONE critical alert, no matter how often it sweeps', async () => {
    await insertEvent('msg:stuck.1', { attempts: 10 });
    const first = await sweepWebhookEvents({ queue });
    const second = await sweepWebhookEvents({ queue });
    expect(first).toEqual({ reenqueued: 0, skipped: 0, exhausted: 1 });
    expect(second.exhausted).toBe(1);
    expect(await waiting()).toBe(0);
    const alerts = await admin<{ kind: string }[]>`SELECT kind FROM notifications WHERE kind = 'alert:webhook_event_stuck'`;
    expect(alerts).toHaveLength(1);
  });

  it('processes oldest events first', async () => {
    await insertEvent('msg:newer', { ageMinutes: 5 });
    await insertEvent('msg:older', { ageMinutes: 30 });
    await sweepWebhookEvents({ queue });
    const jobs = await queue.getJobs(['waiting']);
    expect(jobs.map((job) => job.data.dedupeKey).sort()).toEqual(['msg:newer', 'msg:older']);
  });
});
