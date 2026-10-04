import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createProducerConnection } from '@/lib/queue/connection';
import { QueueUnavailableError, enqueueOn, toJobId } from '@/lib/queue/enqueue';
import { registerSchedulers } from '../../worker/schedulers';
import { cleanupPrefix, createTestRedis, uniquePrefix } from '../helpers/redis';

/**
 * Phase 0 spike: proves the BullMQ 6 + ioredis 6 behavior the rest of the system relies on.
 * Each assertion documents something a later phase depends on; if an upgrade changes it, this fails first.
 */

const prefix = uniquePrefix();
const opened: Redis[] = [];
const queues: Queue[] = [];
const workers: Worker[] = [];

function conn(): Redis {
  const redis = createTestRedis();
  opened.push(redis);
  return redis;
}

function queue(name: string): Queue {
  const q = new Queue(name, { connection: conn(), prefix });
  queues.push(q);
  return q;
}

function worker(name: string, processor: (job: Job) => Promise<unknown>, options: Record<string, unknown> = {}): Worker {
  const w = new Worker(name, processor, { connection: conn(), prefix, ...options });
  workers.push(w);
  return w;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(25);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

afterAll(async () => {
  await Promise.all(workers.map((w) => w.close().catch(() => undefined)));
  await Promise.all(queues.map((q) => q.close().catch(() => undefined)));
  const cleaner = createTestRedis();
  await cleanupPrefix(cleaner, prefix);
  await cleaner.quit();
  await Promise.all(opened.map((r) => r.quit().catch(() => r.disconnect())));
});

describe('job ids (process-webhook-event idempotency)', () => {
  it('CANARY: BullMQ 6 rejects custom job ids containing ":", so the spec\'s `msg:{wamid}` keys cannot be used verbatim', async () => {
    // If a BullMQ upgrade lifts this restriction this test fails and toJobId can be simplified.
    const q = queue('ids-canary');
    await expect(q.add('process', {}, { jobId: 'msg:wamid.HBgM123' })).rejects.toThrow('Custom Id cannot contain :');
  });

  it('toJobId makes the spec\'s keys legal, and adding the same key twice yields ONE job (first payload wins)', async () => {
    const q = queue('ids');
    await enqueueOn(q, 'process', { attempt: 1 }, { jobId: 'msg:wamid.HBgM123=' });
    await enqueueOn(q, 'process', { attempt: 2 }, { jobId: 'msg:wamid.HBgM123=' });
    expect(await q.getJobCounts('waiting', 'delayed')).toMatchObject({ waiting: 1 });
    expect((await q.getJob(toJobId('msg:wamid.HBgM123=')))?.data).toEqual({ attempt: 1 });
  });

  it('adding a key after the first job completed and was removed creates a new job: dedupe is not forever', async () => {
    const q = queue('ids-complete');
    const seen: number[] = [];
    worker('ids-complete', async (job) => void seen.push(job.data.n));
    await enqueueOn(q, 'process', { n: 1 }, { jobId: 'msg:wamid.ABC', removeOnComplete: true });
    await until(() => seen.length === 1);
    await sleep(100);
    await enqueueOn(q, 'process', { n: 2 }, { jobId: 'msg:wamid.ABC', removeOnComplete: true });
    await until(() => seen.length === 2);
    expect(seen).toEqual([1, 2]);
  });
});

describe('debounce mode for generate-draft (deduplication + delay)', () => {
  const dedupe = (id: string, ttl: number) => ({ id, ttl, extend: true, replace: true }) as const;

  it('three adds with one dedupe id collapse into ONE delayed job carrying the LAST payload', async () => {
    const q = queue('debounce-collapse');
    for (const n of [1, 2, 3]) {
      await q.add('draft', { n }, { deduplication: dedupe('draft:conv-1', 2000), delay: 2000 });
    }
    const delayed = await q.getDelayed();
    expect(delayed).toHaveLength(1);
    expect(delayed[0]?.data).toEqual({ n: 3 });
  });

  it('every add resets the timer: processing happens one full delay after the LAST add', async () => {
    const q = queue('debounce-reset');
    const processedAt: number[] = [];
    worker('debounce-reset', async () => void processedAt.push(Date.now()));

    const delay = 500;
    const options = { deduplication: dedupe('draft:conv-2', delay), delay };
    await q.add('draft', { n: 1 }, options);
    await sleep(200);
    await q.add('draft', { n: 2 }, options);
    await sleep(200);
    const lastAdd = Date.now();
    await q.add('draft', { n: 3 }, options);

    await until(() => processedAt.length >= 1);
    await sleep(700);
    expect(processedAt).toHaveLength(1);
    expect((processedAt[0] ?? 0) - lastAdd).toBeGreaterThanOrEqual(delay - 60);
  });

  it('different conversations debounce independently', async () => {
    const q = queue('debounce-isolation');
    await q.add('draft', { c: 'a' }, { deduplication: dedupe('draft:conv-a', 2000), delay: 2000 });
    await q.add('draft', { c: 'b' }, { deduplication: dedupe('draft:conv-b', 2000), delay: 2000 });
    expect(await q.getDelayed()).toHaveLength(2);
  });

  it('OBSERVED (S3): a message arriving while the job is ACTIVE is NOT dropped; it makes a second job, and the older job can finish LAST', async () => {
    // Finding that corrects the plan: debounce never swallows the new message. But with concurrency > 1
    // two generations for the same conversation can overlap and complete out of order, so generate-draft
    // must still re-check at completion whether newer inbound messages exist (and discard if so).
    const q = queue('debounce-active');
    const finished: number[] = [];
    let started = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));

    worker(
      'debounce-active',
      async (job) => {
        started = true;
        if (job.data.n === 1) await gate;
        finished.push(job.data.n);
      },
      { concurrency: 2 },
    );

    const options = { deduplication: dedupe('draft:conv-3', 200), delay: 200 };
    const first = await q.add('draft', { n: 1 }, options);
    await until(() => started);

    const second = await q.add('draft', { n: 2 }, options);
    expect(second.id).not.toBe(first.id);
    expect(await q.getJobCounts('active', 'delayed')).toMatchObject({ active: 1, delayed: 1 });

    await until(() => finished.includes(2));
    expect(finished).toEqual([2]);
    release();
    await until(() => finished.length === 2);
    expect(finished).toEqual([2, 1]);
  });
});

