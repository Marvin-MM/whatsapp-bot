import { Queue } from 'bullmq';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeProducerConnection } from '@/lib/queue/connection';
import { closeQueues } from '@/lib/queue/queues';
import { toJobId } from '@/lib/queue/enqueue';
import { WEBHOOK_MAX_BODY_BYTES } from '@/lib/whatsapp/body';
import { type IntakeDeps, handleWebhookPost, handleWebhookVerify } from '@/lib/whatsapp/webhook-intake';
import { closeAllDb, migratorSql, resetDb } from '../helpers/db';
import { fixtureBytes } from '../helpers/fixtures';
import { cleanupPrefix, createTestRedis, uniquePrefix } from '../helpers/redis';
import { appSecret, fixtureRequest, signedRequest, verifyRequest, verifyToken } from '../helpers/webhook';

// Isolate queue keys for this file before anything reads the env.
const prefix = uniquePrefix();
process.env.BULLMQ_PREFIX = prefix;

let admin: Sql;
let queue: Queue;
const redis = createTestRedis();

beforeAll(() => {
  admin = migratorSql();
  queue = new Queue('process-webhook-event', { connection: createTestRedis(), prefix });
});

beforeEach(async () => {
  await resetDb(admin);
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue.close();
  await closeQueues();
  await closeProducerConnection();
  await cleanupPrefix(redis, prefix);
  await redis.quit();
  await closeAllDb();
});

