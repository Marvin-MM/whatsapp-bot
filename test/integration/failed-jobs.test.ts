import { Queue, Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv } from '@/lib/env';
import { listFailedJobs, retryVerdict } from '@/lib/ops/failed-jobs';
import { type QueueName } from '@/lib/queue/names';
import { getDb } from '@/lib/db';
import { createEnrolledOwner, headersWith } from '../helpers/auth';
import { FIXTURE } from '../helpers/fixtures';
import { seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';
import { createTestRedis } from '../helpers/redis';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));
const { dismissJob, retryJob } = await import('@/actions/jobs');

const h = setupIngestHarness();
const sql = () => h.admin();

const NAMES: QueueName[] = ['download-media', 'outbound-send', 'generate-draft', 'post-send-analysis'];
const queues = new Map<QueueName, Queue>();
beforeAll(() => {
  for (const name of NAMES) queues.set(name, new Queue(name, { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX }));
});
afterAll(async () => {
  for (const queue of queues.values()) {
    await queue.obliterate({ force: true });
    await queue.close();
  }
});
beforeEach(async () => {
  for (const queue of queues.values()) await queue.obliterate({ force: true });
  requestHeaders.current = new Headers();
});
afterEach(() => vi.unstubAllGlobals());

const queue = (name: QueueName) => {
  const found = queues.get(name);
  if (!found) throw new Error('no queue');
  return found;
};

/** A job that really fails: a worker throws once (one attempt), so BullMQ puts it in the failed set exactly as in production. */
async function failedJob(name: QueueName, jobId: string, data: Record<string, unknown>, reason = 'boom'): Promise<void> {
  const worker = new Worker(
    name,
    async () => {
      throw new Error(reason);
    },
    { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX },
  );
  const failed = new Promise<void>((resolve) => worker.once('failed', () => resolve()));
  await queue(name).add('job', data, { jobId, attempts: 1 });
  await failed;
  await worker.close();
}
const state = async (name: QueueName, id: string) => (await queue(name).getJob(id))?.getState();

