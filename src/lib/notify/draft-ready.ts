import 'server-only';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { drafts, notifications, settings } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { isQuietNow, quietHoursSchema } from './quiet-hours';
import { sendTelegramMessage } from './telegram';

/**
 * "A draft is ready" on the owner's phone (spec phase 2/4): throttled so a busy day is not a buzzing pocket.
 *
 *   - at most ONE notification per conversation per 10 minutes (the unique `notifications.dedupe_key` is the throttle: whoever inserts first sends);
 *   - when MORE than 5 drafts are waiting, individual notices are replaced by one digest per 10 minutes ("7 drafts are waiting");
 *   - quiet hours silence it (the drafts wait in the dashboard); the owner's Telegram switch silences it;
 *   - the text carries no name, no phone number and no message: only a link.
 * It never throws: a missed buzz must not fail the draft that triggered it.
 */

export const THROTTLE_MS = 10 * 60 * 1000;
export const DIGEST_THRESHOLD = 5;

const bucket = (now: Date) => Math.floor(now.getTime() / THROTTLE_MS);

export async function notifyDraftReady(db: Db, input: { conversationId: string; draftId: string; now?: Date }): Promise<'sent' | 'throttled' | 'silenced' | 'failed'> {
  const now = input.now ?? new Date();
  try {
    const [row] = await db.select({ notify: settings.notifyTelegram, quiet: settings.quietHours }).from(settings).where(eq(settings.id, 1)).limit(1);
    if (row && !row.notify) return 'silenced';
    const quiet = quietHoursSchema.safeParse(row?.quiet);
    if (quiet.success && isQuietNow(now, quiet.data, getEnv().OWNER_TIMEZONE)) return 'silenced';

    const [waiting] = await db.select({ n: sql<number>`count(*)::int` }).from(drafts).where(and(inArray(drafts.status, ['pending', 'scheduled']), eq(drafts.noReplyNeeded, false)));
    const pending = waiting?.n ?? 0;
    const digest = pending > DIGEST_THRESHOLD;
    const key = digest ? `draft_digest:${bucket(now)}` : `draft_ready:${input.conversationId}:${bucket(now)}`;

    // The first writer of this key sends; everyone else was throttled.
    const claimed = await db.insert(notifications).values({ kind: digest ? 'draft_digest' : 'draft_ready', dedupeKey: key }).onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id: notifications.id });
    if (claimed.length === 0) return 'throttled';

    const base = getEnv().APP_URL.replace(/\/$/, '');
    const text = digest ? `✉️ ${pending} drafts are waiting for your approval.\n${base}/approvals` : `✉️ A draft reply is ready for your approval.\n${base}/approvals?d=${input.draftId}`;
    const result = await sendTelegramMessage(text);
    if (!result.ok) {
      // Give the slot back: a failed send must not silence the next draft for ten minutes.
      await db.delete(notifications).where(and(eq(notifications.dedupeKey, key), gt(notifications.sentAt, new Date(now.getTime() - THROTTLE_MS))));
      logger.warn({ reason: result.reason }, 'draft-ready notification not delivered');
      return 'failed';
    }
    await db.update(notifications).set({ telegramMessageId: result.messageId }).where(eq(notifications.dedupeKey, key));
    return 'sent';
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.name : 'unknown' }, 'draft-ready notification failed');
    return 'failed';
  }
}
