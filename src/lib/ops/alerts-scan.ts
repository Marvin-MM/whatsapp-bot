import 'server-only';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { type Db, getDb } from '@/lib/db';
import type { MessageError } from '@/lib/db/schema';
import { type Effect, runEffects } from '@/lib/ingest/effects';
import { logger } from '@/lib/logger';
import { enqueueOn, toJobId } from '@/lib/queue/enqueue';
import { getQueue } from '@/lib/queue/queues';
import { EXPIRING_SOON_MS } from '@/lib/conversations/window';
import { DRAFT_TRIGGER_TYPES, draftJobOptions } from '@/lib/drafts/trigger';
import { transitionMessage } from '@/lib/state/message-machine';

/**
 * The safety net under the send path (every 5 minutes). Three jobs, each repairing something the happy path cannot:
 *
 *  1. A message STAMPED (`send_started_at`) but never answered: the worker died, or the database did, after we may have called
 *     Meta. It becomes `unknown` and the owner is told: never resent automatically.
 *  2. A message queued but NEVER stamped for a while: the job was lost (Redis flushed, the enqueue failed after the commit, a
 *     pre-stamp error). Nothing was sent, so re-enqueueing is safe. A template whose job is gone cannot be rebuilt (its values
 *     are not stored): it fails visibly.
 *  3. A customer waiting on a reply whose 24h window closes within two hours.
 *  4. A customer message nobody drafted for (the draft job was lost: Redis flushed, the enqueue failed after the commit): drafted once more.
 *  5. An open task whose time has passed: the owner is told once (again if they move the time and it passes again).
 *  6. An owner reply the summary never covered (the analysis job was lost): analysed once more.
 */

/** A customer message older than this with no draft covering it is treated as a lost draft job. */
export const DRAFT_STALE_MS = 10 * 60 * 1000;

/** A real send is over in 20 s (our abort). Past this a stamp without an answer means the worker is gone. */
export const STAMP_STALE_MS = 3 * 60 * 1000;
/** Queued and never stamped for this long: the worker should have picked it up long ago. */
export const UNSTAMPED_STALE_MS = 5 * 60 * 1000;

/** An accepted owner reply older than this that the summary does not cover is treated as a lost analysis job ... */
export const ANALYSIS_STALE_MS = 10 * 60 * 1000;
/** ... but only for a day: a lost job is a recent accident, and replaying months of old conversations through the model would invent stale tasks. The next reply's analysis covers anything older. */
export const ANALYSIS_REQUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ScanResult {
  draftsRequeued: number;
  analysesRequeued: number;
  tasksOverdue: number;
  parkedUnknown: number;
  requeued: number;
  templatesFailed: number;
  windowsExpiring: number;
}

const unknownError = (): MessageError => ({
  kind: 'ambiguous',
  code: null,
  message: 'Sending stopped part-way (the worker restarted while sending). The message may or may not have been sent: check your phone, then mark it sent or resend.',
});

async function parkStampedAsUnknown(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STAMP_STALE_MS).toISOString();
  const candidates = await db.execute<{ id: string }>(sql`
    SELECT id FROM messages
    WHERE direction = 'outbound' AND status = 'queued' AND wamid IS NULL AND send_started_at IS NOT NULL AND send_started_at < ${cutoff}::timestamptz
    ORDER BY send_started_at LIMIT 100
  `);
  let parked = 0;
  for (const { id } of candidates) {
    const effects = await db.transaction(async (tx): Promise<Effect[]> => {
      // SKIP LOCKED: a worker finishing this very message holds the row; leave it to them.
      const rows = await tx.execute<{ id: string; status: 'queued'; conversation_id: string }>(sql`
        SELECT id, status, conversation_id FROM messages
        WHERE id = ${id}::uuid AND status = 'queued' AND wamid IS NULL AND send_started_at IS NOT NULL AND send_started_at < ${cutoff}::timestamptz
        FOR UPDATE SKIP LOCKED
      `);
      const row = rows[0];
      if (!row || !transitionMessage('queued', { type: 'ambiguous_error' }).ok) return [];
      await tx.execute(sql`UPDATE messages SET status = 'unknown', error = ${JSON.stringify(unknownError())}::jsonb WHERE id = ${id}::uuid`);
      return [
        { type: 'publish', event: { type: 'message:status', payload: { conversationId: row.conversation_id, messageId: id, status: 'unknown' } } },
        { type: 'alert', alert: { kind: 'message_unknown', severity: 'warning', entityId: id, dedupeKey: `message_unknown:${id}` } },
      ];
    });
    if (effects.length > 0) {
      parked += 1;
      await runEffects(effects);
    }
  }
  return parked;
}

