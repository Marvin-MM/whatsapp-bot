import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { notifications, settings } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { isQuietNow, quietHoursSchema } from '@/lib/notify/quiet-hours';
import { sendTelegramMessage } from '@/lib/notify/telegram';
import { ROUTE_REASONS, ROUTE_REASON_TEXT, type RouteReason } from './policy';

/**
 * The daily `autopilot-digest` (spec 10.3), 20:00 in the owner's time zone: what the autopilot did in the last 24 hours, in one Telegram message with a
 * link. Sent only when there is something to say (it ran, or it is switched on): an autopilot that is off and silent does not text anyone every evening.
 * Quiet hours and the owner's Telegram switch apply (the digest is never urgent). Plain words, counts and reasons: never a message.
 */

export interface Digest {
  sent: number;
  cancelled: number;
  routed: number;
  silent: number;
  demoted: number;
  markedBad: number;
  topReasons: Array<{ reason: string; count: number }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP = 3;

export async function buildDigest(db: Db, now: Date): Promise<Digest> {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const until = now.toISOString();
  const [counts] = await db.execute<{ sent: number; cancelled: number; routed: number; silent: number; demoted: number; marked_bad: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM messages WHERE direction = 'outbound' AND provenance = 'ai_autopilot' AND status <> 'failed' AND occurred_at >= ${since}::timestamptz AND occurred_at <= ${until}::timestamptz) AS sent,
      (SELECT count(*)::int FROM audit_log WHERE action = 'autopilot.cancel' AND created_at >= ${since}::timestamptz AND created_at <= ${until}::timestamptz) AS cancelled,
      (SELECT count(*)::int FROM drafts WHERE (autopilot_decision->>'eligible')::boolean = false AND autopilot_decision->'reasons' <> '["no_reply_needed"]'::jsonb AND created_at >= ${since}::timestamptz AND created_at <= ${until}::timestamptz) AS routed,
      (SELECT count(*)::int FROM drafts WHERE autopilot_decision->'reasons' = '["no_reply_needed"]'::jsonb AND created_at >= ${since}::timestamptz AND created_at <= ${until}::timestamptz) AS silent,
      (SELECT count(*)::int FROM audit_log WHERE action = 'autopilot.demote' AND created_at >= ${since}::timestamptz AND created_at <= ${until}::timestamptz) AS demoted,
      (SELECT count(*)::int FROM messages WHERE marked_bad_at >= ${since}::timestamptz AND marked_bad_at <= ${until}::timestamptz) AS marked_bad`);
  const reasons = await db.execute<{ reason: string; n: number }>(sql`
    SELECT reason, count(*)::int AS n
    FROM drafts, jsonb_array_elements_text(autopilot_decision->'reasons') AS reason
    WHERE (autopilot_decision->>'eligible')::boolean = false AND reason <> 'no_reply_needed' AND created_at >= ${since}::timestamptz AND created_at <= ${until}::timestamptz
    GROUP BY reason ORDER BY n DESC, reason LIMIT ${TOP}`);
  return {
    sent: counts?.sent ?? 0,
    cancelled: counts?.cancelled ?? 0,
    routed: counts?.routed ?? 0,
    silent: counts?.silent ?? 0,
    demoted: counts?.demoted ?? 0,
    markedBad: counts?.marked_bad ?? 0,
    topReasons: reasons.map((row) => ({ reason: row.reason, count: row.n })),
  };
}

const KNOWN = new Set<string>(ROUTE_REASONS);
const reasonText = (reason: string) => (KNOWN.has(reason) ? ROUTE_REASON_TEXT[reason as RouteReason] : reason.replaceAll('_', ' '));

export function digestActive(digest: Digest): boolean {
  return digest.sent + digest.cancelled + digest.routed + digest.silent + digest.demoted + digest.markedBad > 0;
}

export function digestText(digest: Digest, link: string): string {
  const lines = [
    '🤖 Autopilot, last 24 hours',
    `Sent automatically: ${digest.sent}`,
    `Cancelled by you: ${digest.cancelled}`,
    `Handed to your approval instead: ${digest.routed}`,
  ];
  if (digest.silent > 0) lines.push(`"Thanks"/"ok" left unanswered: ${digest.silent}`);
  if (digest.demoted > 0) lines.push(`Conversations taken off autopilot: ${digest.demoted}`);
  if (digest.markedBad > 0) lines.push(`Replies you marked bad: ${digest.markedBad}`);
  if (digest.topReasons.length > 0) lines.push(`Why they came to you: ${digest.topReasons.map((item) => `${reasonText(item.reason)} (${item.count})`).join('; ')}`);
  lines.push(link);
  return lines.join('\n');
}

/** One local calendar day: the digest is sent at most once for it (a scheduler that fires twice must not text twice). */
const dayKey = (now: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export async function sendAutopilotDigest(db: Db, now: Date = new Date()): Promise<'sent' | 'silent' | 'skipped' | 'failed'> {
  try {
    const env = getEnv();
    const [setting] = await db.select({ notify: settings.notifyTelegram, quiet: settings.quietHours, paused: settings.autopilotPaused }).from(settings).where(eq(settings.id, 1)).limit(1);
    if (setting && !setting.notify) return 'skipped';
    const quiet = quietHoursSchema.safeParse(setting?.quiet);
    if (quiet.success && isQuietNow(now, quiet.data, env.OWNER_TIMEZONE)) return 'skipped';

    const digest = await buildDigest(db, now);
    // Off and nothing happened: nothing to say.
    if ((setting?.paused ?? true) && !digestActive(digest)) return 'silent';

    const key = `autopilot_digest:${dayKey(now, env.OWNER_TIMEZONE)}`;
    const claimed = await db.insert(notifications).values({ kind: 'autopilot_digest', dedupeKey: key }).onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id: notifications.id });
    if (claimed.length === 0) return 'skipped';

    const result = await sendTelegramMessage(digestText(digest, `${env.APP_URL.replace(/\/$/, '')}/settings/autopilot`));
    if (!result.ok) {
      await db.delete(notifications).where(and(eq(notifications.dedupeKey, key)));
      logger.warn({ reason: result.reason }, 'autopilot digest not delivered');
      return 'failed';
    }
    await db.update(notifications).set({ telegramMessageId: result.messageId }).where(eq(notifications.dedupeKey, key));
    return 'sent';
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.name : 'unknown' }, 'autopilot digest failed');
    return 'failed';
  }
}