describe('retries', () => {
  it('UnrecoverableError fails the job immediately: no retry even with attempts left (ambiguous send failures)', async () => {
    const q = queue('unrecoverable');
    let calls = 0;
    worker('unrecoverable', async () => {
      calls += 1;
      throw new UnrecoverableError('ambiguous: request may have reached Meta');
    });
    const job = await q.add('send', {}, { attempts: 3, backoff: { type: 'fixed', delay: 20 } });
    await until(async () => (await q.getJobCounts('failed')).failed === 1);
    expect(calls).toBe(1);
    expect((await q.getJob(job.id ?? ''))?.attemptsMade).toBe(1);
  });

  it('an ordinary error is retried up to `attempts` (safe-to-retry errors)', async () => {
    const q = queue('retries');
    let calls = 0;
    worker('retries', async () => {
      calls += 1;
      throw new Error('429 rate limited');
    });
    await q.add('send', {}, { attempts: 3, backoff: { type: 'fixed', delay: 20 } });
    await until(async () => (await q.getJobCounts('failed')).failed === 1);
    expect(calls).toBe(3);
  });

  it('a failed job stays in the failed set so the Failed jobs panel can list and retry it', async () => {
    const q = queue('failed-set');
    worker('failed-set', async () => {
      throw new Error('boom');
    });
    await q.add('x', { token: 'abc' }, { attempts: 1, removeOnFail: { age: 30 * 24 * 3600 } });
    await until(async () => (await q.getJobCounts('failed')).failed === 1);
    const [failed] = await q.getFailed();
    expect(failed?.failedReason).toBe('boom');
    await failed?.retry();
    await until(async () => (await q.getJobCounts('failed')).failed === 1);
  });
});

