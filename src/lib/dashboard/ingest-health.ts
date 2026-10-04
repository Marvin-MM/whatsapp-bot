import 'server-only';
import { count, desc, eq, like, max, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { messages, notifications, webhookEvents } from '@/lib/db/schema';

export interface IngestHealth {
  /** When Meta last reached us at all. Null: never (the webhook is not connected yet). */
  lastReceivedAt: Date | null;
  received24h: number;
  /** Stored but not yet processed. A few seconds' worth is normal; a growing number means the worker is not running. */
  unprocessed: number;
  /** Unprocessed for more than ten minutes: something is wrong, and the sweeper has already tried. */
  stuck: number;
  /** Events we settled without acting on, with the reason (foreign number, unparseable, group message, ...). */
  settledWithNote24h: number;
  history: {
    /** Chunks received from the Coexistence history sync. */
    chunks: number;
    lastChunkAt: Date | null;
    /** Messages the owner sent (from the phone) that were imported to learn their style from. */
    ownerMessagesImported: number;
    errors: number;
  };
  alerts: Array<{ kind: string; at: Date }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STUCK_MS = 10 * 60 * 1000;

/** Everything the Settings page needs to answer "is WhatsApp actually connected and flowing?". Read-only. */
export async function getIngestHealth(db: Db, now: Date = new Date()): Promise<IngestHealth> {
  // ISO strings with an explicit cast: a raw Date inside a sql fragment is not serialised by the driver.
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const stuckBefore = new Date(now.getTime() - STUCK_MS).toISOString();

  const [events] = await db
    .select({
      last: max(webhookEvents.receivedAt),
      received24h: count(sql`CASE WHEN ${webhookEvents.receivedAt} > ${since}::timestamptz THEN 1 END`),
      unprocessed: count(sql`CASE WHEN ${webhookEvents.processedAt} IS NULL THEN 1 END`),
      stuck: count(sql`CASE WHEN ${webhookEvents.processedAt} IS NULL AND ${webhookEvents.receivedAt} < ${stuckBefore}::timestamptz THEN 1 END`),
      settledWithNote: count(sql`CASE WHEN ${webhookEvents.processedAt} > ${since}::timestamptz AND ${webhookEvents.lastError} IS NOT NULL THEN 1 END`),
    })
    .from(webhookEvents);

  const [history] = await db
    .select({
      chunks: count(sql`CASE WHEN ${webhookEvents.dedupeKey} NOT LIKE 'history-error:%' THEN 1 END`),
      errors: count(sql`CASE WHEN ${webhookEvents.dedupeKey} LIKE 'history-error:%' THEN 1 END`),
      last: max(webhookEvents.receivedAt),
    })
    .from(webhookEvents)
    .where(eq(webhookEvents.kind, 'history'));

  const [imported] = await db.select({ n: count() }).from(messages).where(eq(messages.provenance, 'imported'));

  const alerts = await db
    .select({ kind: notifications.kind, at: notifications.sentAt })
    .from(notifications)
    .where(like(notifications.kind, 'alert:%'))
    .orderBy(desc(notifications.sentAt))
    .limit(8);

  return {
    lastReceivedAt: events?.last ?? null,
    received24h: events?.received24h ?? 0,
    unprocessed: events?.unprocessed ?? 0,
    stuck: events?.stuck ?? 0,
    settledWithNote24h: events?.settledWithNote ?? 0,
    history: { chunks: history?.chunks ?? 0, lastChunkAt: history?.last ?? null, ownerMessagesImported: imported?.n ?? 0, errors: history?.errors ?? 0 },
    alerts: alerts.map((row) => ({ kind: row.kind.replace(/^alert:/, ''), at: row.at })),
  };
}
