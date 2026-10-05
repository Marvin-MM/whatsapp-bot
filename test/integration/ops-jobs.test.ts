import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv } from '@/lib/env';
import { scanSends } from '@/lib/ops/alerts-scan';
import { purgeOldPayloads } from '@/lib/ops/purge-payloads';
import { checkTokenHealth, readTokenHealth } from '@/lib/ops/token-health';
import { toJobId } from '@/lib/queue/enqueue';
import { FIXTURE } from '../helpers/fixtures';
import { HOUR, NOW, count, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';
import { jsonResponse, stubNetwork } from '../helpers/network';
import { createTestRedis } from '../helpers/redis';

const h = setupIngestHarness();
const sql = () => h.admin();
const redis = createTestRedis();

let sendQueue: Queue;
beforeAll(() => {
  sendQueue = new Queue('outbound-send', { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
});
afterAll(async () => {
  await sendQueue.obliterate({ force: true });
  await sendQueue.close();
  await redis.quit();
});
beforeEach(async () => {
  await sendQueue.obliterate({ force: true });
  await redis.del(`${getEnv().BULLMQ_PREFIX}:token-health`);
});
afterEach(() => vi.unstubAllGlobals());

const alerts = (kind: string) => count(sql(), 'notifications', `kind = 'alert:${kind}'`);
const MIN = 60 * 1000;

async function seedConv(): Promise<{ conversationId: string }> {
  const contactId = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}`, bsuid: FIXTURE.amina.bsuid });
  return { conversationId: await seedConversation(sql(), contactId, { status: 'waiting_on_me' }) };
}

async function seedQueued(conversationId: string, o: { stampedMinutesAgo?: number | null; createdMinutesAgo?: number; wamid?: string | null; type?: 'text' | 'template' } = {}): Promise<string> {
  const id = await seedMessage(sql(), conversationId, { direction: 'outbound', status: 'queued', wamid: o.wamid ?? null, type: o.type ?? 'text', content: 'hello', occurredAt: NOW });
  await sql()`UPDATE messages SET
      send_started_at = ${o.stampedMinutesAgo == null ? null : new Date(NOW.getTime() - o.stampedMinutesAgo * MIN)},
      created_at = ${new Date(NOW.getTime() - (o.createdMinutesAgo ?? 0) * MIN)}
    WHERE id = ${id}`;
  return id;
}
const status = async (id: string) => (await sql()<{ status: string; error: { code: string | null } | null }[]>`SELECT status, error FROM messages WHERE id = ${id}`)[0];

describe('alerts-scan: a stamp that was never answered', () => {
  it('parks it as `unknown` (never resends) and alerts, once', async () => {
    const { conversationId } = await seedConv();
    const stale = await seedQueued(conversationId, { stampedMinutesAgo: 10 });
    const result = await scanSends({ now: NOW, queue: sendQueue });

    expect(result.parkedUnknown).toBe(1);
    expect((await status(stale))?.status).toBe('unknown');
    expect(await alerts('message_unknown')).toBe(1);
    expect(await sendQueue.getJobs(['waiting', 'delayed'])).toHaveLength(0);

    await scanSends({ now: NOW, queue: sendQueue });
    expect(await alerts('message_unknown')).toBe(1);
  });

  it('leaves a send that is still in flight, one that has its wamid, and a row another worker is finishing', async () => {
    const { conversationId } = await seedConv();
    const inFlight = await seedQueued(conversationId, { stampedMinutesAgo: 1 });
    const answered = await seedQueued(conversationId, { stampedMinutesAgo: 10, wamid: 'wamid.X' });
    const locked = await seedQueued(conversationId, { stampedMinutesAgo: 10 });

    // Another transaction holds the row, as a worker finishing its send does.
    const holder = new Promise<void>((release) => {
      void sql().begin(async (tx) => {
        await tx`SELECT 1 FROM messages WHERE id = ${locked} FOR UPDATE`;
        await new Promise<void>((done) => setTimeout(done, 600));
        release();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = await scanSends({ now: NOW, queue: sendQueue });
    await holder;

    expect(result.parkedUnknown).toBe(0);
    for (const id of [inFlight, answered, locked]) expect((await status(id))?.status).toBe('queued');
  });
});

describe('alerts-scan: a queued message whose job was lost', () => {
  it('re-enqueues a text message that was never stamped, and tells the dashboard', async () => {
    const { conversationId } = await seedConv();
    const lost = await seedQueued(conversationId, { createdMinutesAgo: 10 });
    const result = await scanSends({ now: NOW, queue: sendQueue });

    expect(result.requeued).toBe(1);
    const jobs = await sendQueue.getJobs(['waiting', 'delayed']);
    expect(jobs.map((job) => job.id)).toEqual([toJobId(`send:${lost}`)]);
    expect(jobs[0]?.data).toEqual({ messageId: lost });
    expect(await alerts('message_requeued')).toBe(1);
  });

  it('does not touch a young message, a message whose job is waiting, or one that is already stamped', async () => {
    const { conversationId } = await seedConv();
    const young = await seedQueued(conversationId, { createdMinutesAgo: 1 });
    const waiting = await seedQueued(conversationId, { createdMinutesAgo: 10 });
    await sendQueue.add('send', { messageId: waiting }, { jobId: toJobId(`send:${waiting}`) });
    const stamped = await seedQueued(conversationId, { createdMinutesAgo: 10, stampedMinutesAgo: 0.5 });

    const result = await scanSends({ now: NOW, queue: sendQueue });
    expect(result.requeued).toBe(0);
    expect((await sendQueue.getJobs(['waiting'])).map((job) => job.id)).toEqual([toJobId(`send:${waiting}`)]);
    for (const id of [young, waiting, stamped]) expect((await status(id))?.status).toBe('queued');
  });

  it('re-adds a job that FAILED before the stamp, keeping its data (a template keeps its components)', async () => {
    const { conversationId } = await seedConv();
    const id = await seedQueued(conversationId, { createdMinutesAgo: 10, type: 'template' });
    const data = { messageId: id, template: { name: 'order_ready', language: 'en', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Amina' }] }] } };
    await sendQueue.add('send', data, { jobId: toJobId(`send:${id}`) });

    // Make it fail the way a pre-stamp crash does.
    const worker = new Worker('outbound-send', async () => Promise.reject(new UnrecoverableError('boom')), { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
    await new Promise<void>((resolve) => worker.on('failed', () => resolve()));
    await worker.close();
    expect(await sendQueue.getJobs(['failed'])).toHaveLength(1);

    const result = await scanSends({ now: NOW, queue: sendQueue });
    expect(result.requeued).toBe(1);
    const [job] = await sendQueue.getJobs(['waiting']);
    expect(job?.data).toEqual(data);
    expect(await sendQueue.getJobs(['failed'])).toHaveLength(0);
  });

  it('a TEMPLATE whose job is gone fails visibly: its values are not stored, so they are never guessed', async () => {
    const { conversationId } = await seedConv();
    const id = await seedQueued(conversationId, { createdMinutesAgo: 10, type: 'template' });
    const result = await scanSends({ now: NOW, queue: sendQueue });

    expect(result.templatesFailed).toBe(1);
    expect(await status(id)).toMatchObject({ status: 'failed', error: { code: 'template_job_lost' } });
    expect(await sendQueue.getJobs(['waiting', 'delayed'])).toHaveLength(0);
  });
});

describe('alerts-scan: windows about to close', () => {
  async function seedWaiting(expiresInMinutes: number, o: { replied?: boolean; status?: 'waiting_on_me' | 'resolved' } = {}): Promise<string> {
    const contactId = await seedContact(sql(), { phone: `+2567${Math.floor(Math.random() * 1e8)}` });
    const conversationId = await seedConversation(sql(), contactId, { status: o.status ?? 'waiting_on_me' });
    const inboundAt = new Date(NOW.getTime() + expiresInMinutes * MIN - 24 * HOUR);
    await seedMessage(sql(), conversationId, { direction: 'inbound', wamid: `wamid.${conversationId}`, occurredAt: inboundAt });
    if (o.replied) await seedMessage(sql(), conversationId, { direction: 'outbound', status: 'sent', wamid: `wamid.out.${conversationId}`, occurredAt: new Date(inboundAt.getTime() + 5 * MIN) });
    await sql()`UPDATE conversations SET last_inbound_at = ${inboundAt}, window_expires_at = ${new Date(inboundAt.getTime() + 24 * HOUR)} WHERE id = ${conversationId}`;
    return conversationId;
  }

  it('alerts once per window for a customer still waiting, and only those', async () => {
    const closing = await seedWaiting(90);
    await seedWaiting(300); // closes in 5h: not yet
    await seedWaiting(-30); // already closed
    await seedWaiting(60, { replied: true }); // the owner already answered
    await seedWaiting(60, { status: 'resolved' });

    expect((await scanSends({ now: NOW, queue: sendQueue })).windowsExpiring).toBe(1);
    expect(await alerts('window_expiring')).toBe(1);
    await scanSends({ now: NOW, queue: sendQueue });
    expect(await alerts('window_expiring')).toBe(1);
    const [alert] = await sql()<{ dedupe_key: string }[]>`SELECT dedupe_key FROM notifications WHERE kind = 'alert:window_expiring'`;
    expect(alert?.dedupe_key).toContain(closing);
  });

  it('a NEW window (the customer wrote again) can alert again', async () => {
    const id = await seedWaiting(90);
    await scanSends({ now: NOW, queue: sendQueue });
    const later = new Date(NOW.getTime() + 20 * HOUR);
    // The customer writes again 23h30m before `later`... i.e. a fresh window that closes 30 minutes after `later`.
    const wroteAt = new Date(later.getTime() + 30 * MIN - 24 * HOUR);
    await seedMessage(sql(), id, { direction: 'inbound', wamid: 'wamid.again', occurredAt: wroteAt });
    await sql()`UPDATE conversations SET last_inbound_at = ${wroteAt}, window_expires_at = ${new Date(wroteAt.getTime() + 24 * HOUR)} WHERE id = ${id}`;
    await scanSends({ now: later, queue: sendQueue });
    expect(await alerts('window_expiring')).toBe(2);
  });
});

describe('purge-payloads', () => {
  const insert = (key: string, o: { ageDays: number; processed: boolean }) =>
    sql()`INSERT INTO webhook_events (id, dedupe_key, kind, payload, received_at, processed_at)
          VALUES (gen_random_uuid(), ${key}, 'message', ${sql().json({ secret: 'customer text' })},
                  ${new Date(NOW.getTime() - o.ageDays * 24 * HOUR)}, ${o.processed ? new Date(NOW.getTime() - o.ageDays * 24 * HOUR) : null})`;

  it('nulls the payload of processed events older than 30 days and keeps the row for dedupe', async () => {
    await insert('old-processed', { ageDays: 31, processed: true });
    await insert('recent-processed', { ageDays: 29, processed: true });
    await insert('old-unprocessed', { ageDays: 90, processed: false });

    expect(await purgeOldPayloads(NOW)).toBe(1);
    const rows = await sql()<{ dedupe_key: string; payload: unknown }[]>`SELECT dedupe_key, payload FROM webhook_events ORDER BY dedupe_key`;
    expect(rows).toEqual([
      { dedupe_key: 'old-processed', payload: null },
      { dedupe_key: 'old-unprocessed', payload: { secret: 'customer text' } },
      { dedupe_key: 'recent-processed', payload: { secret: 'customer text' } },
    ]);
    expect(await purgeOldPayloads(NOW)).toBe(0);
  });

  it('works through more than one batch', async () => {
    await sql()`INSERT INTO webhook_events (id, dedupe_key, kind, payload, received_at, processed_at)
                SELECT gen_random_uuid(), 'bulk-' || g, 'message', '{"x":1}'::jsonb, ${new Date(NOW.getTime() - 60 * 24 * HOUR)}, ${new Date(NOW.getTime() - 60 * 24 * HOUR)}
                FROM generate_series(1, 4500) g`;
    expect(await purgeOldPayloads(NOW)).toBe(4500);
    expect(await count(sql(), 'webhook_events', 'payload IS NOT NULL')).toBe(0);
    expect(await count(sql(), 'webhook_events')).toBe(4500);
  });
});

describe('token-health', () => {
  it('a valid token is recorded with the number’s quality and raises nothing', async () => {
    const net = stubNetwork({ graphInfo: () => jsonResponse({ id: '100000000000001', quality_rating: 'GREEN', verified_name: 'agent_47' }) });
    const health = await checkTokenHealth(NOW);
    expect(health).toMatchObject({ status: 'valid', quality: 'GREEN', verifiedName: 'agent_47' });
    expect(net.graph).toEqual(['100000000000001']);
    expect(await readTokenHealth()).toEqual(health);
    expect(await count(sql(), 'notifications')).toBe(0);
  });

  it.each([
    ['HTTP 401', () => jsonResponse({ error: { code: 190, message: 'Invalid OAuth access token' } }, 401)],
    ['code 190 in a 400', () => jsonResponse({ error: { code: 190 } }, 400)],
    ['a permission error (200)', () => jsonResponse({ error: { code: 200 } }, 403)],
  ])('%s means INVALID: a critical alert, once a day', async (_name, route) => {
    stubNetwork({ graphInfo: route });
    expect((await checkTokenHealth(NOW)).status).toBe('invalid');
    expect((await checkTokenHealth(NOW)).status).toBe('invalid');
    expect(await alerts('whatsapp_token_invalid')).toBe(1);
    await checkTokenHealth(new Date(NOW.getTime() + 25 * HOUR));
    expect(await alerts('whatsapp_token_invalid')).toBe(2);
  });

  it('an outage is `unreachable`, not "invalid": a warning, never the token-revoked emergency', async () => {
    stubNetwork({ graphInfo: () => jsonResponse({}, 503) });
    expect(await checkTokenHealth(NOW)).toMatchObject({ status: 'unreachable' });
    expect(await alerts('whatsapp_token_invalid')).toBe(0);
    expect(await alerts('token_check_failed')).toBe(1);

    vi.unstubAllGlobals();
    stubNetwork({
      graphInfo: () => {
        throw new TypeError('fetch failed');
      },
    });
    expect((await checkTokenHealth(NOW)).status).toBe('unreachable');
  });

  it('readTokenHealth is null before the first check and ignores a corrupted entry', async () => {
    expect(await readTokenHealth()).toBeNull();
    await redis.set(`${getEnv().BULLMQ_PREFIX}:token-health`, '{"status":"fine"}');
    expect(await readTokenHealth()).toBeNull();
  });
});

describe('the schedule', () => {
  it('registers every job that has a handler, in the owner’s time zone, and nothing without a handler', async () => {
    const { schedulerDefinitions } = await import('../../worker/schedulers');
    const definitions = schedulerDefinitions('Africa/Kampala');
    expect(definitions.map((d) => d.id).sort()).toEqual(['alerts-scan', 'autopilot-digest', 'purge-payloads', 'sweep-webhook-events', 'token-health']);
    expect(definitions.find((d) => d.id === 'autopilot-digest')?.repeat).toEqual({ pattern: '0 20 * * *', tz: 'Africa/Kampala' });
    for (const d of definitions) if ('pattern' in d.repeat) expect(d.repeat.tz).toBe('Africa/Kampala');
  });
});
