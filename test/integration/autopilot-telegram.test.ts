import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModelProvider } from '@/lib/ai/models';
import { resetStrictCache } from '@/lib/ai/run';
import { callbackData } from '@/lib/autopilot/copy';
import { runAutopilotForDraft } from '@/lib/autopilot/decide';
import { autopilotJobKey } from '@/lib/autopilot/jobs';
import { autopilotSend } from '@/lib/autopilot/send';
import { handleTelegramWebhook } from '@/lib/autopilot/telegram-intake';
import { type Db, getDb } from '@/lib/db';
import { toJobId } from '@/lib/queue/enqueue';
import { getQueue } from '@/lib/queue/queues';
import { MIN, type World, seedAutopilotWorld } from '../helpers/autopilot';
import { FIXTURE } from '../helpers/fixtures';
import { chatCompletion } from '../helpers/groq';
import { NOW, count, setupIngestHarness } from '../helpers/ingest';
import { jsonResponse, stubNetwork } from '../helpers/network';

const h = setupIngestHarness();
const sql = () => h.admin();

beforeEach(async () => {
  resetStrictCache();
  resetModelProvider();
  await getQueue('autopilot-send').obliterate({ force: true });
  await getQueue('outbound-send').obliterate({ force: true });
});
afterEach(() => vi.unstubAllGlobals());

// TELEGRAM_WEBHOOK_SECRET and TELEGRAM_CHAT_ID come from the test environment.
const SECRET = 'test-telegram-secret';
const CHAT = 123456789;

const verdict = () => chatCompletion(JSON.stringify({ unsupportedClaims: [], commitments: [], answersTheCustomer: true, toneRisk: false, verdict: 'pass' }));
const telegramOk = (request: { url: string }) => (request.url.endsWith('/answerCallbackQuery') ? jsonResponse({ ok: true, result: true }) : jsonResponse({ ok: true, result: { message_id: 4242 } }));
const accepted = (wamid: string) => jsonResponse({ messaging_product: 'whatsapp', contacts: [{ input: FIXTURE.amina.wa, wa_id: FIXTURE.amina.wa }], messages: [{ id: wamid }] });
let wamids = 0;
const network = () => stubNetwork({ groq: () => verdict(), telegram: telegramOk, graphSend: () => accepted(`wamid.TG.${(wamids += 1)}`) });
type Net = ReturnType<typeof network>;
const answers = (net: Net) => net.telegram.filter((request) => request.url.endsWith('/answerCallbackQuery'));
const edits = (net: Net) => net.telegram.filter((request) => request.url.endsWith('/editMessageText'));

async function scheduled(): Promise<{ world: World; net: Net }> {
  const world = await seedAutopilotWorld(sql());
  const net = network();
  expect((await runAutopilotForDraft(getDb(), world.draftId, NOW)).kind).toBe('scheduled');
  return { world, net };
}

function update(data: string, over: { chat?: unknown; secret?: string | null; body?: unknown; raw?: string } = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (over.secret !== null) headers.set('x-telegram-bot-api-secret-token', over.secret ?? SECRET);
  const body = over.raw ?? JSON.stringify(over.body ?? { update_id: 1, callback_query: { id: 'cb-1', from: { id: CHAT }, message: { message_id: 4242, chat: { id: over.chat ?? CHAT } }, data } });
  return new Request('https://example.test/api/webhooks/telegram', { method: 'POST', headers, body });
}

const draftStatus = async (id: string) => (await sql()<{ status: string }[]>`SELECT status FROM drafts WHERE id = ${id}`)[0]?.status;
const audits = (action: string) => sql()<{ actor: string; metadata: Record<string, unknown> }[]>`SELECT actor, metadata FROM audit_log WHERE action = ${action} ORDER BY created_at`;
const job = (draftId: string) => getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(draftId)));