describe('job schedulers (the scheduled queue)', () => {
  it('registerSchedulers is idempotent across restarts and makes Redis match the definitions exactly', async () => {
    const q = queue('scheduled');
    const definitions = [
      { id: 'alerts-scan', repeat: { every: 300_000 } },
      { id: 'autopilot-digest', repeat: { pattern: '0 20 * * *', tz: 'Africa/Kampala' } },
    ] as const;

    await registerSchedulers(q, definitions);
    await registerSchedulers(q, definitions);
    expect((await q.getJobSchedulers()).map((s) => s.key).sort()).toEqual(['alerts-scan', 'autopilot-digest']);

    // A scheduler removed from code is removed from Redis on the next boot.
    await registerSchedulers(q, [definitions[0]]);
    expect((await q.getJobSchedulers()).map((s) => s.key)).toEqual(['alerts-scan']);
  });

  it('a cron pattern with tz fires in the OWNER timezone (20:00 Africa/Kampala = 17:00 UTC)', async () => {
    const q = queue('scheduled-tz');
    await registerSchedulers(q, [{ id: 'autopilot-digest', repeat: { pattern: '0 20 * * *', tz: 'Africa/Kampala' } }]);
    const scheduler = await q.getJobScheduler('autopilot-digest');
    const next = new Date(scheduler?.next ?? 0);
    expect(next.getUTCHours()).toBe(17);
    expect(next.getUTCMinutes()).toBe(0);
  });
});

describe('connections', () => {
  it('a Worker refuses a connection without maxRetriesPerRequest: null', () => {
    const bad = new Redis(process.env.REDIS_URL ?? '', { lazyConnect: true });
    opened.push(bad);
    expect(() => new Worker('conn-check', async () => undefined, { connection: bad, prefix })).toThrow(/maxRetriesPerRequest/);
  });

  it('OBSERVED: Queue.add against an unreachable Redis never settles by itself, so enqueueOn must enforce a deadline (webhook must 500, not hang)', async () => {
    const dead = createProducerConnection('redis://127.0.0.1:1/0');
    dead.on('error', () => undefined);
    const q = new Queue('unreachable', { connection: dead, prefix });
    q.on('error', () => undefined);

    // Without the deadline the add would hang; with it the caller gets a typed error quickly.
    const started = Date.now();
    await expect(enqueueOn(q, 'x', {}, {}, 1500)).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(Date.now() - started).toBeLessThan(4000);

    dead.disconnect();
    void q.close().catch(() => undefined);
  }, 15_000);

  it('worker.close() waits for the active job to finish (graceful shutdown), and does not close the connection you passed in', async () => {
    const q = queue('graceful');
    let started = false;
    let completed = false;
    const connection = conn();
    const w = new Worker(
      'graceful',
      async () => {
        started = true;
        await sleep(600);
        completed = true;
      },
      { connection, prefix },
    );
    await q.add('slow', {});
    await until(() => started);

    await w.close();
    expect(completed).toBe(true);
    expect((await q.getJobCounts('completed')).completed).toBe(1);
    expect(connection.status).toBe('ready'); // caller owns it: the runtime must close its own connections
  });
});

describe('crash recovery: why outbound-send runs with maxStalledCount 0', () => {
  /** Kills a worker with SIGKILL mid-job (after the "send" was counted), then lets a second worker recover. */
  async function crashScenario(maxStalledCount: number) {
    const name = `crash-${maxStalledCount}`;
    const q = queue(name);
    const probe = conn();

    // Spawn node directly: the `tsx` binary is a wrapper whose SIGKILL would orphan the real worker.
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/stall-worker.ts', prefix, name], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('ready') && resolve());
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`child exited early with ${code}`)));
    });

    await q.add('send', {}, { attempts: 1 });
    await until(async () => Number(await probe.get(`${prefix}:probe:runs`)) === 1);

    child.removeAllListeners('exit');
    child.kill('SIGKILL');
    await once(child, 'exit');

    worker(
      name,
      async () => {
        await probe.incr(`${prefix}:probe:runs`);
      },
      { lockDuration: 1000, stalledInterval: 500, maxStalledCount },
    );
    await sleep(4500);

    const runs = Number(await probe.get(`${prefix}:probe:runs`));
    const failed = await q.getFailed();
    return { runs, failedReasons: failed.map((job) => job.failedReason) };
  }

  it('maxStalledCount 0: the crashed worker\'s job is NOT re-run, and is failed as stalled (no duplicate send)', async () => {
    const { runs, failedReasons } = await crashScenario(0);
    expect(runs).toBe(1);
    expect(failedReasons.join(' ')).toMatch(/stalled/i);
  }, 30_000);

  it('CONTROL: with BullMQ\'s default (maxStalledCount 1) the same crash DOES re-run the job, which would send twice', async () => {
    const { runs } = await crashScenario(1);
    expect(runs).toBe(2);
  }, 30_000);
});
