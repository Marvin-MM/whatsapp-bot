import { closeDb } from '@/lib/db';
import { assertEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { closeProducerConnection } from '@/lib/queue/connection';
import { closeQueues, getQueue } from '@/lib/queue/queues';
import { WORKER_REGISTRATIONS } from './registry';
import { SCHEDULER_DEFINITIONS, registerSchedulers } from './schedulers';
import { startWorkers } from './runtime';

const SHUTDOWN_TIMEOUT_MS = 30_000;

assertEnv();

const runtime = await startWorkers(WORKER_REGISTRATIONS);
await registerSchedulers(getQueue('scheduled'), SCHEDULER_DEFINITIONS);
logger.info({ workers: runtime.workers.length, schedulers: SCHEDULER_DEFINITIONS.length }, 'worker ready');

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down');

  // Active jobs get SHUTDOWN_TIMEOUT_MS to finish; after that we exit non-zero rather than hang forever.
  const forced = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forced.unref();

  try {
    await runtime.stop();
    await closeQueues();
    await closeProducerConnection();
    await closeDb();
    logger.info('worker stopped');
    process.exit(0);
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.name : 'unknown' }, 'error during shutdown');
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