describe('who may press the buttons', () => {
  it.each([
    ['no secret header', null],
    ['a wrong secret', 'not-the-secret'],
    ['a secret of the wrong length', 'x'],
    ['a wrong secret of exactly the right length (only the last character differs)', `${SECRET.slice(0, -1)}X`],
    ['the right secret in the wrong case', SECRET.toUpperCase()],
    ['the right secret with a trailing character', `${SECRET}x`],
  ])('%s is rejected with 401 and changes nothing', async (_name, secret) => {
    const { world, net } = await scheduled();
    const before = net.telegram.length;
    const response = await handleTelegramWebhook(update(callbackData('cancel', world.draftId), { secret }));
    expect(response.status).toBe(401);
    expect(await draftStatus(world.draftId)).toBe('scheduled');
    expect(await audits('autopilot.cancel')).toHaveLength(0);
    expect(net.telegram.length).toBe(before); // not even an "answer"
    expect(await job(world.draftId)).toBeDefined();
  });

  it('a tap from any other chat is ignored without a word (200, nothing changed, nothing answered)', async () => {
    const { world, net } = await scheduled();
    const before = net.telegram.length;
    for (const chat of [999, '999', -100123, 1234567890, 12345678, String(CHAT) + '0']) {
      const response = await handleTelegramWebhook(update(callbackData('cancel', world.draftId), { chat }));
      expect(response.status).toBe(200);
    }
    expect(await draftStatus(world.draftId)).toBe('scheduled');
    expect(net.telegram.length).toBe(before);
  });

  it('the owner\'s chat id is accepted as a number or a string', async () => {
    const { world } = await scheduled();
    expect((await handleTelegramWebhook(update(callbackData('cancel', world.draftId), { chat: String(CHAT) }))).status).toBe(200);
    expect(await draftStatus(world.draftId)).toBe('pending');
  });

  it('a callback with no message (nothing to prove it came from our chat) is ignored', async () => {
    const { world } = await scheduled();
    const response = await handleTelegramWebhook(update('', { body: { update_id: 2, callback_query: { id: 'cb', from: { id: CHAT }, data: callbackData('cancel', world.draftId) } } }));
    expect(response.status).toBe(200);
    expect(await draftStatus(world.draftId)).toBe('scheduled');
  });
});

describe('what it accepts', () => {
  it.each([
    ['not JSON', { raw: 'hello' }],
    ['JSON of another shape', { body: ['x'] }],
    ['an update that is not a button tap', { body: { update_id: 3, message: { text: 'hi' } } }],
    ['an empty body', { raw: '' }],
  ])('%s: answered 200 so Telegram does not resend it, and nothing happens', async (_name, over) => {
    const { world } = await scheduled();
    expect((await handleTelegramWebhook(update('', over))).status).toBe(200);
    expect(await draftStatus(world.draftId)).toBe('scheduled');
  });

  it('a body over 64 KB is ignored (200) without being read into memory', async () => {
    const { world } = await scheduled();
    const big = new Request('https://example.test/api/webhooks/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': SECRET, 'content-length': String(70 * 1024) }, body: 'x'.repeat(70 * 1024) });
    const response = await handleTelegramWebhook(big);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ignored: 'too_large' });
    expect(await draftStatus(world.draftId)).toBe('scheduled');
  });

  it.each([
    'ap:delete:0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
    'ap:cancel:not-a-uuid',
    'ap:cancel:',
    'cancel',
    '',
    'ap:cancel:0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee extra',
    "ap:cancel:0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee'; DROP TABLE drafts;--",
  ])('button data %j is not one of ours: "not recognised", nothing changes', async (data) => {
    const { world, net } = await scheduled();
    const response = await handleTelegramWebhook(update(data));
    expect(response.status).toBe(200);
    expect(await draftStatus(world.draftId)).toBe('scheduled');
    expect(String(answers(net).at(-1)?.body.text)).toContain('not recognised');
  });
});

