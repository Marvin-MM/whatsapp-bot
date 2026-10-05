import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';

/** Raw webhook payloads hold customer message content: the privacy text promises they are kept 30 days (CLAUDE.md, spec 11). */
export const PAYLOAD_RETENTION_DAYS = 30;
const BATCH = 2000;

/**
 * Nulls the payload of PROCESSED events older than the retention period. The row stays (its `dedupe_key` is what recognises a
 * Meta replay); only the content goes. An UNPROCESSED event keeps its payload however old: the sweeper still needs it to retry.
 * Batched, so a large first run never holds one long lock. Returns how many payloads were purged.
 */
export async function purgeOldPayloads(now: Date = new Date(), retentionDays: number = PAYLOAD_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const db = getDb();
  let total = 0;
  for (;;) {
    const rows = await db.execute<{ id: string }>(sql`
      UPDATE webhook_events SET payload = NULL
      WHERE id IN (
        SELECT id FROM webhook_events
        WHERE payload IS NOT NULL AND processed_at IS NOT NULL AND received_at < ${cutoff}::timestamptz
        LIMIT ${BATCH}
      )
      RETURNING id
    `);
    total += rows.length;
    if (rows.length < BATCH) return total;
  }
}
