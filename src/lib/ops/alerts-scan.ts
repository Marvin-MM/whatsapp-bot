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
 */

/** A real send is over in 20 s (our abort). Past this a stamp without an answer means the worker is gone. */
export const STAMP_STALE_MS = 3 * 60 * 1000;
/** Queued and never stamped for this long: the worker should have picked it up long ago. */
export const UNSTAMPED_STALE_MS = 5 * 60 * 1000;

export interface ScanResult {
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

export async function scanSends(options: { now?: Date; db?: Db; queue?: Queue } = {}): Promise<ScanResult> {
  const now = options.now ?? new Date();
  const db = options.db ?? getDb();
  const queue = options.queue ?? getQueue('outbound-send');
  const parkedUnknown = await parkStampedAsUnknown(db, now);
  const { requeued, templatesFailed } = await requeueUnstamped(db, queue, now);
  const windowsExpiring = await alertExpiringWindows(db, now);
  if (parkedUnknown + requeued + templatesFailed > 0) logger.warn({ parkedUnknown, requeued, templatesFailed }, 'alerts-scan repaired messages');
  return { parkedUnknown, requeued, templatesFailed, windowsExpiring };
}