describe('Cancel', () => {
  it('puts the draft back in the approval queue, ends the countdown, closes the phone message, audits it as the owner via Telegram, and answers the tap', async () => {
    const { world, net } = await scheduled();
    const response = await handleTelegramWebhook(update(callbackData('cancel', world.draftId)));
    expect(response.status).toBe(200);

    expect(await draftStatus(world.draftId)).toBe('pending');
    const [row] = await sql()<{ scheduled_send_at: Date | null }[]>`SELECT scheduled_send_at FROM drafts WHERE id = ${world.draftId}`;
    expect(row?.scheduled_send_at).toBeNull();
    expect(await job(world.draftId)).toBeUndefined();
    expect(await audits('autopilot.cancel')).toEqual([{ actor: 'owner', metadata: { conversationId: world.conversationId, via: 'telegram' } }]);
    expect(String(edits(net)[0]?.body.text)).toContain('Cancelled by you');
    expect(edits(net)[0]?.body.reply_markup).toEqual({ inline_keyboard: [] });
    expect(answers(net)[0]?.body).toMatchObject({ callback_query_id: 'cb-1', text: 'Cancelled. It is waiting in Approvals.' });
    expect((await h.events()).map((event) => event.type)).toContain('autopilot:cancelled');
    expect(await count(sql(), 'messages', `provenance = 'ai_autopilot'`)).toBe(0);
  });

  it('repeated taps are idempotent: one audit entry, one edit, the same answer', async () => {
    const { world, net } = await scheduled();
    for (let i = 0; i < 4; i += 1) expect((await handleTelegramWebhook(update(callbackData('cancel', world.draftId)))).status).toBe(200);
    expect(await audits('autopilot.cancel')).toHaveLength(1);
    expect(edits(net)).toHaveLength(1);
    expect(answers(net).map((request) => request.body.text)).toEqual(['Cancelled. It is waiting in Approvals.', 'Already handled.', 'Already handled.', 'Already handled.']);
    expect(await draftStatus(world.draftId)).toBe('pending');
  });

  it('a cancelled draft is never sent by the autopilot, even if its job somehow runs', async () => {
    const { world } = await scheduled();
    await handleTelegramWebhook(update(callbackData('cancel', world.draftId)));
    expect((await autopilotSend(world.draftId, { now: new Date(NOW.getTime() + 3 * MIN) })).outcome).toBe('skipped');
    expect(await count(sql(), 'messages', `provenance = 'ai_autopilot'`)).toBe(0);
  });

  it('a tap on a reply that was already sent says so and takes the buttons off', async () => {
    const { world, net } = await scheduled();
    await autopilotSend(world.draftId, { now: new Date(NOW.getTime() + 3 * MIN) });
    const response = await handleTelegramWebhook(update(callbackData('cancel', world.draftId)));
    expect(response.status).toBe(200);
    expect(String(answers(net).at(-1)?.body.text)).toBe('Already handled.');
    expect(await draftStatus(world.draftId)).toBe('approved');
    expect(await count(sql(), 'messages', `provenance = 'ai_autopilot'`)).toBe(1);
  });

  it('a tap for a draft that does not exist is answered politely', async () => {
    const { net } = await scheduled();
    await handleTelegramWebhook(update(callbackData('cancel', '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee')));
    expect(String(answers(net).at(-1)?.body.text)).toBe('That reply no longer exists.');
  });
});

describe('Send now', () => {
  it('runs the countdown\'s job at once (promoted from delayed to waiting), audited; the send still goes through the re-check', async () => {
    const { world, net } = await scheduled();
    expect((await job(world.draftId))?.opts.delay).toBe(120_000);
    const response = await handleTelegramWebhook(update(callbackData('send', world.draftId)));
    expect(response.status).toBe(200);
    expect(await (await job(world.draftId))?.isDelayed()).toBe(false);
    expect(await (await job(world.draftId))?.isWaiting()).toBe(true);
    expect(await audits('autopilot.send_now')).toEqual([{ actor: 'owner', metadata: { conversationId: world.conversationId, via: 'telegram' } }]);
    expect(String(answers(net)[0]?.body.text)).toContain('Sending now');
    // nothing was sent by the tap itself: the worker's job does that, after its re-check
    expect(await count(sql(), 'messages', `provenance = 'ai_autopilot'`)).toBe(0);
    expect(await draftStatus(world.draftId)).toBe('scheduled');
  });

  it('is still subject to the re-check: if autopilot was paused meanwhile, the promoted job routes the draft to approval', async () => {
    const { world } = await scheduled();
    await handleTelegramWebhook(update(callbackData('send', world.draftId)));
    await sql()`UPDATE settings SET autopilot_paused = true`;
    expect(await autopilotSend(world.draftId, { now: new Date(NOW.getTime() + 10 * 1000) })).toEqual({ outcome: 'routed', reasons: ['autopilot_paused'] });
    expect(await count(sql(), 'messages', `provenance = 'ai_autopilot'`)).toBe(0);
  });

  it('repeated taps change nothing more (one audit entry, and the later taps are told the reply is already on its way), and a tap after Cancel does nothing', async () => {
    const { world, net } = await scheduled();
    for (let i = 0; i < 3; i += 1) await handleTelegramWebhook(update(callbackData('send', world.draftId)));
    expect(await audits('autopilot.send_now')).toHaveLength(1);
    expect(answers(net).map((request) => request.body.text)).toEqual(['Sending now (it is checked once more first).', 'Already on its way.', 'Already on its way.']);
    // the job the first tap promoted is still there for the worker: repeated taps never delete it
    expect(await (await job(world.draftId))?.isWaiting()).toBe(true);
    expect(await draftStatus(world.draftId)).toBe('scheduled');
  });

  it('restarts a countdown whose job was lost (Redis flushed), with no delay', async () => {
    const { world } = await scheduled();
    await getQueue('autopilot-send').obliterate({ force: true });
    await handleTelegramWebhook(update(callbackData('send', world.draftId)));
    const restarted = await job(world.draftId);
    expect(restarted?.opts.delay).toBe(0);
  });

  it('after Cancel, Send now does nothing', async () => {
    const { world, net } = await scheduled();
    await handleTelegramWebhook(update(callbackData('cancel', world.draftId)));
    await handleTelegramWebhook(update(callbackData('send', world.draftId)));
    expect(await audits('autopilot.send_now')).toHaveLength(0);
    expect(String(answers(net).at(-1)?.body.text)).toBe('Already handled.');
    expect(await job(world.draftId)).toBeUndefined();
  });
});