async function message(status: string, o: { stamped?: boolean; wamid?: string | null } = {}): Promise<string> {
  const contact = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}`, bsuid: FIXTURE.amina.bsuid, name: 'Amina' });
  const conv = await seedConversation(sql(), contact, { status: 'waiting_on_customer' });
  const id = await seedMessage(sql(), conv, { direction: 'outbound', status, content: 'SECRET BODY', wamid: o.wamid ?? null });
  if (o.stamped) await sql()`UPDATE messages SET send_started_at = now() WHERE id = ${id}`;
  return id;
}
const audit = () => sql()<{ action: string; entity_id: string; metadata: Record<string, unknown> }[]>`SELECT action, entity_id, metadata FROM audit_log WHERE action LIKE 'job.%' ORDER BY created_at`;
const UUID = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

describe('listing', () => {
  it('shows failed jobs from every queue, newest first, with the error in its own (shortened) words and only ids from the data', async () => {
    await failedJob('download-media', 'media-1', { messageId: UUID, content: 'SECRET BODY', phone: '+256700123456' }, 'first failure');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await failedJob('generate-draft', 'draft-1', { conversationId: UUID, waits: 2 }, `line one\n\n   line   two ${'x'.repeat(400)}`);
    const jobs = await listFailedJobs({ db: getDb() });

    expect(jobs.map((j) => `${j.queue}/${j.id}`)).toEqual(['generate-draft/draft-1', 'download-media/media-1']);
    expect(jobs[0]?.error.startsWith('line one line two')).toBe(true);
    expect(jobs[0]?.error.length).toBeLessThanOrEqual(200);
    expect(jobs[0]?.subject).toEqual([{ label: 'Conversation', value: UUID }]);
    expect(jobs[1]).toMatchObject({ error: 'first failure', attemptsMade: 1, retry: { allowed: true }, subject: [{ label: 'Message', value: UUID }] });
    // nothing of the job's data beyond the ids is ever returned
    expect(JSON.stringify(jobs)).not.toContain('SECRET');
    expect(JSON.stringify(jobs)).not.toContain('256700123456');
    expect(jobs[0]?.failedAt).toBeInstanceOf(Date);
  });

  it('is empty when nothing failed', async () => {
    expect(await listFailedJobs({ db: getDb() })).toEqual([]);
  });
});

describe('what may be retried', () => {
  const verdict = (data: unknown) => retryVerdict(getDb(), 'outbound-send', data);

  it('an outbound-send is retryable ONLY when nothing could have reached the customer: queued and never stamped', async () => {
    expect(await verdict({ messageId: await message('queued') })).toEqual({ allowed: true });
  });

  it.each([
    ['unknown', {}, /check your phone/i],
    ['queued', { stamped: true }, /already started/i],
    ['failed', {}, /send it again from the conversation/i],
    ['sent', { wamid: 'wamid.X' }, /already sent/i],
    ['delivered', { wamid: 'wamid.Y' }, /already sent/i],
    ['read', { wamid: 'wamid.Z' }, /already sent/i],
  ])('an outbound-send for a %s message is refused, with the reason', async (status, over, reason) => {
    const result = await verdict({ messageId: await message(status, over) });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(reason);
  });

  it('refuses a job without a message, for a message that no longer exists, and any autopilot send', async () => {
    const noMessage = await verdict({});
    expect(noMessage.allowed).toBe(false);
    if (!noMessage.allowed) expect(noMessage.reason).toMatch(/names no message/);
    expect((await verdict({ messageId: UUID })).allowed).toBe(false);
    const autopilot = await retryVerdict(getDb(), 'autopilot-send', { messageId: await message('queued') });
    expect(autopilot.allowed).toBe(false);
    if (!autopilot.allowed) expect(autopilot.reason).toMatch(/automatic reply/);
  });

  it('every other queue is idempotent and may run again', async () => {
    for (const name of ['download-media', 'generate-draft', 'post-send-analysis', 'process-webhook-event', 'style-extract', 'scheduled'] as const) {
      expect(await retryVerdict(getDb(), name, { anything: 1 })).toEqual({ allowed: true });
    }
  });
});

describe('the actions', () => {
  async function signedIn(): Promise<void> {
    requestHeaders.current = headersWith((await createEnrolledOwner()).cookie);
  }

  it('are owner-only and validate their input', async () => {
    await failedJob('download-media', 'media-1', { messageId: UUID });
    expect(await retryJob({ queue: 'download-media', jobId: 'media-1' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(await dismissJob({ queue: 'download-media', jobId: 'media-1' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(await state('download-media', 'media-1')).toBe('failed');
    await signedIn();
    expect(await retryJob({ queue: 'not-a-queue', jobId: 'x' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await retryJob({ queue: 'download-media', jobId: '' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await retryJob({ queue: 'download-media' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('retry puts the job back in its queue and audits the ids only; a second click is refused', async () => {
    await signedIn();
    await failedJob('download-media', 'media-1', { messageId: UUID, content: 'SECRET BODY' });
    expect(await retryJob({ queue: 'download-media', jobId: 'media-1' })).toMatchObject({ ok: true });
    expect(await state('download-media', 'media-1')).toBe('waiting');
    expect(await audit()).toEqual([{ action: 'job.retry', entity_id: 'download-media/media-1', metadata: { queue: 'download-media' } }]);
    expect(JSON.stringify(await audit())).not.toContain('SECRET');
    expect(await retryJob({ queue: 'download-media', jobId: 'media-1' })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'not_failed' } });
    expect((await audit()).length).toBe(1);
  });

  it('refuses to retry a send that may have reached the customer: the job stays failed and nothing is audited', async () => {
    await signedIn();
    const id = await message('unknown');
    await failedJob('outbound-send', 'send-1', { messageId: id });
    expect(await retryJob({ queue: 'outbound-send', jobId: 'send-1' })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'blocked' } });
    expect(await state('outbound-send', 'send-1')).toBe('failed');
    expect(await audit()).toEqual([]);
    // ... but it can be dismissed (the record, not the message)
    expect(await dismissJob({ queue: 'outbound-send', jobId: 'send-1' })).toMatchObject({ ok: true });
    expect(await queue('outbound-send').getJob('send-1')).toBeUndefined();
    expect((await audit()).map((e) => e.action)).toEqual(['job.dismiss']);
  });

  it('retries a send that was never stamped', async () => {
    await signedIn();
    const id = await message('queued');
    await failedJob('outbound-send', 'send-2', { messageId: id });
    expect(await retryJob({ queue: 'outbound-send', jobId: 'send-2' })).toMatchObject({ ok: true });
    expect(await state('outbound-send', 'send-2')).toBe('waiting');
  });

  it('a job that is not there is refused, not a crash', async () => {
    await signedIn();
    expect(await retryJob({ queue: 'generate-draft', jobId: 'nope' })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'not_found' } });
    expect(await dismissJob({ queue: 'generate-draft', jobId: 'nope' })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'not_found' } });
  });

  it('a job that is waiting (not failed) cannot be "retried" or dismissed from this list', async () => {
    await signedIn();
    await queue('generate-draft').add('draft', { conversationId: UUID }, { jobId: 'waiting-1' });
    expect(await retryJob({ queue: 'generate-draft', jobId: 'waiting-1' })).toMatchObject({ ok: false, error: { reason: 'not_failed' } });
    expect(await dismissJob({ queue: 'generate-draft', jobId: 'waiting-1' })).toMatchObject({ ok: false, error: { reason: 'not_failed' } });
    expect(await state('generate-draft', 'waiting-1')).toBe('waiting');
  });
});

