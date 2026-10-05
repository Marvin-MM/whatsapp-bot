import { parseArgs } from 'node:util';
import { z } from 'zod';
import { getEnv } from '@/lib/env';

/**
 * Registers (or inspects, or removes) the Telegram bot's webhook: the URL Telegram calls when the owner taps Cancel / Send now under an autopilot
 * message. Run it once after deploying (`pnpm telegram:webhook`), and again if APP_URL or TELEGRAM_WEBHOOK_SECRET changes.
 *
 * It never prints the bot token or the secret. Telegram requires https (on port 443, 80, 88 or 8443) and a secret of 1-256 of A-Z a-z 0-9 _ -.
 */

const USAGE = `Usage: pnpm telegram:webhook [options]

Tells Telegram to send button taps (Cancel / Send now) to APP_URL/api/webhooks/telegram, authenticated with TELEGRAM_WEBHOOK_SECRET.

Options:
  --info       Show what Telegram currently has (the URL, pending updates, the last delivery error). Changes nothing.
  --delete     Remove the webhook (the buttons stop working; alerts and pings are unaffected).
  -h, --help   Show this help
`;

const { values } = parseArgs({ options: { info: { type: 'boolean', default: false }, delete: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } } });

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const ALLOWED_PORTS = new Set(['', '80', '88', '443', '8443']);

const responseSchema = z.looseObject({ ok: z.boolean(), description: z.string().optional(), result: z.unknown().optional() });
const infoSchema = z.looseObject({
  url: z.string().optional(),
  pending_update_count: z.number().optional(),
  last_error_date: z.number().optional(),
  last_error_message: z.string().optional(),
  allowed_updates: z.array(z.string()).optional(),
});

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function call(method: string, body: Record<string, unknown> = {}): Promise<z.infer<typeof responseSchema>> {
  const env = getEnv();
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return fail(`Could not reach Telegram (${error instanceof Error ? error.name : 'error'}). Check this machine's network.`);
  }
  const parsed = responseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return fail(`Telegram answered HTTP ${response.status} with something unreadable.`);
  if (!parsed.data.ok) return fail(`Telegram refused it (HTTP ${response.status}): ${parsed.data.description ?? 'no reason given'}`);
  return parsed.data;
}

async function showInfo(): Promise<void> {
  const { result } = await call('getWebhookInfo');
  const info = infoSchema.safeParse(result);
  if (!info.success) return fail('Telegram sent webhook information in an unexpected shape.');
  const data = info.data;
  process.stdout.write(`Webhook URL:      ${data.url || '(none set)'}\n`);
  process.stdout.write(`Pending updates:  ${data.pending_update_count ?? 0}\n`);
  process.stdout.write(`Allowed updates:  ${data.allowed_updates?.join(', ') || '(all)'}\n`);
  process.stdout.write(data.last_error_message ? `Last error:       ${data.last_error_message}${data.last_error_date ? ` (${new Date(data.last_error_date * 1000).toISOString()})` : ''}\n` : 'Last error:       none\n');
}

async function main(): Promise<void> {
  const env = getEnv();
  if (values.info) return showInfo();
  if (values.delete) {
    await call('deleteWebhook', { drop_pending_updates: false });
    process.stdout.write('The webhook was removed: Cancel / Send now buttons will not work until you register it again.\n');
    return;
  }

  const url = new URL('/api/webhooks/telegram', env.APP_URL);
  if (url.protocol !== 'https:') fail(`APP_URL (${env.APP_URL}) is not https: Telegram only delivers to https addresses. Use your public address (a tunnel is fine for a test).`);
  if (!ALLOWED_PORTS.has(url.port)) fail(`Telegram only delivers to ports 443, 80, 88 and 8443, not ${url.port}.`);
  if (!SECRET_PATTERN.test(env.TELEGRAM_WEBHOOK_SECRET)) fail('TELEGRAM_WEBHOOK_SECRET may only use A-Z a-z 0-9 _ - (1 to 256 characters): Telegram rejects anything else. Generate one with: openssl rand -hex 32');

  await call('setWebhook', { url: url.toString(), secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['callback_query'], drop_pending_updates: false });
  process.stdout.write(`Registered ${url.toString()} (button taps only).\n`);
  await showInfo();
}

await main();