describe('a tap on something that is no longer there or no longer waiting', () => {
  it('Send now for a draft that does not exist is answered politely (200), not a server error', async () => {
    const { net } = await scheduled();
    const response = await handleTelegramWebhook(update(callbackData('send', '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee')));
    expect(response.status).toBe(200);
    expect(String(answers(net).at(-1)?.body.text)).toBe('That reply no longer exists.');
  });

  it.each([
    ['cancel', 'Already handled.'],
    ['send', 'Already handled.'],
  ] as const)('a %s tap on a draft the owner handled by other means (its phone message still has buttons) takes the buttons off', async (action, answer) => {
    const { world, net } = await scheduled();
    // The owner rejected it from the dashboard and the message was never rewritten (as if that edit had failed).
    await sql()`UPDATE drafts SET status = 'rejected', scheduled_send_at = NULL WHERE id = ${world.draftId}`;
    expect((await handleTelegramWebhook(update(callbackData(action, world.draftId)))).status).toBe(200);
    expect(edits(net)).toHaveLength(1);
    expect(String(edits(net)[0]?.body.text)).toContain('Already handled.');
    expect(edits(net)[0]?.body.reply_markup).toEqual({ inline_keyboard: [] });
    expect(String(answers(net).at(-1)?.body.text)).toBe(answer);
    expect(await audits(action === 'cancel' ? 'autopilot.cancel' : 'autopilot.send_now')).toHaveLength(0);
  });
});

describe('when the system is unwell', () => {
  it('a database failure while acting is a 500, so Telegram sends the tap again (safe: both buttons are idempotent)', async () => {
    const { world } = await scheduled();
    const broken = { transaction: () => Promise.reject(new Error('database is down')), select: () => Promise.reject(new Error('database is down')) } as unknown as Db;
    const response = await handleTelegramWebhook(update(callbackData('cancel', world.draftId)), broken);
    expect(response.status).toBe(500);
    // ...and the retried tap, once the database is back, works
    expect((await handleTelegramWebhook(update(callbackData('cancel', world.draftId)))).status).toBe(200);
    expect(await draftStatus(world.draftId)).toBe('pending');
  });
});

describe('the route itself', () => {
  it('is wired to the handler (POST /api/webhooks/telegram)', async () => {
    const { POST } = await import('@/app/api/webhooks/telegram/route');
    const { world } = await scheduled();
    expect((await POST(update(callbackData('cancel', world.draftId), { secret: 'nope' }))).status).toBe(401);
    expect((await POST(update(callbackData('cancel', world.draftId)))).status).toBe(200);
    expect(await draftStatus(world.draftId)).toBe('pending');
  });
});
