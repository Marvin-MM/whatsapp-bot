import { Queue, Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv } from '@/lib/env';
import { ANALYSIS_REQUEUE_MAX_AGE_MS, ANALYSIS_STALE_MS, scanSends } from '@/lib/ops/alerts-scan';
import { toJobId } from '@/lib/queue/enqueue';
import { FIXTURE } from '../helpers/fixtures';
import { HOUR, NOW, count, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';
import { createTestRedis } from '../helpers/redis';

const h = setupIngestHarness();
const sql = () => h.admin();

let analysisQueue: Queue;
let sendQueue: Queue;
let draftQueue: Queue;
beforeAll(() => {
  analysisQueue = new Queue('post-send-analysis', { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
  sendQueue = new Queue('outbound-send', { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
  draftQueue = new Queue('generate-draft', { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
});
afterAll(async () => {
  for (const queue of [analysisQueue, sendQueue, draftQueue]) {
    await queue.obliterate({ force: true });
    await queue.close();
  }
});
beforeEach(async () => {
  for (const queue of [analysisQueue, sendQueue, draftQueue]) await queue.obliterate({ force: true });
});
afterEach(() => vi.unstubAllGlobals());

const MIN = 60 * 1000;
const scan = (now = NOW) => scanSends({ now, queue: sendQueue, draftQueue, analysisQueue });
const alerts = (kind: string) => count(sql(), 'notifications', `kind = 'alert:${kind}'`);

async function conversation(): Promise<string> {
  await sql()`INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET ai_paused = false`;
  const contact = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}`, bsuid: FIXTURE.amina.bsuid, name: 'Amina' });
  return seedConversation(sql(), contact, { status: 'waiting_on_customer' });
}
async function task(conv: string, o: { dueAt?: Date | null; status?: string } = {}): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    INSERT INTO tasks (id, conversation_id, description, type, status, due_at, created_by) VALUES (gen_random_uuid(), ${conv}, 'Call Amina', 'followup', ${o.status ?? 'open'}, ${o.dueAt ?? null}, 'ai') RETURNING id`;
  if (!row) throw new Error('task failed');
  return row.id;
}
const stamped = async (id: string) => (await sql()<{ alerted_overdue_at: Date | null }[]>`SELECT alerted_overdue_at FROM tasks WHERE id = ${id}`)[0]?.alerted_overdue_at ?? null;

describe('overdue-task alerts', () => {
  it('a task past its time is alerted ONCE: the second scan, and every later one, says nothing', async () => {
    const conv = await conversation();
    const id = await task(conv, { dueAt: new Date(NOW.getTime() - 30 * MIN) });
    expect((await scan()).tasksOverdue).toBe(1);
    expect(await alerts('task_overdue')).toBe(1);
    expect(await stamped(id)).toBeInstanceOf(Date);
    expect((await scan(new Date(NOW.getTime() + 5 * MIN))).tasksOverdue).toBe(0);
    expect((await scan(new Date(NOW.getTime() + 10 * HOUR))).tasksOverdue).toBe(0);
    expect(await alerts('task_overdue')).toBe(1);
  });

  it('only OPEN tasks that have a time that has PASSED are alerted', async () => {
    const conv = await conversation();
    await task(conv, { dueAt: new Date(NOW.getTime() + MIN) }); // not yet
    await task(conv); // no time
    await task(conv, { dueAt: new Date(NOW.getTime() - HOUR), status: 'done' });
    await task(conv, { dueAt: new Date(NOW.getTime() - HOUR), status: 'cancelled' });
    expect((await scan()).tasksOverdue).toBe(0);
    expect(await alerts('task_overdue')).toBe(0);
  });

  it('several late tasks are each alerted once (one alert per task, not one for the lot)', async () => {
    const conv = await conversation();
    await task(conv, { dueAt: new Date(NOW.getTime() - HOUR) });
    await task(conv, { dueAt: new Date(NOW.getTime() - 2 * HOUR) });
    await task(conv, { dueAt: new Date(NOW.getTime() - 3 * HOUR) });
    expect((await scan()).tasksOverdue).toBe(3);
    expect(await alerts('task_overdue')).toBe(3);
    expect((await scan()).tasksOverdue).toBe(0);
  });

  it('moving the time (which clears the stamp) lets the task alert again when it is late AGAIN, but not for the old time', async () => {
    const conv = await conversation();
    const id = await task(conv, { dueAt: new Date(NOW.getTime() - HOUR) });
    await scan();
    expect(await alerts('task_overdue')).toBe(1);
    // The owner moves it to later today (the stamp is cleared by the update) ...
    await sql()`UPDATE tasks SET due_at = ${new Date(NOW.getTime() + 2 * HOUR)}, alerted_overdue_at = NULL WHERE id = ${id}`;
    expect((await scan()).tasksOverdue).toBe(0);
    // ... and it is late again.
    expect((await scan(new Date(NOW.getTime() + 3 * HOUR))).tasksOverdue).toBe(1);
    expect(await alerts('task_overdue')).toBe(2);
    // A stamp that was lost (crash between the alert and the stamp) re-raises the SAME alert, which deduplication swallows.
    await sql()`UPDATE tasks SET alerted_overdue_at = NULL WHERE id = ${id}`;
    await scan(new Date(NOW.getTime() + 4 * HOUR));
    expect(await alerts('task_overdue')).toBe(2);
    expect(await stamped(id)).toBeInstanceOf(Date);
  });
});

describe('a lost analysis job', () => {
  async function reply(conv: string, o: { status?: string; provenance?: string; minutesAgo?: number } = {}): Promise<string> {
    const id = await seedMessage(sql(), conv, { direction: 'outbound', content: 'Sure', status: o.status ?? 'sent', provenance: o.provenance ?? 'owner_manual', occurredAt: new Date(NOW.getTime() - (o.minutesAgo ?? 30) * MIN) });
    await sql()`UPDATE messages SET created_at = ${new Date(NOW.getTime() - (o.minutesAgo ?? 30) * MIN)} WHERE id = ${id}`;
    return id;
  }
  const jobs = () => analysisQueue.getJobs(['waiting', 'delayed', 'prioritized', 'active']);

  it('an accepted reply the summary never covered is analysed once more, and only once', async () => {
    const conv = await conversation();
    const id = await reply(conv);
    const first = await scan();
    expect(first.analysesRequeued).toBe(1);
    expect((await jobs()).map((job) => ({ id: job.id, data: job.data }))).toEqual([{ id: toJobId(`analysis:${id}`), data: { messageId: id } }]);
    // The job is waiting: not lost, so nothing more happens ...
    expect((await scan()).analysesRequeued).toBe(0);
    // ... and even once it has finished without covering the message, it is not retried forever.
    const job = await analysisQueue.getJob(toJobId(`analysis:${id}`));
    await job?.remove();
    expect((await scan()).analysesRequeued).toBe(0);
    expect(await jobs()).toHaveLength(0);
  });

  it('a job that is still WAITING is not lost: it is left alone and the once-only claim is not spent on it', async () => {
    const conv = await conversation();
    const id = await reply(conv);
    await analysisQueue.add('analyze', { messageId: id }, { jobId: toJobId(`analysis:${id}`) });
    expect((await scan()).analysesRequeued).toBe(0);
    expect(await count(sql(), 'notifications', `kind = 'analysis_requeue'`)).toBe(0);
  });

  it('a FINISHED job for the message is removed first (BullMQ ignores an add for an id it still holds), so the retry really runs', async () => {
    const conv = await conversation();
    const id = await reply(conv);
    // A job that finished (it ran, but the summary still does not cover the message: e.g. it was skipped while AI was paused).
    const worker = new Worker('post-send-analysis', async () => 'done', { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
    const finished = new Promise<void>((resolve) => worker.once('completed', () => resolve()));
    await analysisQueue.add('analyze', { messageId: id }, { jobId: toJobId(`analysis:${id}`) });
    await finished;
    await worker.close();
    expect(await (await analysisQueue.getJob(toJobId(`analysis:${id}`)))?.getState()).toBe('completed');

    expect((await scan()).analysesRequeued).toBe(1);
    expect(await (await analysisQueue.getJob(toJobId(`analysis:${id}`)))?.getState()).toBe('waiting');
  });

  it('is left alone when it is recent, more than a day old, covered, imported, not accepted, or AI is paused', async () => {
    const conv = await conversation();
    await reply(conv, { minutesAgo: ANALYSIS_STALE_MS / MIN - 3 }); // too recent: the job is probably still on its way
    await reply(conv, { status: 'queued' });
    await reply(conv, { status: 'failed' });
    await reply(conv, { provenance: 'imported' });
    await reply(conv, { minutesAgo: ANALYSIS_REQUEUE_MAX_AGE_MS / MIN + 60 }); // a day and an hour old: history, not a lost job
    expect((await scan()).analysesRequeued).toBe(0);

    const covered = await reply(conv, { minutesAgo: 20 });
    await sql()`UPDATE conversations SET summary_through_message_id = ${covered} WHERE id = ${conv}`;
    expect((await scan()).analysesRequeued).toBe(0);

    const newer = await reply(conv, { minutesAgo: 15 });
    await sql()`UPDATE settings SET ai_paused = true`;
    expect((await scan()).analysesRequeued).toBe(0);
    await sql()`UPDATE settings SET ai_paused = false`;
    expect((await scan()).analysesRequeued).toBe(1);
    expect((await jobs()).map((job) => job.data)).toEqual([{ messageId: newer }]);
  });

  it('one job per conversation (its newest uncovered reply), not one per message', async () => {
    const conv = await conversation();
    await reply(conv, { minutesAgo: 50 });
    await reply(conv, { minutesAgo: 40 });
    const newest = await reply(conv, { minutesAgo: 30 });
    expect((await scan()).analysesRequeued).toBe(1);
    expect((await jobs()).map((job) => job.data)).toEqual([{ messageId: newest }]);
  });
});
