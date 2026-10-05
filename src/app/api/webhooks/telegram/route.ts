import { handleTelegramWebhook } from '@/lib/autopilot/telegram-intake';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Telegram bot's webhook: Cancel and Send now under an autopilot message. Public by design (Telegram calls it); protected by the secret token
 * header and by the chat id, both checked before anything is read or done. Not part of the dashboard session.
 */
export async function POST(request: Request): Promise<Response> {
  return handleTelegramWebhook(request);
}