async function requeueUnstamped(db: Db, queue: Queue, now: Date): Promise<{ requeued: number; templatesFailed: number }> {
  const cutoff = new Date(now.getTime() - UNSTAMPED_STALE_MS).toISOString();
  const stuck = await db.execute<{ id: string; type: string; conversation_id: string }>(sql`
    SELECT id, type, conversation_id FROM messages
    WHERE direction = 'outbound' AND status = 'queued' AND wamid IS NULL AND send_started_at IS NULL AND created_at < ${cutoff}::timestamptz
    ORDER BY created_at LIMIT 100
  `);
  let requeued = 0;
  let templatesFailed = 0;
  for (const message of stuck) {
    const jobId = toJobId(`send:${message.id}`);
    const existing = await queue.getJob(jobId);
    let data: unknown = { messageId: message.id };
    if (existing) {
      const state = await existing.getState();
      // Still waiting, running or backing off: the worker has it (or will). Not lost.
      if (state !== 'failed' && state !== 'completed' && state !== 'unknown') continue;
      data = existing.data;
      await existing.remove().catch(() => undefined);
    } else if (message.type === 'template') {
      // The only copy of a template's values was in the job, and the job is gone. Never guess them.
      const failed = await db.execute<{ id: string }>(sql`
        UPDATE messages SET status = 'failed',
          error = ${JSON.stringify({ kind: 'permanent', code: 'template_job_lost', message: 'The template details were lost before sending (the queue was reset). Please send the template again.' } satisfies MessageError)}::jsonb
        WHERE id = ${message.id}::uuid AND status = 'queued' AND send_started_at IS NULL
        RETURNING id
      `);
      if (failed.length > 0) {
        templatesFailed += 1;
        await runEffects([{ type: 'publish', event: { type: 'message:status', payload: { conversationId: message.conversation_id, messageId: message.id, status: 'failed' } } }]);
      }
      continue;
    }
    await enqueueOn(queue, 'send', data, { jobId: `send:${message.id}` });
    requeued += 1;
    await runEffects([{ type: 'alert', alert: { kind: 'message_requeued', severity: 'info', entityId: message.id, dedupeKey: `message_requeued:${message.id}` } }]);
  }
  return { requeued, templatesFailed };
}

async function alertExpiringWindows(db: Db, now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + EXPIRING_SOON_MS).toISOString();
  const rows = await db.execute<{ id: string; expires: string }>(sql`
    SELECT c.id, to_char(c.window_expires_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS') AS expires
    FROM conversations c
    WHERE c.window_expires_at > ${now.toISOString()}::timestamptz AND c.window_expires_at <= ${horizon}::timestamptz
      AND c.status <> 'resolved'
      AND NOT EXISTS (
        SELECT 1 FROM messages o
        WHERE o.conversation_id = c.id AND o.direction = 'outbound' AND o.status <> 'failed' AND o.occurred_at >= c.last_inbound_at
      )
  `);
  // One alert per window: the key carries the expiry, so a later message (a new window) can alert again.
  await runEffects(rows.map((row): Effect => ({ type: 'alert', alert: { kind: 'window_expiring', severity: 'warning', entityId: row.id, dedupeKey: `window_expiring:${row.id}:${row.expires}` } })));
  return rows.length;
}

async function requeueMissingDrafts(db: Db, queue: Queue, now: Date): Promise<number> {
  const types = sql.join(DRAFT_TRIGGER_TYPES.map((type) => sql`${type}`), sql`, `);
  const rows = await db.execute<{ conversation_id: string; message_id: string }>(sql`
    SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.id AS message_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.direction = 'inbound' AND m.provenance = 'customer' AND m.deleted_at IS NULL AND m.type IN (${types})
      AND m.created_at < ${new Date(now.getTime() - DRAFT_STALE_MS).toISOString()}::timestamptz
      AND c.window_expires_at > ${now.toISOString()}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM settings WHERE ai_paused)
      AND m.occurred_at > coalesce((SELECT max(o.occurred_at) FROM messages o WHERE o.conversation_id = m.conversation_id AND o.direction = 'outbound' AND o.status <> 'failed'), '-infinity'::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.conversation_id = m.conversation_id AND m.id = ANY(d.trigger_message_ids) AND d.status IN ('pending','scheduled','failed','approved','edited','rejected'))
    ORDER BY m.conversation_id, m.occurred_at
    LIMIT 20
  `);
  let requeued = 0;
  for (const row of rows) {
    // Once per message: a draft that keeps failing is the failed-draft row's business, not an endless loop of retries.
    const claimed = await db.execute<{ id: string }>(sql`
      INSERT INTO notifications (id, kind, dedupe_key) VALUES (gen_random_uuid(), 'draft_requeue', ${`draft_requeue:${row.message_id}`})
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id
    `);
    if (claimed.length === 0) continue;
    await enqueueOn(queue, 'draft', { conversationId: row.conversation_id }, draftJobOptions(row.conversation_id, 1000));
    requeued += 1;
  }
  return requeued;
}

