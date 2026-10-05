import 'server-only';
import { sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';

export interface ResponseTime {
  /** Median seconds from a customer's message to the owner's first reply; null when there were none to measure. */
  medianSeconds: number | null;
  /** How many conversations' first messages that median is over. */
  samples: number;
}

/**
 * Median first-response time over the last `days` days. A "first message" is a customer message that starts a new turn (the one before it
 * in that conversation was the owner's, or there was none); its response is the owner's next reply that Meta accepted (a reply typed on
 * the phone counts: it is a reply). Imported history, failed sends, reactions and customer-deleted messages are not measured. It includes
 * nights and weekends on purpose: the customer waited that long. A median, so one slow Sunday does not move it.
 */
export async function medianResponseTime(db: Db, now: Date, days = 7): Promise<ResponseTime> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db.execute<{ median: number | null; n: number }>(sql`
    WITH seq AS (
      SELECT id, conversation_id, direction, occurred_at,
             lag(direction) OVER (PARTITION BY conversation_id ORDER BY occurred_at, id) AS prev_direction
      FROM messages
      WHERE type <> 'reaction' AND provenance <> 'imported' AND status <> 'failed' AND deleted_at IS NULL
    ), firsts AS (
      SELECT id, conversation_id, occurred_at FROM seq
      WHERE direction = 'inbound' AND (prev_direction IS NULL OR prev_direction = 'outbound') AND occurred_at > ${since}::timestamptz
    ), answered AS (
      SELECT f.occurred_at AS asked_at,
             (SELECT min(o.occurred_at) FROM messages o
              WHERE o.conversation_id = f.conversation_id AND o.direction = 'outbound' AND o.status <> 'failed' AND o.provenance <> 'imported'
                AND o.type <> 'reaction' AND o.occurred_at > f.occurred_at) AS replied_at
      FROM firsts f
    )
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM replied_at - asked_at)) AS median, count(*)::int AS n
    FROM answered WHERE replied_at IS NOT NULL
  `);
  const row = rows[0];
  const n = row?.n ?? 0;
  return { medianSeconds: n === 0 || row?.median === null || row?.median === undefined ? null : Number(row.median), samples: n };
}

/** "45 s", "12 min", "3 h 20 min", "2 days": short enough for a card. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds - hours * 3600) / 60);
    return minutes === 0 || minutes === 60 ? `${minutes === 60 ? hours + 1 : hours} h` : `${hours} h ${minutes} min`;
  }
  return `${Math.round(seconds / 86400)} days`;
}
