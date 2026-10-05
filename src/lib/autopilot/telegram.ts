import 'server-only';
import { eq } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { contacts, conversations, drafts, notifications, settings } from '@/lib/db/schema';
import { logger } from '@/lib/logger';
import { retireTelegramMessage, sendTelegramButtons } from '@/lib/notify/telegram';
import { callbackData, retiredText, scheduledText, telegramName } from './copy';
import { removeAutopilotJob } from './jobs';

/**
 * The owner's phone and the autopilot countdown (spec 10.3): ONE Telegram message per scheduled draft, with Cancel and Send now; when the draft's
 * fate is settled (sent, cancelled, replaced, handled by the owner) that same message is rewritten without its buttons so a stale tap cannot happen.
 *
 * Every function here is best effort and never throws: a missing buzz must not undo a scheduled send, and a failed edit must not undo a cancel.
 * The dashboard offers the same two controls, so a muted or broken Telegram never leaves the owner without a way to stop a send.
 */

const scheduledKey = (draftId: string) => `autopilot_scheduled:${draftId}`;
const retiredKey = (draftId: string) => `autopilot_retired:${draftId}`;

async function loadDraftForMessage(db: Db, draftId: string) {
  const [row] = await db
    .select({ content: drafts.content, contact: { displayName: contacts.displayName, username: contacts.username, phoneE164: contacts.phoneE164, bsuid: contacts.bsuid } })
    .from(drafts)
    .innerJoin(conversations, eq(conversations.id, drafts.conversationId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(drafts.id, draftId))
    .limit(1);
  return row;
}

/** After the draft was scheduled: tell the owner what is about to be sent. Idempotent (one message per draft). */
export async function notifyAutopilotScheduled(db: Db, input: { draftId: string; delaySeconds: number }): Promise<'sent' | 'skipped' | 'failed'> {
  try {
    const [setting] = await db.select({ notify: settings.notifyTelegram }).from(settings).where(eq(settings.id, 1)).limit(1);
    if (setting && !setting.notify) return 'skipped';
    const row = await loadDraftForMessage(db, input.draftId);
    if (!row) return 'skipped';

    const claimed = await db.insert(notifications).values({ kind: 'autopilot_scheduled', dedupeKey: scheduledKey(input.draftId) }).onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id: notifications.id });
    if (claimed.length === 0) return 'skipped';

    const text = scheduledText({ name: telegramName(row.contact), reply: row.content, delaySeconds: input.delaySeconds });
    const result = await sendTelegramButtons(text, [[
      { text: 'Cancel', callbackData: callbackData('cancel', input.draftId) },
      { text: 'Send now', callbackData: callbackData('send', input.draftId) },
    ]]);
    if (!result.ok) {
      await db.delete(notifications).where(eq(notifications.dedupeKey, scheduledKey(input.draftId)));
      logger.warn({ reason: result.reason }, 'autopilot message not delivered');
      return 'failed';
    }
    await db.update(notifications).set({ telegramMessageId: result.messageId }).where(eq(notifications.dedupeKey, scheduledKey(input.draftId)));
    return 'sent';
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.name : 'unknown' }, 'autopilot notification failed');
    return 'failed';
  }
}

/**
 * The draft's countdown is over, one way or another: remove its job and rewrite its Telegram message (without buttons) saying how it ended.
 * Safe to call any number of times, for any draft (one that was never scheduled has no job and no message, and nothing happens).
 */
export async function retireAutopilotDraft(db: Db, draftId: string, note: string): Promise<void> {
  try {
    // Never end a LIVE countdown: a draft that is still `scheduled` is waiting for its job. (Every caller retires after the draft left that state;
    // this is the guard for the day one gets it wrong, found by a repeated "Send now" tap that used to delete the job it had just promoted.)
    const [current] = await db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, draftId)).limit(1);
    if (current?.status === 'scheduled') return;
    await removeAutopilotJob(draftId);
    const [scheduled] = await db.select({ messageId: notifications.telegramMessageId }).from(notifications).where(eq(notifications.dedupeKey, scheduledKey(draftId))).limit(1);
    if (!scheduled?.messageId) return;
    // Whoever claims this key edits the message; every later caller finds it taken.
    const claimed = await db.insert(notifications).values({ kind: 'autopilot_retired', dedupeKey: retiredKey(draftId) }).onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id: notifications.id });
    if (claimed.length === 0) return;
    const row = await loadDraftForMessage(db, draftId);
    const text = row ? retiredText({ name: telegramName(row.contact), reply: row.content, note }) : `🤖 ${note}`;
    await retireTelegramMessage(scheduled.messageId, text);
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.name : 'unknown' }, 'autopilot message not retired');
  }
}
