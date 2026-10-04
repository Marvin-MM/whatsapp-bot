import { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { closeProducerConnection } from '@/lib/queue/connection';
import { closeQueues } from '@/lib/queue/queues';
import { handleWebhookPost } from '@/lib/whatsapp/webhook-intake';
import { type WorkerRuntime, startWorkers } from '../../worker/runtime';
import { processWebhookEventProcessor } from '../../worker/processors/process-webhook-event';
import { closeAllDb, migratorSql, resetDb } from '../helpers/db';
import { FIXTURE } from '../helpers/fixtures';
import { count, seedContact, seedConversation, seedMessage } from '../helpers/ingest';
import { cleanupPrefix, createTestRedis, uniquePrefix } from '../helpers/redis';
import { fixtureRequest } from '../helpers/webhook';

// The whole path, with nothing mocked: Meta's POST -> signature -> persist -> BullMQ -> a real worker -> the database.
const prefix = uniquePrefix();
process.env.BULLMQ_PREFIX = prefix;

let admin: Sql;
let runtime: WorkerRuntime;
let queue: Queue;
const redis = createTestRedis();

beforeAll(async () => {
  admin = migratorSql();
  runtime = await startWorkers([{ queue: 'process-webhook-event', processor: processWebhookEventProcessor }]);
  queue = new Queue('process-webhook-event', { connection: createTestRedis(), prefix });
});

beforeEach(async () => {
  await resetDb(admin);
  // BullMQ ignores an add whose job id it still retains (completed jobs are kept for a day): a truncated database with a
  // stale job would silently never process the "same" event again. Production never deletes webhook_events rows.
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue.close();
  await runtime.stop();
  await closeQueues();
  await closeProducerConnection();
  await cleanupPrefix(redis, prefix);
  await redis.quit();
  await closeAllDb();
});

async function until(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

const unprocessed = () => count(admin, 'webhook_events', 'processed_at IS NULL');

describe('webhook POST -> queue -> worker -> database', () => {
  it('a signed message is stored, processed by the worker, and the event is settled', async () => {
    const response = await handleWebhookPost(fixtureRequest('text-message'));
    expect(response.status).toBe(200);

    await until(async () => (await count(admin, 'messages')) === 1 && (await unprocessed()) === 0);
    const [message] = await admin<Array<{ content: string; direction: string }>>`SELECT content, direction FROM messages`;
    expect(message).toMatchObject({ direction: 'inbound', content: 'Hello, do you have the blue dress in size M?' });
  });

  it('processes every item of a batched POST; the status for a message we never stored keeps retrying instead of being dropped or alerted', async () => {
    expect((await handleWebhookPost(fixtureRequest('batch-multi'))).status).toBe(200);

    await until(async () => (await count(admin, 'messages')) === 4);
    // Everything else is settled; the one status (its message is not in our database) is waiting for a retry.
    await until(async () => (await unprocessed()) === 1);
    const [waiting] = await admin<Array<{ kind: string; last_error: string }>>`SELECT kind, last_error FROM webhook_events WHERE processed_at IS NULL`;
    expect(waiting).toMatchObject({ kind: 'status', last_error: 'status_for_unknown_message' });
    expect(await count(admin, 'notifications')).toBe(0);
  });

  it('a status that arrives BEFORE its message is retried by BullMQ and applied once the message exists', async () => {
    expect((await handleWebhookPost(fixtureRequest('status-delivered'))).status).toBe(200);
    // The first attempt finds no message and asks to be retried; the row stays unprocessed.
    await until(async () => {
      const [row] = await admin<Array<{ last_error: string | null; processed_at: Date | null }>>`SELECT last_error, processed_at FROM webhook_events`;
      return row?.last_error === 'status_for_unknown_message' && row.processed_at === null;
    });

    // The send path commits the message row a moment later (here: seeded). The next attempt applies the status.
    const contact = await seedContact(admin, { bsuid: FIXTURE.amina.bsuid, phone: `+${FIXTURE.amina.wa}` });
    const conversation = await seedConversation(admin, contact, { status: 'waiting_on_customer' });
    await seedMessage(admin, conversation, { direction: 'outbound', wamid: 'wamid.OUT.TEXT.1', status: 'sent' });

    await until(async () => (await admin<Array<{ status: string }>>`SELECT status FROM messages WHERE wamid = 'wamid.OUT.TEXT.1'`)[0]?.status === 'delivered');
    await until(async () => (await unprocessed()) === 0);
  });

  it('a replayed POST (Meta retries) is acknowledged and changes nothing', async () => {
    await handleWebhookPost(fixtureRequest('text-message'));
    await until(async () => (await unprocessed()) === 0 && (await count(admin, 'messages')) === 1);

    expect((await handleWebhookPost(fixtureRequest('text-message'))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await count(admin, 'messages')).toBe(1);
    expect(await count(admin, 'webhook_events')).toBe(1);
  });
});
