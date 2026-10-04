// Child process for the stalled-job spike: starts a BullMQ worker whose job counts a "send" and then
// hangs forever, so the parent can SIGKILL it mid-job (simulating a crash after Meta accepted a message).
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

const [prefix, queueName] = process.argv.slice(2);
if (!prefix || !queueName) throw new Error('usage: stall-worker.ts <prefix> <queue>');

const url = process.env.REDIS_URL;
if (!url) throw new Error('REDIS_URL is required');

const connection = new Redis(url, { maxRetriesPerRequest: null });
const counter = new Redis(url, { maxRetriesPerRequest: null });

new Worker(
  queueName,
  async () => {
    await counter.incr(`${prefix}:probe:runs`);
    await new Promise<never>(() => undefined);
  },
  { connection, prefix, lockDuration: 1000, stalledInterval: 500, maxStalledCount: 0 },
);

process.stdout.write('ready\n');