/**
 * Open tasks past their time, alerted once each. The alert key carries the due time: moving a task's time (which also clears the stamp)
 * gives it a new key, so it is reported again if it is late again. Alert first, stamp second: a crash in between repeats the (deduplicated)
 * alert, never loses it.
 */
async function alertOverdueTasks(db: Db, now: Date): Promise<number> {
  const rows = await db.execute<{ id: string; due: string }>(sql`
    SELECT id, to_char(due_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS') AS due
    FROM tasks
    WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ${now.toISOString()}::timestamptz AND alerted_overdue_at IS NULL
    ORDER BY due_at LIMIT 50
  `);
  for (const row of rows) {
    await runEffects([{ type: 'alert', alert: { kind: 'task_overdue', severity: 'warning', entityId: row.id, dedupeKey: `task_overdue:${row.id}:${row.due}` } }]);
    await db.execute(sql`UPDATE tasks SET alerted_overdue_at = ${now.toISOString()}::timestamptz WHERE id = ${row.id}::uuid AND status = 'open' AND alerted_overdue_at IS NULL`);
  }
  return rows.length;
}

/**
 * The newest accepted owner reply of each conversation that the summary does not yet cover, once the analysis job should long have run.
 * Once per message (a notifications key): an analysis that keeps failing is the failed-job panel's business, not an endless loop.
 */
async function requeueMissingAnalyses(db: Db, queue: Queue, now: Date): Promise<number> {
  const rows = await db.execute<{ message_id: string }>(sql`
    SELECT DISTINCT ON (m.conversation_id) m.id AS message_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.direction = 'outbound' AND m.status IN ('sent', 'delivered', 'read') AND m.provenance <> 'imported' AND m.type <> 'reaction'
      AND m.created_at < ${new Date(now.getTime() - ANALYSIS_STALE_MS).toISOString()}::timestamptz
      AND m.created_at > ${new Date(now.getTime() - ANALYSIS_REQUEUE_MAX_AGE_MS).toISOString()}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM settings WHERE ai_paused)
      AND (
        c.summary_through_message_id IS NULL
        OR (m.occurred_at, m.id) > (
          coalesce((SELECT t.occurred_at FROM messages t WHERE t.id = c.summary_through_message_id), '-infinity'::timestamptz),
          coalesce((SELECT t.id FROM messages t WHERE t.id = c.summary_through_message_id), '00000000-0000-0000-0000-000000000000'::uuid)
        )
      )
    ORDER BY m.conversation_id, m.occurred_at DESC, m.id DESC
    LIMIT 20
  `);
  let requeued = 0;
  for (const row of rows) {
    const jobId = toJobId(`analysis:${row.message_id}`);
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      // Waiting, running or backing off: not lost.
      if (state !== 'failed' && state !== 'completed' && state !== 'unknown') continue;
    }
    const claimed = await db.execute<{ id: string }>(sql`
      INSERT INTO notifications (id, kind, dedupe_key) VALUES (gen_random_uuid(), 'analysis_requeue', ${`analysis_requeue:${row.message_id}`})
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id
    `);
    if (claimed.length === 0) continue;
    // BullMQ ignores an add for an id it still holds: a finished or failed job has to go first.
    if (existing) await existing.remove().catch(() => undefined);
    await enqueueOn(queue, 'analyze', { messageId: row.message_id }, { jobId: `analysis:${row.message_id}` });
    requeued += 1;
  }
  return requeued;
}

export async function scanSends(options: { now?: Date; db?: Db; queue?: Queue; draftQueue?: Queue; analysisQueue?: Queue } = {}): Promise<ScanResult> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDb();
  const queue = options.queue ?? getQueue('outbound-send');
  const draftsRequeued = await requeueMissingDrafts(db, options.draftQueue ?? getQueue('generate-draft'), now);
  const analysesRequeued = await requeueMissingAnalyses(db, options.analysisQueue ?? getQueue('post-send-analysis'), now);
  const parkedUnknown = await parkStampedAsUnknown(db, now);
  const { requeued, templatesFailed } = await requeueUnstamped(db, queue, now);
  const windowsExpiring = await alertExpiringWindows(db, now);
  const tasksOverdue = await alertOverdueTasks(db, now);
  if (parkedUnknown + requeued + templatesFailed + draftsRequeued + analysesRequeued > 0) {
    logger.warn({ parkedUnknown, requeued, templatesFailed, draftsRequeued, analysesRequeued }, 'alerts-scan repaired messages');
  }
  return { draftsRequeued, analysesRequeued, tasksOverdue, parkedUnknown, requeued, templatesFailed, windowsExpiring };
}
