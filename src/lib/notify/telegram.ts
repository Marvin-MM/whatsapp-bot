import 'server-only';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AlertInput } from '@/lib/alerts';
import { getDb } from '@/lib/db';
import { settings } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { alertPath, alertText } from './alert-copy';
import { isQuietNow, quietHoursSchema } from './quiet-hours';

/**
 * Telegram, outbound (spec 11): alerts and "draft ready" pings, and (autopilot) the one message that carries Cancel / Send now buttons.
 * The inbound half, the bot webhook that receives those taps, is `src/app/api/webhooks/telegram`.
 *
 * Rules that hold for every message: plain text only (no parse_mode, so nothing in a name or an error can become markup); never a
 * customer message body (an alert carries a kind and an id, nothing else; the single exception is the autopilot message, which shows the
 * reply that is about to go out, because the owner cannot cancel what they cannot read: D-096); the bot token is only ever in the request
 * URL and is never logged; and NOTHING here may break the work that raised the notification, so every failure is a returned value.
 */

const SEND_TIMEOUT_MS = 10_000;
/** Telegram answers 429 with how long to wait. Waiting a few seconds once is reasonable; waiting minutes inside a job is not. */
const MAX_RETRY_AFTER_S = 5;
const MAX_TEXT = 4096;

export type TelegramResult =
  | { ok: true; messageId: string }
  | { ok: false; reason: 'rate_limited' | 'rejected' | 'network' | 'unreadable'; detail: string };

/** A button under a message. `callbackData` comes back to the bot webhook when it is tapped (Telegram allows at most 64 bytes). */
export interface TelegramButton {
  text: string;
  callbackData: string;
}

const responseSchema = z.looseObject({
  ok: z.boolean(),
  // sendMessage and editMessageText answer with the message, answerCallbackQuery with `true`.
  result: z.union([z.looseObject({ message_id: z.number() }), z.boolean()]).optional(),
  error_code: z.number().optional(),
  description: z.string().optional(),
  parameters: z.looseObject({ retry_after: z.number().optional() }).optional(),
});

async function post(method: string, payload: Record<string, unknown>): Promise<{ status: number; body: z.infer<typeof responseSchema> | null }> {
  const env = getEnv();
  const response = await globalThis.fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One Telegram Bot API call with the shared rules: retry once if told to wait a few seconds, never throw. `messageId` is null for calls that return no message. */
async function call(method: string, payload: Record<string, unknown>, sleep: Sleep): Promise<{ ok: true; messageId: string | null } | Extract<TelegramResult, { ok: false }>> {
  try {
    let attempt = await post(method, payload);
    if (attempt.status === 429) {
      const wait = attempt.body?.parameters?.retry_after ?? 1;
      if (wait > MAX_RETRY_AFTER_S) return { ok: false, reason: 'rate_limited', detail: `Telegram asked us to wait ${wait}s.` };
      await sleep(wait * 1000);
      attempt = await post(method, payload);
    }
    if (attempt.body === null) return { ok: false, reason: 'unreadable', detail: `Telegram answered HTTP ${attempt.status} with something we could not read.` };
    if (attempt.body.ok && attempt.body.result !== undefined) {
      const result = attempt.body.result;
      return { ok: true, messageId: typeof result === 'object' ? String(result.message_id) : null };
    }
    if (attempt.status === 429) return { ok: false, reason: 'rate_limited', detail: 'Telegram is still rate-limiting us.' };
    return { ok: false, reason: 'rejected', detail: `Telegram refused it (${attempt.body.error_code ?? attempt.status}): ${attempt.body.description ?? 'no reason given'}` };
  } catch (error) {
    return { ok: false, reason: 'network', detail: `Could not reach Telegram (${error instanceof Error ? error.name : 'error'}).` };
  }
}

/** Sends one plain-text message to the owner's chat. Never throws. Retries once when Telegram says to wait a few seconds. */
export async function sendTelegramMessage(text: string, sleep: Sleep = defaultSleep): Promise<TelegramResult> {
  const result = await call('sendMessage', { chat_id: getEnv().TELEGRAM_CHAT_ID, text: text.slice(0, MAX_TEXT), disable_web_page_preview: true }, sleep);
  if (!result.ok) return result;
  return result.messageId === null ? { ok: false, reason: 'unreadable', detail: 'Telegram accepted the message but did not say which one it was.' } : { ok: true, messageId: result.messageId };
}

/** A message with a row of buttons (rows of buttons) under it. */
export async function sendTelegramButtons(text: string, rows: readonly (readonly TelegramButton[])[], sleep: Sleep = defaultSleep): Promise<TelegramResult> {
  const result = await call(
    'sendMessage',
    {
      chat_id: getEnv().TELEGRAM_CHAT_ID,
      text: text.slice(0, MAX_TEXT),
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: rows.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) },
    },
    sleep,
  );
  if (!result.ok) return result;
  return result.messageId === null ? { ok: false, reason: 'unreadable', detail: 'Telegram accepted the message but did not say which one it was.' } : { ok: true, messageId: result.messageId };
}

/** Replaces a message's text and REMOVES its buttons (a tap that has been handled, or a decision that was made elsewhere must not stay tappable). */
export async function retireTelegramMessage(messageId: string, text: string, sleep: Sleep = defaultSleep): Promise<{ ok: boolean }> {
  const result = await call(
    'editMessageText',
    { chat_id: getEnv().TELEGRAM_CHAT_ID, message_id: Number(messageId), text: text.slice(0, MAX_TEXT), disable_web_page_preview: true, reply_markup: { inline_keyboard: [] } },
    sleep,
  );
  if (!result.ok) logger.warn({ reason: result.reason }, 'telegram message not updated');
  return { ok: result.ok };
}

/** Stops the spinner on the tapped button and shows a short line to the owner. Best effort. */
export async function answerTelegramCallback(callbackQueryId: string, text: string, sleep: Sleep = defaultSleep): Promise<void> {
  const result = await call('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text.slice(0, 200) }, sleep);
  if (!result.ok) logger.warn({ reason: result.reason }, 'telegram callback not answered');
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
    const result = await sendTelegramMessage(alertText(alert, `${getEnv().APP_URL}${alertPath(alert.kind)}`));
    if (!result.ok) logger.warn({ alert: alert.kind, reason: result.reason }, 'telegram alert not delivered');
  } catch (error) {
    logger.warn({ alert: alert.kind, error: error instanceof Error ? error.name : 'unknown' }, 'telegram alert sink failed');
  }
}