const rowCount = async () => (await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM webhook_events`)[0]?.n ?? -1;
const jobCount = async () => {
  const counts = await queue.getJobCounts('waiting', 'delayed', 'active', 'failed', 'completed');
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
};

describe('GET handshake', () => {
  it('echoes the challenge as text/plain for a correct token', async () => {
    const response = handleWebhookVerify(verifyRequest({ 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken(), 'hub.challenge': '1158201444' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('1158201444');
  });

  it.each([
    ['wrong token', { 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' }],
    ['wrong mode', { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '1' }],
    ['missing token', { 'hub.mode': 'subscribe', 'hub.challenge': '1' }],
    ['missing challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token' }],
    ['token with different length', { 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token-extra', 'hub.challenge': '1' }],
    ['no params at all', {}],
  ])('rejects with 403: %s', (_label, params) => {
    expect(handleWebhookVerify(verifyRequest(params)).status).toBe(403);
  });
});

describe('POST: authenticity comes first', () => {
  it('rejects a bad signature with 401, never calls storage or the queue, and writes nothing', async () => {
    const deps: IntakeDeps = { persist: vi.fn(async () => []), enqueue: vi.fn(async () => undefined) };
    const response = await handleWebhookPost(fixtureRequest('text-message', { secret: 'the-wrong-secret' }), deps);
    expect(response.status).toBe(401);
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(await rowCount()).toBe(0);
    expect(await jobCount()).toBe(0);
  });

  it.each([
    ['missing header', null],
    ['wrong length', 'sha256=abcd'],
    ['not hex', `sha256=${'g'.repeat(64)}`],
    ['no sha256= prefix', 'a'.repeat(64)],
  ])('answers 401 without throwing and writes nothing: %s', async (_label, signature) => {
    const response = await handleWebhookPost(fixtureRequest('text-message', { signature }));
    expect(response.status).toBe(401);
    expect(await rowCount()).toBe(0);
  });

  it('401s when the signature was computed over a re-serialised copy of the body', async () => {
    const raw = fixtureBytes('text-message');
    const pretty = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(raw)), null, 2));
    const response = await handleWebhookPost(signedRequest(raw, { signature: `sha256=${(await import('node:crypto')).createHmac('sha256', appSecret()).update(pretty).digest('hex')}` }));
    expect(response.status).toBe(401);
    expect(await rowCount()).toBe(0);
  });

  it('413s an oversized body by Content-Length without storing anything', async () => {
    const response = await handleWebhookPost(
      new Request('http://localhost/api/webhooks/whatsapp', {
        method: 'POST',
        headers: { 'content-length': String(WEBHOOK_MAX_BODY_BYTES + 1) },
        body: new Uint8Array(10),
      }),
    );
    expect(response.status).toBe(413);
    expect(await rowCount()).toBe(0);
  });

  it('413s an oversized body even when no Content-Length is declared', async () => {
    const big = new Uint8Array(WEBHOOK_MAX_BODY_BYTES + 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const response = await handleWebhookPost(
      new Request('http://localhost/api/webhooks/whatsapp', { method: 'POST', body: stream, duplex: 'half' } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(await rowCount()).toBe(0);
  });

  it('accepts a large valid payload just under the cap (a history chunk must not be lost to a 413)', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: {}, messages: [{ id: 'wamid.BIG', type: 'text', text: { body: 'x'.repeat(2_600_000) } }] } }] }],
    });
    expect(body.length).toBeLessThan(WEBHOOK_MAX_BODY_BYTES);
    const response = await handleWebhookPost(signedRequest(body));
    expect(response.status).toBe(200);
    expect(await rowCount()).toBe(1);
  });

  it('400s a signed body that is not JSON, storing nothing', async () => {
    const response = await handleWebhookPost(signedRequest('this is not json'));
    expect(response.status).toBe(400);
    expect(await rowCount()).toBe(0);
  });
});

describe('POST: storing and enqueueing', () => {
  it('stores a verified message as an unprocessed event and enqueues exactly one job for it', async () => {
    const response = await handleWebhookPost(fixtureRequest('text-message'));
    expect(response.status).toBe(200);

    const rows = await admin<{ dedupe_key: string; kind: string; processed_at: Date | null; payload: { message: { id: string } } }[]>`
      SELECT dedupe_key, kind, processed_at, payload FROM webhook_events`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dedupe_key: 'msg:wamid.IN.TEXT.1', kind: 'message', processed_at: null });
    expect(rows[0]?.payload.message.id).toBe('wamid.IN.TEXT.1');

    expect(await jobCount()).toBe(1);
    const job = await queue.getJob(toJobId('msg:wamid.IN.TEXT.1'));
    expect(job?.data).toEqual({ dedupeKey: 'msg:wamid.IN.TEXT.1' });
  });

  it('stores EVERY item of a batched, multi-entry payload', async () => {
    expect((await handleWebhookPost(fixtureRequest('batch-multi'))).status).toBe(200);
    const keys = (await admin<{ dedupe_key: string }[]>`SELECT dedupe_key FROM webhook_events ORDER BY dedupe_key`).map((row) => row.dedupe_key);
    expect(keys).toEqual([
      'msg:wamid.BATCH.1',
      'msg:wamid.BATCH.2',
      'msg:wamid.BATCH.3',
      'msg:wamid.BATCH.4',
      'status:wamid.OUT.BATCH.1:delivered',
    ]);
    expect(await jobCount()).toBe(5);
  });

  it('is idempotent: replaying a payload creates no duplicate rows or jobs', async () => {
    await handleWebhookPost(fixtureRequest('batch-multi'));
    await handleWebhookPost(fixtureRequest('batch-multi'));
    await handleWebhookPost(fixtureRequest('batch-multi'));
    expect(await rowCount()).toBe(5);
    expect(await jobCount()).toBe(5);
  });

  it('re-enqueues an event from an earlier delivery that was stored but never processed', async () => {
    await handleWebhookPost(fixtureRequest('text-message'));
    await queue.obliterate({ force: true }); // the job is lost (e.g. Redis was flushed); the row is still unprocessed
    await handleWebhookPost(fixtureRequest('text-message'));
    expect(await jobCount()).toBe(1);
  });

  it('does NOT re-enqueue an event that was already processed', async () => {
    await handleWebhookPost(fixtureRequest('text-message'));
    await admin`UPDATE webhook_events SET processed_at = now()`;
    await queue.obliterate({ force: true });
    expect((await handleWebhookPost(fixtureRequest('text-message'))).status).toBe(200);
    expect(await jobCount()).toBe(0);
    expect(await rowCount()).toBe(1);
  });

  it('answers 200 and stores nothing for a payload meant for another Meta product', async () => {
    const response = await handleWebhookPost(fixtureRequest('other-object-page'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ignored: true });
    expect(await rowCount()).toBe(0);
  });

  it('answers 200 for an empty entry list without storing anything', async () => {
    expect((await handleWebhookPost(fixtureRequest('malformed-empty-entry'))).status).toBe(200);
    expect(await rowCount()).toBe(0);
  });

  it('keeps a signed payload with an unparseable shape as an `other` event, answers 200 (no 36 h of useless retries)', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: 'not-an-array' });
    const response = await handleWebhookPost(signedRequest(body));
    expect(response.status).toBe(200);
    const rows = await admin<{ kind: string; payload: { parseError: boolean; field: string } }[]>`SELECT kind, payload FROM webhook_events`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('other');
    expect(rows[0]?.payload).toMatchObject({ field: 'envelope', parseError: true });
    expect(await jobCount()).toBe(1);
  });

  it('parks an unknown field and a malformed value as events instead of dropping them', async () => {
    await handleWebhookPost(fixtureRequest('unknown-field'));
    await handleWebhookPost(fixtureRequest('malformed-messages-value'));
    const rows = await admin<{ kind: string }[]>`SELECT kind FROM webhook_events`;
    expect(rows.map((row) => row.kind)).toEqual(['other', 'other']);
  });

  it('keeps events for other phone numbers (the processor decides to ignore them; ingest stays lossless)', async () => {
    expect((await handleWebhookPost(fixtureRequest('foreign-phone-number'))).status).toBe(200);
    expect(await rowCount()).toBe(1);
  });
});

describe('POST: failures must make Meta retry, and lose nothing', () => {
  it('answers 500 when storage fails', async () => {
    const response = await handleWebhookPost(fixtureRequest('text-message'), {
      persist: async () => {
        throw new Error('database is down');
      },
      enqueue: async () => undefined,
    });
    expect(response.status).toBe(500);
  });

  it('answers 500 when Redis is down, but the event is already stored for the sweeper', async () => {
    const { persistEvents } = await import('@/lib/ingest/persist');
    const { getDb } = await import('@/lib/db');
    const response = await handleWebhookPost(fixtureRequest('batch-multi'), {
      persist: (items) => persistEvents(getDb(), items),
      enqueue: async () => {
        throw new Error('redis unreachable');
      },
    });
    expect(response.status).toBe(500);
    expect(await rowCount()).toBe(5);
    expect((await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM webhook_events WHERE processed_at IS NULL`)[0]?.n).toBe(5);
    expect(await jobCount()).toBe(0);
  });

  it('then the sweeper picks the stored events up (end to end: webhook 500 -> sweep -> jobs)', async () => {
    const { persistEvents } = await import('@/lib/ingest/persist');
    const { getDb } = await import('@/lib/db');
    const { sweepWebhookEvents } = await import('@/lib/ingest/sweep');
    await handleWebhookPost(fixtureRequest('batch-multi'), {
      persist: (items) => persistEvents(getDb(), items),
      enqueue: async () => {
        throw new Error('redis unreachable');
      },
    });
    await admin`UPDATE webhook_events SET received_at = now() - interval '5 minutes'`;
    const result = await sweepWebhookEvents({ queue });
    expect(result).toEqual({ reenqueued: 5, skipped: 0, exhausted: 0 });
    expect(await jobCount()).toBe(5);
  });
});
