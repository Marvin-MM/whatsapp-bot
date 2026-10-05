import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendTelegramMessage, telegramAlertSink } from '@/lib/notify/telegram';
import { jsonResponse, stubNetwork } from '../helpers/network';
import { setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();
afterEach(() => vi.unstubAllGlobals());

const ok = (id = 42) => jsonResponse({ ok: true, result: { message_id: id } });
const noSleep = async () => undefined;
// 2026-10-05 19:30 UTC = 22:30 in Kampala (inside the default quiet hours 22:00-07:00); 09:00 UTC = 12:00 local (outside).
const QUIET = new Date('2026-10-05T19:30:00Z');
const DAY = new Date('2026-10-05T09:00:00Z');

describe('sendTelegramMessage', () => {
  it('posts PLAIN text (no parse_mode) to the owner’s chat, with the token only in the URL', async () => {
    const net = stubNetwork({ telegram: () => ok(7) });
    expect(await sendTelegramMessage('hello <b>world</b>')).toEqual({ ok: true, messageId: '7' });
    expect(net.telegram).toHaveLength(1);
    expect(net.telegram[0]?.url).toBe('https://api.telegram.org/bottest-telegram-token/sendMessage');
    expect(net.telegram[0]?.body).toEqual({ chat_id: '123456789', text: 'hello <b>world</b>', disable_web_page_preview: true });
    expect(net.telegram[0]?.body).not.toHaveProperty('parse_mode');
  });

  it('caps the text at Telegram’s limit', async () => {
    const net = stubNetwork({ telegram: () => ok() });
    await sendTelegramMessage('x'.repeat(5000));
    expect(String(net.telegram[0]?.body.text)).toHaveLength(4096);
  });

  it('waits and retries ONCE on a short 429, and gives up on a long one without waiting', async () => {
    let calls = 0;
    const net = stubNetwork({ telegram: () => (++calls === 1 ? jsonResponse({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 2 } }, 429) : ok(9)) });
    const slept: number[] = [];
    expect(await sendTelegramMessage('a', async (ms) => void slept.push(ms))).toEqual({ ok: true, messageId: '9' });
    expect(slept).toEqual([2000]);
    expect(net.telegram).toHaveLength(2);

    vi.unstubAllGlobals();
    const long = stubNetwork({ telegram: () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 300 } }, 429) });
    expect(await sendTelegramMessage('a', noSleep)).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(long.telegram).toHaveLength(1);
  });

  it.each([
    ['a refusal', () => jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400), 'rejected'],
    ['an unreadable body', () => new Response('<html>', { status: 502 }), 'unreadable'],
    [
      'a network failure',
      () => {
        throw new TypeError('fetch failed');
      },
      'network',
    ],
  ])('returns (never throws) on %s', async (_name, route, reason) => {
    stubNetwork({ telegram: route });
    expect(await sendTelegramMessage('a', noSleep)).toMatchObject({ ok: false, reason });
  });

  it('never puts the bot token in a returned detail', async () => {
    stubNetwork({
      telegram: () => {
        throw new TypeError('fetch failed for https://api.telegram.org/bottest-telegram-token/sendMessage');
      },
    });
    const result = await sendTelegramMessage('a');
    expect(JSON.stringify(result)).not.toContain('test-telegram-token');
  });
});

describe('telegramAlertSink', () => {
  beforeEach(async () => {
    await sql()`INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING`;
  });

  const alert = (severity: 'info' | 'warning' | 'critical') => ({ kind: 'message_unknown', severity, entityId: 'abc', dedupeKey: `k-${severity}` });

  it('delivers a warning in the daytime, with a readable sentence and the dashboard link, and no ids or bodies', async () => {
    const net = stubNetwork({ telegram: () => ok() });
    await telegramAlertSink(alert('warning'), DAY);
    expect(net.telegram).toHaveLength(1);
    const text = String(net.telegram[0]?.body.text);
    expect(text).toContain('may not have been sent');
    expect(text).toContain('http://localhost:3000/settings');
    expect(text).not.toContain('abc');
  });

  it('quiet hours silence warnings but NEVER a critical alert', async () => {
    const net = stubNetwork({ telegram: () => ok() });
    await telegramAlertSink(alert('warning'), QUIET);
    expect(net.telegram).toHaveLength(0);
    await telegramAlertSink(alert('critical'), QUIET);
    expect(net.telegram).toHaveLength(1);
  });

  it('info alerts never buzz the phone', async () => {
    const net = stubNetwork({ telegram: () => ok() });
    await telegramAlertSink(alert('info'), DAY);
    expect(net.telegram).toHaveLength(0);
  });

  it('the owner’s switch turns it all off, even critical', async () => {
    await sql()`UPDATE settings SET notify_telegram = false`;
    const net = stubNetwork({ telegram: () => ok() });
    await telegramAlertSink(alert('critical'), DAY);
    expect(net.telegram).toHaveLength(0);
  });

  it('respects custom quiet hours (and a malformed setting means no quiet hours)', async () => {
    const net = stubNetwork({ telegram: () => ok() });
    await sql()`UPDATE settings SET quiet_hours = ${sql().json({ start: '11:00', end: '13:00' })}`;
    await telegramAlertSink(alert('warning'), DAY); // 12:00 local
    expect(net.telegram).toHaveLength(0);
    await sql()`UPDATE settings SET quiet_hours = ${sql().json({ start: 'bad', end: 'worse' })}`;
    await telegramAlertSink(alert('warning'), QUIET);
    expect(net.telegram).toHaveLength(1);
  });

  it('an unreadable quiet-hours setting means "not quiet": the alert is delivered, not swallowed', async () => {
    const net = stubNetwork({ telegram: () => ok() });
    await sql()`UPDATE settings SET quiet_hours = 'null'::jsonb`;
    await telegramAlertSink(alert('warning'), QUIET);
    await sql()`UPDATE settings SET quiet_hours = '"22:00-07:00"'::jsonb`;
    await telegramAlertSink({ ...alert('warning'), dedupeKey: 'again' }, QUIET);
    expect(net.telegram).toHaveLength(2);
  });

  it('a Telegram outage never throws into the code that raised the alert', async () => {
    stubNetwork({
      telegram: () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(telegramAlertSink(alert('critical'), DAY)).resolves.toBeUndefined();
  });

  it('delivers when the settings row does not exist yet (defaults: on, quiet 22:00-07:00)', async () => {
    await sql()`DELETE FROM settings`;
    const net = stubNetwork({ telegram: () => ok() });
    await telegramAlertSink(alert('warning'), DAY);
    expect(net.telegram).toHaveLength(1);
  });
});
