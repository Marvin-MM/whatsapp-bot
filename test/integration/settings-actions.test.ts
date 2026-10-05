import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/lib/db';
import { getProblemMessages } from '@/lib/dashboard/send-health';
import { createEnrolledOwner, headersWith } from '../helpers/auth';
import { FIXTURE } from '../helpers/fixtures';
import { HOUR, NOW, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';
import { jsonResponse, stubNetwork } from '../helpers/network';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const { saveNotificationSettings, testTelegram } = await import('@/actions/notifications');
const { checkWhatsappToken } = await import('@/actions/whatsapp');

const h = setupIngestHarness();
const sql = () => h.admin();

beforeEach(() => {
  requestHeaders.current = new Headers();
});
afterEach(() => vi.unstubAllGlobals());

async function signedIn(): Promise<void> {
  requestHeaders.current = headersWith((await createEnrolledOwner()).cookie);
}
const auditActions = () => sql()<{ action: string; metadata: Record<string, unknown> }[]>`SELECT action, metadata FROM audit_log WHERE actor = 'owner'`;

describe('saveNotificationSettings', () => {
  it('is rejected without a session', async () => {
    expect(await saveNotificationSettings({ notifyTelegram: false, quietHours: { start: '22:00', end: '07:00' } })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });

  it('saves the switch and the quiet hours, remembers the previous values, and audits', async () => {
    await signedIn();
    expect(await saveNotificationSettings({ notifyTelegram: false, quietHours: { start: '21:30', end: '06:15' } })).toMatchObject({ ok: true });
    const [row] = await sql()<{ notify_telegram: boolean; quiet_hours: { start: string; end: string } }[]>`SELECT notify_telegram, quiet_hours FROM settings`;
    expect(row).toEqual({ notify_telegram: false, quiet_hours: { start: '21:30', end: '06:15' } });

    await saveNotificationSettings({ notifyTelegram: true, quietHours: { start: '23:00', end: '05:00' } });
    const entries = (await auditActions()).filter((e) => e.action === 'settings.notifications');
    expect(entries).toHaveLength(2);
    expect(entries[1]?.metadata).toMatchObject({ previous: { notifyTelegram: false, quietHours: { start: '21:30', end: '06:15' } } });
  });

  it.each([
    ['25:00', '07:00'],
    ['22:00', '7am'],
    ['', ''],
    ['22:60', '07:00'],
  ])('refuses a bad time (%s - %s) and changes nothing', async (start, end) => {
    await signedIn();
    const result = await saveNotificationSettings({ notifyTelegram: true, quietHours: { start, end } });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect((await sql()`SELECT 1 FROM settings`).length).toBe(0);
  });
});

describe('testTelegram', () => {
  it('is rejected without a session and sends nothing', async () => {
    const net = stubNetwork({ telegram: () => jsonResponse({ ok: true, result: { message_id: 1 } }) });
    expect(await testTelegram({})).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(net.telegram).toHaveLength(0);
  });

  it('sends a test message and says so; a refusal from Telegram is shown to the owner verbatim-ish (no token)', async () => {
    await signedIn();
    const net = stubNetwork({ telegram: () => jsonResponse({ ok: true, result: { message_id: 1 } }) });
    expect(await testTelegram({})).toEqual({ ok: true, data: { delivered: true } });
    expect(String(net.telegram[0]?.body.text)).toMatch(/Test from your WhatsApp assistant/);

    vi.unstubAllGlobals();
    stubNetwork({ telegram: () => jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400) });
    const failed = await testTelegram({});
    expect(failed).toMatchObject({ ok: false, error: { code: 'refused', reason: 'telegram_rejected' } });
    expect(JSON.stringify(failed)).toMatch(/chat not found/);
    expect(JSON.stringify(failed)).not.toContain('test-telegram-token');
  });
});

describe('checkWhatsappToken', () => {
  it('is rejected without a session and does not call Meta', async () => {
    const net = stubNetwork({ graphInfo: () => jsonResponse({}) });
    expect(await checkWhatsappToken({})).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(net.graph).toHaveLength(0);
  });

  it('asks Meta now and returns the result', async () => {
    await signedIn();
    stubNetwork({ graphInfo: () => jsonResponse({ quality_rating: 'GREEN', verified_name: 'agent_47' }) });
    expect(await checkWhatsappToken({})).toMatchObject({ ok: true, data: { status: 'valid', quality: 'GREEN' } });
  });
});

describe('getProblemMessages', () => {
  it('lists failed, unknown and queued outbound messages, newest first, with no text and no phone number', async () => {
    const contact = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}`, bsuid: FIXTURE.amina.bsuid });
    const conversationId = await seedConversation(sql(), contact);
    const old = await seedMessage(sql(), conversationId, { direction: 'outbound', status: 'failed', content: 'secret text', occurredAt: new Date(NOW.getTime() - 3 * HOUR) });
    const mid = await seedMessage(sql(), conversationId, { direction: 'outbound', status: 'unknown', content: 'secret text', occurredAt: new Date(NOW.getTime() - 2 * HOUR) });
    const fresh = await seedMessage(sql(), conversationId, { direction: 'outbound', status: 'queued', content: 'secret text', occurredAt: new Date(NOW.getTime() - HOUR) });
    await seedMessage(sql(), conversationId, { direction: 'outbound', status: 'sent', content: 'fine', occurredAt: NOW });
    await seedMessage(sql(), conversationId, { direction: 'inbound', status: 'received', content: 'hello', occurredAt: NOW });
    await sql()`UPDATE messages SET error = ${sql().json({ kind: 'permanent', code: '131047', message: 'window' })} WHERE id = ${old}`;

    const problems = await getProblemMessages(getDb());
    expect(problems.map((p) => [p.messageId, p.status])).toEqual([[fresh, 'queued'], [mid, 'unknown'], [old, 'failed']]);
    expect(problems[2]?.error).toMatchObject({ code: '131047' });
    expect(JSON.stringify(problems)).not.toContain('secret text');
    expect(JSON.stringify(problems)).not.toContain(FIXTURE.amina.wa);
  });

  it('shows at most the newest 20', async () => {
    const contact = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}` });
    const conversationId = await seedConversation(sql(), contact);
    for (let i = 0; i < 25; i += 1) await seedMessage(sql(), conversationId, { direction: 'outbound', status: 'failed', occurredAt: new Date(NOW.getTime() + i * 1000) });
    expect(await getProblemMessages(getDb())).toHaveLength(20);
  });
});
