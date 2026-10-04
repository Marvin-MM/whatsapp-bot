import 'server-only';
import { inArray, isNull, and } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { webhookEvents } from '@/lib/db/schema';
import type { SplitItem } from '@/lib/whatsapp/webhook-split';

const INSERT_CHUNK = 200;
const LOOKUP_CHUNK = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Stores every event losslessly (`INSERT ... ON CONFLICT (dedupe_key) DO NOTHING`) and returns the dedupe keys that
 * still need processing: newly inserted rows AND rows from an earlier delivery that were never processed. A replay of
 * an already-processed event returns nothing, so it is not enqueued again.
 */
export async function persistEvents(db: Db, items: readonly SplitItem[]): Promise<string[]> {
  if (items.length === 0) return [];

  await db.transaction(async (tx) => {
    for (const batch of chunks(items, INSERT_CHUNK)) {
      await tx
        .insert(webhookEvents)
        .values(batch.map((item) => ({ dedupeKey: item.dedupeKey, kind: item.kind, payload: item.item })))
        .onConflictDoNothing({ target: webhookEvents.dedupeKey });
    }
  });

  const pending: string[] = [];
  for (const batch of chunks(items, LOOKUP_CHUNK)) {
    const rows = await db
      .select({ dedupeKey: webhookEvents.dedupeKey })
      .from(webhookEvents)
      .where(and(inArray(webhookEvents.dedupeKey, batch.map((item) => item.dedupeKey)), isNull(webhookEvents.processedAt)));
    for (const row of rows) pending.push(row.dedupeKey);
  }
  return pending;
}

/** Stores a signed payload we could not parse so nothing Meta sent is ever lost; returns its key. */
export async function persistRaw(db: Db, dedupeKey: string, kind: string, payload: unknown): Promise<void> {
  await db
    .insert(webhookEvents)
    .values({ dedupeKey, kind, payload })
    .onConflictDoNothing({ target: webhookEvents.dedupeKey });
}
