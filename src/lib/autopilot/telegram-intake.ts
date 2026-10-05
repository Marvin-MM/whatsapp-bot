import 'server-only';
import { z } from 'zod';
import { writeAudit } from '@/lib/audit';
import { type Db, getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { runEffects } from '@/lib/ingest/effects';
import { logger } from '@/lib/logger';
import { answerTelegramCallback } from '@/lib/notify/telegram';
import { readBodyCapped } from '@/lib/whatsapp/body';
import { safeEqualStrings } from '@/lib/whatsapp/signature';
import { parseCallbackData } from './copy';
import { cancelScheduled, sendNow } from './controls';
import { retireAutopilotDraft } from './telegram';

/**
 * `POST /api/webhooks/telegram` (spec 10.3): the owner taps Cancel or Send now under an autopilot message.
 *
 * Order of checks, each before the next: (1) the shared secret in `X-Telegram-Bot-Api-Secret-Token`, in constant time: wrong or missing is 401 and
 * nothing is read; (2) the body is capped and must be JSON of the expected shape; (3) the tap must come from OUR chat (`TELEGRAM_CHAT_ID`, constant
 * time): taps from anywhere else are ignored without a word; (4) the button data must be exactly one of our two actions on a draft id.
 *
 * Status codes are chosen for Telegram's retry behaviour: anything that cannot become an action (a shape we do not use, a stranger's chat, an unknown
 * button) is 200, so Telegram does not resend it; an infrastructure failure while acting is 500, so Telegram sends the tap again, which is safe
 * because both actions are idempotent. Never a message body in a log.
 */

const MAX_BODY_BYTES = 64 * 1024;

const updateSchema = z.looseObject({
  update_id: z.number().optional(),
  callback_query: z
    .looseObject({
      id: z.string().min(1).max(200),
      data: z.string().max(200).optional(),
      message: z.looseObject({ message_id: z.number().optional(), chat: z.looseObject({ id: z.union([z.number(), z.string()]) }) }).optional(),
    })
    .optional(),
});

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const lastWarned = new Map<string, number>();
function warnRateLimited(key: string, message: string): void {
  const now = Date.now();
  if (now - (lastWarned.get(key) ?? 0) < 60_000) return;
  lastWarned.set(key, now);
  logger.warn({ reason: key }, message);
}

/** Applies one button. Returns the line shown to the owner. Idempotent. */
export async function applyAutopilotButton(db: Db, button: { action: 'cancel' | 'send'; draftId: string }): Promise<string> {
  if (button.action === 'cancel') {
    const { outcome, effects } = await db.transaction(async (tx) => {
      const result = await cancelScheduled(tx, button.draftId);
      if (result.outcome === 'done') {
        await writeAudit(tx, { actor: 'owner', action: 'autopilot.cancel', entityType: 'draft', entityId: button.draftId, metadata: { conversationId: result.conversationId, via: 'telegram' } });
      }
      return result;
    });
    await runEffects(effects);
    if (outcome === 'done') return 'Cancelled. It is waiting in Approvals.';
    // A stale tap: make sure the message stops offering buttons.
    await retireAutopilotDraft(db, button.draftId, 'Already handled.');
    return outcome === 'not_found' ? 'That reply no longer exists.' : 'Already handled.';
  }

  const result = await sendNow(db, button.draftId);
  if (result.outcome === 'done') {
    await writeAudit(db, { actor: 'owner', action: 'autopilot.send_now', entityType: 'draft', entityId: button.draftId, metadata: { conversationId: result.conversationId, via: 'telegram' } });
    return 'Sending now (it is checked once more first).';
  }
  // A repeated tap while the job is on its way changes nothing and must not touch the countdown.
  if (result.outcome === 'in_progress') return 'Already on its way.';
  if (result.outcome === 'already_handled') await retireAutopilotDraft(db, button.draftId, 'Already handled.');
  return result.outcome === 'not_found' ? 'That reply no longer exists.' : 'Already handled.';
}

export async function handleTelegramWebhook(request: Request, db: Db = getDb()): Promise<Response> {
  const env = getEnv();
  const received = request.headers.get('x-telegram-bot-api-secret-token');
  if (received === null || !safeEqualStrings(received, env.TELEGRAM_WEBHOOK_SECRET)) {
    warnRateLimited('telegram_bad_secret', 'telegram webhook rejected: wrong or missing secret token');
    return json({ ok: false }, 401);
  }

  const body = await readBodyCapped(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ ok: true, ignored: 'too_large' }, 200);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return json({ ok: true, ignored: 'not_json' }, 200);
  }
  const update = updateSchema.safeParse(parsedJson);
  if (!update.success) return json({ ok: true, ignored: 'unexpected_shape' }, 200);

  const callback = update.data.callback_query;
  if (!callback) return json({ ok: true, ignored: 'not_a_button' }, 200);

  // Only the owner's own chat may press these. A tap from anywhere else is not answered at all.
  const chatId = callback.message ? String(callback.message.chat.id) : null;
  if (chatId === null || !safeEqualStrings(chatId, env.TELEGRAM_CHAT_ID)) {
    warnRateLimited('telegram_foreign_chat', 'telegram callback ignored: not from the owner chat');
    return json({ ok: true, ignored: 'foreign_chat' }, 200);
  }

  const button = parseCallbackData(callback.data ?? '');
  if (!button) {
    await answerTelegramCallback(callback.id, 'That button is not recognised.');
    return json({ ok: true, ignored: 'unknown_button' }, 200);
  }

  try {
    const line = await applyAutopilotButton(db, button);
    await answerTelegramCallback(callback.id, line);
    return json({ ok: true }, 200);
  } catch (error) {
    // The database or Redis failed: Telegram will send the tap again, and both actions are safe to repeat.
    logger.error({ error: error instanceof Error ? error.name : 'unknown', action: button.action }, 'telegram button failed');
    return json({ ok: false }, 500);
  }
}
