import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModelProvider } from '@/lib/ai/models';
import { resetStrictCache } from '@/lib/ai/run';
import { MAX_WAITS, generateDraftForConversation } from '@/lib/drafts/generate';
import { loadUnanswered } from '@/lib/drafts/unanswered';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { scanSends } from '@/lib/ops/alerts-scan';
import { FIXTURE } from '../helpers/fixtures';
import { apiError, chatCompletion, stubGroq } from '../helpers/groq';
import { jsonResponse, stubNetwork } from '../helpers/network';
import { notifyDraftReady } from '@/lib/notify/draft-ready';
import { HOUR, NOW, T0, count, envelopeOf, ingestPayload, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';
import { createTestRedis } from '../helpers/redis';

const h = setupIngestHarness();
const sql = () => h.admin();

let draftQueue: Queue;
beforeAll(() => {
  draftQueue = new Queue('generate-draft', { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
});
afterAll(async () => {
  await draftQueue.obliterate({ force: true });
  await draftQueue.close();
});
beforeEach(async () => {
  resetStrictCache();
  resetModelProvider();
  await draftQueue.obliterate({ force: true });
});
afterEach(() => vi.unstubAllGlobals());

const MIN = 60 * 1000;
const answer = (over: Record<string, unknown> = {}) =>
  chatCompletion(JSON.stringify({ intent: 'question', analysis: 'Asks about the dress.', missingFacts: [], riskFlags: [], noReplyNeeded: false, reply: 'Yes dear, we have it 🙏', ...over }));

async function customer(): Promise<{ conversationId: string }> {
  await sql()`INSERT INTO settings (id, owner_name, business_name, business_profile) VALUES (1, 'Marvin', 'agent_47', 'Dress: UGX 50,000') ON CONFLICT (id) DO UPDATE SET ai_paused = false`;
  const contact = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}`, bsuid: FIXTURE.amina.bsuid, name: 'Amina' });
  const conversationId = await seedConversation(sql(), contact, { status: 'waiting_on_me' });
  return { conversationId };
}
const inbound = (conv: string, content: string, at: Date, over: { type?: string } = {}) => seedMessage(sql(), conv, { direction: 'inbound', content, occurredAt: at, ...over });
const drafts = (conv: string) => sql()<{ id: string; status: string; trigger_message_ids: string[]; intent: string; content: string; risk_flags: string[]; missing_facts: string[]; no_reply_needed: boolean; style_guide_version: number | null; fewshot_message_ids: string[] }[]>`SELECT * FROM drafts WHERE conversation_id = ${conv} ORDER BY created_at, id`;
const run = (conv: string, o: { finalAttempt?: boolean; waits?: number } = {}) => generateDraftForConversation(conv, { finalAttempt: o.finalAttempt ?? false, ...(o.waits ? { waits: o.waits } : {}), now: NOW });
const AT = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

describe('what a draft answers', () => {
  it('writes ONE draft for a burst of three messages, listing all three as its triggers, and publishes draft:ready', async () => {
    const { conversationId } = await customer();
    const ids = [await inbound(conversationId, 'Hello', AT(-5 * MIN)), await inbound(conversationId, 'Do you have the blue dress?', AT(-4 * MIN)), await inbound(conversationId, 'in size M', AT(-3 * MIN))];
    const { requests } = stubGroq(() => answer());
    const result = await run(conversationId);

    expect(result.outcome).toBe('created');
    const [draft] = await drafts(conversationId);
    expect(draft).toMatchObject({ status: 'pending', intent: 'question', content: 'Yes dear, we have it 🙏', no_reply_needed: false });
    expect([...(draft?.trigger_message_ids ?? [])].sort()).toEqual([...ids].sort());
    expect(requests).toHaveLength(1);
    const prompt = JSON.stringify(requests[0]?.body?.messages);
    for (const text of ['Hello', 'Do you have the blue dress?', 'in size M']) expect(prompt).toContain(text);
    const events = (await h.events()).filter((e) => e.type === 'draft:ready');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ payload: { conversationId, draftId: draft?.id } });
    expect((await sql()<{ purpose: string }[]>`SELECT purpose FROM ai_runs`)).toEqual([{ purpose: 'draft' }]);
  });

  it('three webhook messages inside the debounce window leave ONE delayed job, carrying the conversation', async () => {
    const times = [0, 1, 2].map((i) => Math.floor(T0.getTime() / 1000) + i);
    for (const [i, ts] of times.entries()) {
      await ingestPayload(
        envelopeOf('messages', {
          contacts: [{ wa_id: FIXTURE.amina.wa, user_id: FIXTURE.amina.bsuid, profile: { name: 'Amina' } }],
          messages: [{ from: FIXTURE.amina.wa, from_user_id: FIXTURE.amina.bsuid, id: `wamid.BURST.${i}`, timestamp: String(ts), type: 'text', text: { body: `part ${i}` } }],
        }),
      );
    }
    const delayed = await draftQueue.getDelayed();
    expect(delayed).toHaveLength(1);
    const conv = (await sql()<{ id: string }[]>`SELECT id FROM conversations`)[0]?.id;
    expect(delayed[0]?.data).toEqual({ conversationId: conv });
    expect(delayed[0]?.opts.delay).toBe(getEnv().DRAFT_DEBOUNCE_SECONDS * 1000);
  });

  it('reactions, imported history and deleted messages are never answered; a reply (even a queued one) answers everything before it', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, '👍', AT(-9 * MIN), { type: 'reaction' });
    await seedMessage(sql(), conversationId, { direction: 'inbound', content: 'old imported', provenance: 'imported', occurredAt: AT(-8 * MIN) });
    const gone = await inbound(conversationId, 'deleted', AT(-7 * MIN));
    await sql()`UPDATE messages SET deleted_at = now() WHERE id = ${gone}`;
    expect(await loadUnanswered(getDb(), conversationId)).toEqual([]);

    const first = await inbound(conversationId, 'real question', AT(-6 * MIN));
    expect((await loadUnanswered(getDb(), conversationId)).map((m) => m.id)).toEqual([first]);
    await seedMessage(sql(), conversationId, { direction: 'outbound', status: 'failed', content: 'never sent', provenance: 'owner_manual', occurredAt: AT(-5 * MIN) });
    expect((await loadUnanswered(getDb(), conversationId)).map((m) => m.id)).toEqual([first]);
    await seedMessage(sql(), conversationId, { direction: 'outbound', status: 'queued', content: 'on its way', provenance: 'owner_manual', occurredAt: AT(-4 * MIN) });
    expect(await loadUnanswered(getDb(), conversationId)).toEqual([]);
    const second = await inbound(conversationId, 'and another', AT(-3 * MIN));
    expect((await loadUnanswered(getDb(), conversationId)).map((m) => m.id)).toEqual([second]);
  });

  it('does nothing (and calls no model) when there is nothing to answer, or a draft already covers exactly these messages', async () => {
    const { conversationId } = await customer();
    const stub = stubGroq(() => answer());
    expect((await run(conversationId)).outcome).toBe('skipped_nothing_to_answer');
    await inbound(conversationId, 'hello', AT(-3 * MIN));
    expect((await run(conversationId)).outcome).toBe('created');
    expect((await run(conversationId)).outcome).toBe('skipped_duplicate');
    expect(stub.requests).toHaveLength(1);
    expect(await drafts(conversationId)).toHaveLength(1);
  });

  it('a new message supersedes the pending draft, and the next draft answers BOTH', async () => {
    const { conversationId } = await customer();
    const a = await inbound(conversationId, 'first', AT(-5 * MIN));
    stubGroq(() => answer({ reply: 'first answer' }));
    await run(conversationId);

    await ingestPayload(
      envelopeOf('messages', {
        contacts: [{ wa_id: FIXTURE.amina.wa, user_id: FIXTURE.amina.bsuid, profile: { name: 'Amina' } }],
        messages: [{ from: FIXTURE.amina.wa, from_user_id: FIXTURE.amina.bsuid, id: 'wamid.SECOND', timestamp: String(Math.floor(NOW.getTime() / 1000) - 60), type: 'text', text: { body: 'second' } }],
      }),
    );
    expect((await drafts(conversationId)).map((d) => d.status)).toEqual(['superseded']);

    vi.unstubAllGlobals();
    stubGroq(() => answer({ reply: 'combined answer' }));
    await run(conversationId);
    const all = await drafts(conversationId);
    expect(all.map((d) => d.status)).toEqual(['superseded', 'pending']);
    expect(all[1]?.trigger_message_ids).toHaveLength(2);
    expect(all[1]?.trigger_message_ids).toContain(a);
  });
});

describe('the completion check: a conversation that moved on while the model was thinking', () => {
  it('a customer message that arrives DURING generation discards the draft; the next run answers both', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'first question', AT(-5 * MIN));
    let calls = 0;
    stubGroq(async () => {
      calls += 1;
      if (calls === 1) await inbound(conversationId, 'wait, one more thing', AT(-1 * MIN));
      return answer({ reply: `answer ${calls}` });
    });
    const first = await run(conversationId);
    expect(first.outcome).toBe('discarded_stale');
    expect(await drafts(conversationId)).toHaveLength(0);
    expect((await h.events()).filter((e) => e.type === 'draft:ready')).toHaveLength(0);

    const second = await run(conversationId);
    expect(second.outcome).toBe('created');
    const [draft] = await drafts(conversationId);
    expect(draft?.trigger_message_ids).toHaveLength(2);
    expect(draft?.content).toBe('answer 2');
  });

  it('a reply the owner sent from the phone DURING generation discards it too (the customer has been answered)', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'question', AT(-5 * MIN));
    stubGroq(async () => {
      await seedMessage(sql(), conversationId, { direction: 'outbound', content: 'answered by hand', provenance: 'owner_app_echo', occurredAt: AT(-30 * 1000) });
      return answer();
    });
    expect((await run(conversationId)).outcome).toBe('discarded_stale');
    expect(await drafts(conversationId)).toHaveLength(0);
  });

  it('two overlapping generations: the older one finishing LAST cannot win', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'one', AT(-5 * MIN));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    stubGroq(async () => {
      calls += 1;
      if (calls === 1) await gate; // the first (older) generation stalls
      return answer({ reply: `answer ${calls}` });
    });
    const older = run(conversationId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await inbound(conversationId, 'two', AT(-1 * MIN));
    const newer = await run(conversationId);
    expect(newer.outcome).toBe('created');
    release();
    expect((await older).outcome).toBe('discarded_stale');
    const all = await drafts(conversationId);
    expect(all).toHaveLength(1);
    expect(all[0]?.trigger_message_ids).toHaveLength(2);
  });

  it('AI paused while the model was thinking: nothing is saved', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'hello', AT(-5 * MIN));
    stubGroq(async () => {
      await sql()`UPDATE settings SET ai_paused = true`;
      return answer();
    });
    expect((await run(conversationId)).outcome).toBe('skipped_ai_paused');
    expect(await drafts(conversationId)).toHaveLength(0);
  });
});

describe('kill switch and failures', () => {
  it('ai_paused: no draft and no model call, but the message is still in the inbox', async () => {
    const { conversationId } = await customer();
    await sql()`UPDATE settings SET ai_paused = true`;
    await inbound(conversationId, 'hello', AT(-5 * MIN));
    const stub = stubGroq(() => answer());
    expect((await run(conversationId)).outcome).toBe('skipped_ai_paused');
    expect(stub.requests).toHaveLength(0);
    expect(await count(sql(), 'drafts')).toBe(0);
    expect(await count(sql(), 'messages', `direction = 'inbound'`)).toBe(1);
  });

  it('invalid output twice -> one corrective retry, then a FAILED draft row (so the page can offer Regenerate); the conversation stays answerable', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'hello', AT(-5 * MIN));
    const { requests } = stubGroq(() => chatCompletion('{"intent":"gossip"}'));
    const result = await run(conversationId);

    expect(result.outcome).toBe('failed');
    expect(requests).toHaveLength(2);
    const [draft] = await drafts(conversationId);
    expect(draft).toMatchObject({ status: 'failed', content: '', intent: 'other' });
    expect(JSON.stringify(draft)).not.toContain('hello');
    expect(await count(sql(), 'notifications', `kind = 'alert:draft_generation_failed'`)).toBe(1);
    expect((await h.events()).some((e) => e.type === 'draft:updated' && e.payload.status === 'failed')).toBe(true);

    // the same failure again does not pile up rows
    await run(conversationId);
    expect(await drafts(conversationId)).toHaveLength(1);
    // and a reply by hand is still possible: the unanswered set is simply answered
    await seedMessage(sql(), conversationId, { direction: 'outbound', content: 'by hand', provenance: 'owner_manual', occurredAt: AT(-1 * MIN) });
    expect(await loadUnanswered(getDb(), conversationId)).toEqual([]);
  });

  it('a provider outage is RETRIED (thrown) until the last attempt, then a failed draft and one alert', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'hello', AT(-5 * MIN));
    stubGroq(() => apiError(503, 'overloaded'));
    await expect(run(conversationId, { finalAttempt: false })).rejects.toMatchObject({ name: 'AiProviderError' });
    expect(await drafts(conversationId)).toHaveLength(0);

    expect((await run(conversationId, { finalAttempt: true })).outcome).toBe('failed');
    expect((await drafts(conversationId))[0]?.status).toBe('failed');
    expect(await count(sql(), 'notifications', `kind = 'alert:draft_generation_failed'`)).toBe(1);
  });

  it('a rejected key (401) fails at once with the critical, once-a-day key alert', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'hello', AT(-5 * MIN));
    stubGroq(() => apiError(401, 'Invalid API Key'));
    expect((await run(conversationId)).outcome).toBe('failed');
    expect(await count(sql(), 'notifications', `kind = 'alert:ai_key_invalid'`)).toBe(1);
  });

  it('a draft that became stale while the model failed is not stored as a failure', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'hello', AT(-5 * MIN));
    stubGroq(async () => {
      await inbound(conversationId, 'more', AT(-1 * MIN));
      return chatCompletion('garbage');
    });
    expect((await run(conversationId)).outcome).toBe('failed');
    expect(await drafts(conversationId)).toHaveLength(0);
  });
});

describe('what the draft carries', () => {
  it('noReplyNeeded is stored but never announced', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'ok thanks', AT(-5 * MIN));
    stubGroq(() => answer({ noReplyNeeded: true, reply: '🙏' }));
    const result = await run(conversationId);
    expect(result.outcome).toBe('no_reply_needed');
    expect((await drafts(conversationId))[0]).toMatchObject({ status: 'pending', no_reply_needed: true });
    expect((await h.events()).filter((e) => e.type === 'draft:ready')).toHaveLength(0);
  });

  it('missing facts: a bare placeholder gets a generic entry; named facts without a placeholder are flagged `missing_facts_unmarked`', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'price?', AT(-5 * MIN));
    stubGroq(() => answer({ reply: 'It costs [[price?]]' }));
    await run(conversationId);
    expect((await drafts(conversationId))[0]?.missing_facts).toEqual(['A detail the reply still needs']);

    await sql()`DELETE FROM drafts`;
    vi.unstubAllGlobals();
    stubGroq(() => answer({ reply: 'It is 50k', missingFacts: ['the price'] }));
    await run(conversationId);
    expect((await drafts(conversationId))[0]?.risk_flags).toContain('missing_facts_unmarked');
  });

  it('records which style guide and which examples it used', async () => {
    const { conversationId } = await customer();
    await sql()`INSERT INTO style_guides (id, version, content, source_message_count, is_active) VALUES (gen_random_uuid(), 4, ${sql().json({ tone: 't', sentenceLength: 's', punctuationAndCase: 'p', emojiUsage: 'e', languageMixing: 'l', greetingsAndSignoffs: [], vocabulary: [], commonPhrases: [], structuralPatterns: [], forbiddenPatterns: [] })}, 50, true)`;
    const other = await seedConversation(sql(), await seedContact(sql(), { phone: '+256711000222', name: 'Brian' }), { status: 'resolved' });
    await seedMessage(sql(), other, { direction: 'inbound', content: 'how much?', occurredAt: AT(-30 * 24 * HOUR) });
    const example = await seedMessage(sql(), other, { direction: 'outbound', content: 'fifty dear', provenance: 'imported', occurredAt: AT(-30 * 24 * HOUR + MIN) });
    await inbound(conversationId, 'how much is the dress', AT(-5 * MIN));
    stubGroq(() => answer());
    await run(conversationId);
    const [draft] = await drafts(conversationId);
    expect(draft?.style_guide_version).toBe(4);
    expect(draft?.fewshot_message_ids).toEqual([example]);
  });

  it('cold start (no guide, no examples) still produces a draft', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'hello', AT(-5 * MIN));
    const { requests } = stubGroq(() => answer());
    expect((await run(conversationId)).outcome).toBe('created');
    expect(JSON.stringify(requests[0]?.body?.messages)).toContain('Write briefly, warmly, and plainly.');
  });
});

describe('older drafts', () => {
  it('a draft written for different messages is superseded when the new one is saved (belt and braces: ingest normally does it first)', async () => {
    const { conversationId } = await customer();
    const m1 = await inbound(conversationId, 'first', AT(-5 * MIN));
    await sql()`INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status) VALUES (gen_random_uuid(), ${conversationId}, ${sql().array([m1])}::uuid[], 'old', 'old', 'question', 'a', 'm', 'p', 'pending')`;
    await inbound(conversationId, 'second', AT(-2 * MIN)); // (the draft was NOT superseded: a missed ingest step)
    stubGroq(() => answer({ reply: 'new' }));
    await run(conversationId);
    expect((await drafts(conversationId)).map((d) => [d.content, d.status])).toEqual([['old', 'superseded'], ['new', 'pending']]);
  });
});

describe('"draft ready" on the owner’s phone', () => {
  const tg = () => jsonResponse({ ok: true, result: { message_id: 1 } });
  const ready = async (conversationId: string, over: { now?: Date } = {}) => {
    const [draft] = await sql()<{ id: string }[]>`SELECT id FROM drafts WHERE conversation_id = ${conversationId} ORDER BY created_at DESC LIMIT 1`;
    return notifyDraftReady(getDb(), { conversationId, draftId: draft?.id ?? '', now: over.now ?? NOW });
  };

  it('a draft that needs a decision buzzes once, with a link and NO name, number or message text; noReplyNeeded never does', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'SECRET-CUSTOMER-TEXT price?', AT(-5 * MIN));
    const net = stubNetwork({ groq: () => answer({ reply: 'SECRET-DRAFT-TEXT 50k' }), telegram: tg });
    expect((await run(conversationId)).outcome).toBe('created');
    expect(net.telegram).toHaveLength(1);
    const text = String(net.telegram[0]?.body.text);
    expect(text).toMatch(/draft reply is ready/);
    expect(text).toContain('http://localhost:3000/approvals?d=');
    for (const secret of ['SECRET', 'Amina', FIXTURE.amina.wa]) expect(text).not.toContain(secret);

    await sql()`DELETE FROM drafts`;
    await sql()`DELETE FROM notifications`;
    const quiet = stubNetwork({ groq: () => answer({ noReplyNeeded: true, reply: '🙏' }), telegram: tg });
    expect((await run(conversationId)).outcome).toBe('no_reply_needed');
    expect(quiet.telegram).toHaveLength(0);
  });

  it('is throttled: one per conversation per 10 minutes', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'q', AT(-5 * MIN));
    const net = stubNetwork({ groq: () => answer(), telegram: tg });
    await run(conversationId);
    expect(await ready(conversationId)).toBe('throttled');
    expect(await ready(conversationId, { now: new Date(NOW.getTime() + 11 * MIN) })).toBe('sent');
    expect(net.telegram).toHaveLength(2);
  });

  it('turns into ONE digest when more than 5 drafts are waiting', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'q', AT(-5 * MIN));
    const net = stubNetwork({ groq: () => answer(), telegram: tg });
    await run(conversationId);
    const waitingDraft = async (i: number, noReply: boolean) => {
      const c = await seedConversation(sql(), await seedContact(sql(), { phone: `+25670000${1000 + i}` }), { status: 'waiting_on_me' });
      await sql()`INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status, no_reply_needed) VALUES (gen_random_uuid(), ${c}, '{}', 'x', 'x', 'question', 'a', 'm', 'p', 'pending', ${noReply})`;
    };
    // 3 "no reply needed" drafts must NOT count toward the digest: 5 real drafts in all (the generated one + 4) is still individual notices
    for (let i = 0; i < 3; i += 1) await waitingDraft(i, true);
    for (let i = 3; i < 7; i += 1) await waitingDraft(i, false);
    await sql()`DELETE FROM notifications`;
    expect(await ready(conversationId)).toBe('sent');
    expect(String(net.telegram.at(-1)?.body.text)).toMatch(/draft reply is ready/);
    // two more real ones: 7 drafts are waiting
    for (let i = 7; i < 9; i += 1) await waitingDraft(i, false);
    await sql()`DELETE FROM notifications`;
    expect(await ready(conversationId)).toBe('sent');
    expect(String(net.telegram.at(-1)?.body.text)).toMatch(/7 drafts are waiting/);
    expect(await ready(conversationId)).toBe('throttled');
    const other = (await sql()<{ conversation_id: string }[]>`SELECT conversation_id FROM drafts WHERE content = 'x' LIMIT 1`)[0]?.conversation_id ?? '';
    expect(await notifyDraftReady(getDb(), { conversationId: other, draftId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', now: NOW })).toBe('throttled');
  });

  it('is silent during quiet hours and when the owner switched Telegram off; a failed send gives the slot back', async () => {
    const { conversationId } = await customer();
    await inbound(conversationId, 'q', AT(-5 * MIN));
    let fail = false;
    const net = stubNetwork({ groq: () => answer(), telegram: () => (fail ? jsonResponse({ ok: false, error_code: 400, description: 'bad' }, 400) : tg()) });
    await sql()`UPDATE settings SET notify_telegram = false`;
    await run(conversationId);
    expect(net.telegram).toHaveLength(0);
    await sql()`UPDATE settings SET notify_telegram = true`;
    expect(await ready(conversationId, { now: new Date('2026-10-05T19:30:00Z') })).toBe('silenced'); // 22:30 in Kampala
    fail = true;
    expect(await ready(conversationId)).toBe('failed');
    fail = false;
    expect(await ready(conversationId)).toBe('sent'); // the failed attempt did not burn the 10-minute slot
  });
});

describe('voice notes', () => {
  it('waits for a pending transcript (re-queues itself a few seconds later), then drafts anyway with unreadable_media', async () => {
    const { conversationId } = await customer();
    const voice = await inbound(conversationId, '[Voice message]', AT(-5 * MIN), { type: 'audio' });
    await sql()`UPDATE messages SET transcription_status = 'pending' WHERE id = ${voice}`;
    const stub = stubGroq(() => answer());

    const waiting = await run(conversationId);
    expect(waiting.outcome).toBe('waiting_for_transcription');
    expect(stub.requests).toHaveLength(0);
    const [job] = await draftQueue.getDelayed();
    expect(job?.data).toEqual({ conversationId, waits: 1 });
    expect(job?.opts.delay).toBe(8000);

    const patient = await run(conversationId, { waits: MAX_WAITS });
    expect(patient.outcome).toBe('created');
    expect((await drafts(conversationId))[0]?.risk_flags).toContain('unreadable_media');
  });

  it('an unreliable transcript is flagged unreadable_media without waiting', async () => {
    const { conversationId } = await customer();
    const voice = await inbound(conversationId, '[Voice message: the automatic transcript was unreliable]', AT(-5 * MIN), { type: 'audio' });
    await sql()`UPDATE messages SET transcription_status = 'low_confidence' WHERE id = ${voice}`;
    stubGroq(() => answer());
    expect((await run(conversationId)).outcome).toBe('created');
    expect((await drafts(conversationId))[0]?.risk_flags).toContain('unreadable_media');
  });
});

describe('the lost-job safety net (alerts-scan)', () => {
  async function stuck(): Promise<{ conversationId: string; messageId: string }> {
    const { conversationId } = await customer();
    await sql()`UPDATE conversations SET window_expires_at = ${AT(10 * HOUR)}`;
    const messageId = await inbound(conversationId, 'nobody drafted for me', AT(-30 * MIN));
    await sql()`UPDATE messages SET created_at = ${AT(-30 * MIN)} WHERE id = ${messageId}`;
    return { conversationId, messageId };
  }

  it('drafts once more for a customer message nobody drafted for, exactly once', async () => {
    const { conversationId } = await stuck();
    const first = await scanSends({ now: NOW, draftQueue });
    expect(first.draftsRequeued).toBe(1);
    const [job] = await draftQueue.getDelayed();
    expect(job?.data).toEqual({ conversationId });
    await draftQueue.obliterate({ force: true });
    expect((await scanSends({ now: NOW, draftQueue })).draftsRequeued).toBe(0);
  });

  it('leaves a young message, a covered one, an answered one, a closed window, and everything while AI is paused', async () => {
    const { conversationId, messageId } = await stuck();
    await sql()`UPDATE messages SET created_at = ${AT(-2 * MIN)} WHERE id = ${messageId}`;
    expect((await scanSends({ now: NOW, draftQueue })).draftsRequeued).toBe(0);
    await sql()`UPDATE messages SET created_at = ${AT(-30 * MIN)} WHERE id = ${messageId}`;

    await sql()`UPDATE settings SET ai_paused = true`;
    expect((await scanSends({ now: NOW, draftQueue })).draftsRequeued).toBe(0);
    await sql()`UPDATE settings SET ai_paused = false`;

    await sql()`UPDATE conversations SET window_expires_at = ${AT(-HOUR)}`;
    expect((await scanSends({ now: NOW, draftQueue })).draftsRequeued).toBe(0);
    await sql()`UPDATE conversations SET window_expires_at = ${AT(10 * HOUR)}`;

    await sql()`INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status) VALUES (gen_random_uuid(), ${conversationId}, ${sql().array([messageId])}::uuid[], 'x', 'x', 'question', 'a', 'm', 'p', 'rejected')`;
    expect((await scanSends({ now: NOW, draftQueue })).draftsRequeued).toBe(0);
  });
});
