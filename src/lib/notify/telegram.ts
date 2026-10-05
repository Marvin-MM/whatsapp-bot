import 'server-only';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AlertInput } from '@/lib/alerts';
import { getDb } from '@/lib/db';
import { settings } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { alertText } from './alert-copy';
import { isQuietNow, quietHoursSchema } from './quiet-hours';

/**
 * Telegram notifications (spec 11): SEND-ONLY here (the inbound bot webhook for Cancel / Send now arrives with the autopilot).
 *
 * Rules that hold for every message: plain text only (no parse_mode, so nothing in a name or an error can become markup); never a
 * customer message body (an alert carries a kind and an id, nothing else); the bot token is only ever in the request URL and is
 * never logged; and NOTHING here may break the work that raised the notification, so every failure is a returned value, not a throw.
 */

const SEND_TIMEOUT_MS = 10_000;
/** Telegram answers 429 with how long to wait. Waiting a few seconds once is reasonable; waiting minutes inside a job is not. */
const MAX_RETRY_AFTER_S = 5;
const MAX_TEXT = 4096;

export type TelegramResult =
  | { ok: true; messageId: string }
  | { ok: false; reason: 'rate_limited' | 'rejected' | 'network' | 'unreadable'; detail: string };

const responseSchema = z.looseObject({
  ok: z.boolean(),
  result: z.looseObject({ message_id: z.number() }).optional(),
  error_code: z.number().optional(),
  description: z.string().optional(),
  parameters: z.looseObject({ retry_after: z.number().optional() }).optional(),
});

async function post(text: string): Promise<{ status: number; body: z.infer<typeof responseSchema> | null }> {
  const env = getEnv();
  const response = await globalThis.fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, MAX_TEXT), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  const parsed = responseSchema.safeParse(json);
  return { status: response.status, body: parsed.success ? parsed.data : null };
}

/** Sends one plain-text message to the owner's chat. Never throws. Retries once when Telegram says to wait a few seconds. */
export async function sendTelegramMessage(text: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<TelegramResult> {
  try {
    let attempt = await post(text);
    if (attempt.status === 429) {
      const wait = attempt.body?.parameters?.retry_after ?? 1;
      if (wait > MAX_RETRY_AFTER_S) return { ok: false, reason: 'rate_limited', detail: `Telegram asked us to wait ${wait}s.` };
      await sleep(wait * 1000);
      attempt = await post(text);
    }
    if (attempt.body === null) return { ok: false, reason: 'unreadable', detail: `Telegram answered HTTP ${attempt.status} with something we could not read.` };
    if (attempt.body.ok && attempt.body.result) return { ok: true, messageId: String(attempt.body.result.message_id) };
    if (attempt.status === 429) return { ok: false, reason: 'rate_limited', detail: 'Telegram is still rate-limiting us.' };
    return { ok: false, reason: 'rejected', detail: `Telegram refused it (${attempt.body.error_code ?? attempt.status}): ${attempt.body.description ?? 'no reason given'}` };
  } catch (error) {
    return { ok: false, reason: 'network', detail: `Could not reach Telegram (${error instanceof Error ? error.name : 'error'}).` };
  }
}

/**
 * The alert sink (registered with `registerAlertSink` in the worker). Delivery rules: the owner's `notify_telegram` switch;
 * quiet hours silence everything except critical alerts (the dashboard still shows all of them); failures are logged, never thrown.
 */
export async function telegramAlertSink(alert: AlertInput, now: Date = new Date()): Promise<void> {
  try {
    const [row] = await getDb().select({ notify: settings.notifyTelegram, quiet: settings.quietHours }).from(settings).where(eq(settings.id, 1)).limit(1);
    if (row && !row.notify) return;
    // `info` alerts (a repair that worked, an account reconnected) are for the dashboard, not for a buzz in the owner's pocket.
    if (alert.severity === 'info') return;
    // The setting is JSON in the database: anything unreadable means "no quiet hours" (deliver), never "swallow".
    const quiet = quietHoursSchema.safeParse(row?.quiet);
    if (alert.severity !== 'critical' && quiet.success && isQuietNow(now, quiet.data, getEnv().OWNER_TIMEZONE)) return;
    const result = await sendTelegramMessage(alertText(alert, `${getEnv().APP_URL}/settings`));
    if (!result.ok) logger.warn({ alert: alert.kind, reason: result.reason }, 'telegram alert not delivered');
  } catch (error) {
    logger.warn({ alert: alert.kind, error: error instanceof Error ? error.name : 'unknown' }, 'telegram alert sink failed');
  }
}
