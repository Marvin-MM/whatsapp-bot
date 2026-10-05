import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftContextError, generateDraftFromContext, loadDraftContext } from '@/lib/ai/draft';
import { AiOutputError } from '@/lib/ai/errors';
import { resetModelProvider } from '@/lib/ai/models';
import { resetStrictCache } from '@/lib/ai/run';
import { getDb } from '@/lib/db';
import { chatCompletion, stubGroq } from '../helpers/groq';
import { seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();

const NOW = new Date('2026-10-05T11:30:00Z');
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const at = (ms: number) => new Date(NOW.getTime() + ms);

beforeEach(() => {
  resetStrictCache();
  resetModelProvider();
});
afterEach(() => vi.unstubAllGlobals());

const guide = {
  tone: 'Warm', sentenceLength: 'Short', punctuationAndCase: 'lowercase', emojiUsage: '🙏', languageMixing: 'English', greetingsAndSignoffs: ['Hi dear'], vocabulary: [], commonPhrases: [], structuralPatterns: [], forbiddenPatterns: ['Certainly!'],
};

async function seedWorld(): Promise<{ current: string; other: string; burst: string[] }> {
  await sql()`INSERT INTO settings (id, owner_name, business_name, business_profile) VALUES (1, 'Marvin', 'agent_47', ${'## Prices\n- Blue dress: UGX 50,000'}) ON CONFLICT (id) DO UPDATE SET owner_name = 'Marvin', business_name = 'agent_47', business_profile = '## Prices\n- Blue dress: UGX 50,000'`;
  await sql()`INSERT INTO style_guides (id, version, content, source_message_count, is_active, activated_at) VALUES (gen_random_uuid(), 3, ${sql().json(guide)}, 80, true, now())`;

  // another customer's history: the source of examples
  const otherContact = await seedContact(sql(), { phone: '+256700000111', name: 'Brian' });
  const other = await seedConversation(sql(), otherContact, { status: 'resolved' });
  for (let i = 0; i < 4; i += 1) {
    await seedMessage(sql(), other, { direction: 'inbound', content: `How much is item ${i}?`, occurredAt: at(-(40 - i * 5) * DAY) });
    await seedMessage(sql(), other, { direction: 'outbound', content: `Item ${i} is cheap dear`, provenance: 'imported', occurredAt: at(-(40 - i * 5) * DAY + MIN) });
  }

  const contact = await seedContact(sql(), { phone: '+256700123456', name: 'Amina' });
  const current = await seedConversation(sql(), contact, { summary: 'Amina wants a blue dress in M.' });
  await seedMessage(sql(), current, { direction: 'inbound', content: 'Hello', occurredAt: at(-2 * DAY) });
  await seedMessage(sql(), current, { direction: 'outbound', content: 'Hi dear', provenance: 'owner_manual', occurredAt: at(-2 * DAY + MIN) });
  await seedMessage(sql(), current, { direction: 'inbound', type: 'reaction', content: '👍', occurredAt: at(-2 * DAY + 2 * MIN) });
  await seedMessage(sql(), current, { direction: 'outbound', content: 'never delivered', provenance: 'owner_manual', status: 'failed', occurredAt: at(-2 * DAY + 3 * MIN) });
  const gone = await seedMessage(sql(), current, { direction: 'inbound', content: 'deleted secret', occurredAt: at(-2 * DAY + 4 * MIN) });
  await sql()`UPDATE messages SET deleted_at = now() WHERE id = ${gone}`;
  const b1 = await seedMessage(sql(), current, { direction: 'inbound', content: 'Is the blue dress in M?', occurredAt: at(-3 * MIN) });
  const b2 = await seedMessage(sql(), current, { direction: 'inbound', content: 'and how much', occurredAt: at(-2 * MIN) });
  return { current, other, burst: [b2, b1] };
}

describe('loadDraftContext', () => {
  it('assembles the owner, profile, style guide, summary, history, burst and examples', async () => {
    const { current, burst } = await seedWorld();
    const loaded = await loadDraftContext(getDb(), { conversationId: current, burstMessageIds: burst, now: NOW });
    const { context } = loaded;

    expect(context).toMatchObject({ ownerName: 'Marvin', businessName: 'agent_47', ownerTimezone: 'Africa/Kampala', summary: 'Amina wants a blue dress in M.' });
    expect(context.businessProfile).toContain('Blue dress: UGX 50,000');
    expect(context.styleGuide?.tone).toBe('Warm');
    expect(loaded.styleGuideVersion).toBe(3);
    // the burst is in time order whatever order the ids came in
    expect(context.burst.map((line) => line.text)).toEqual(['Is the blue dress in M?', 'and how much']);
    // history: before the burst, no reaction, no failed send, no deleted message
    expect(context.history.map((line) => `${line.from}: ${line.text}`)).toEqual(['customer: Hello', 'owner: Hi dear']);
    // examples: the other customer's history, plus this conversation's OWN older exchange (older than 24 h, so not already in the prompt)
    expect(context.examples.some((example) => example.reply.endsWith('cheap dear'))).toBe(true);
    expect(context.examples.every((example) => example.reply.endsWith('cheap dear') || example.reply === 'Hi dear')).toBe(true);
    expect(loaded.fewshotMessageIds).toHaveLength(context.examples.length);
    expect(loaded.unreadableMedia).toBe(false);
  });

  it('the evaluation can leave the stored summary out, and exclude held-out replies from the examples', async () => {
    const { current, other, burst } = await seedWorld();
    const [held] = await sql()<{ id: string }[]>`SELECT id FROM messages WHERE conversation_id = ${other} AND content = 'Item 2 is cheap dear'`;
    const loaded = await loadDraftContext(getDb(), { conversationId: current, burstMessageIds: burst, now: NOW, useSummary: false, excludeReplyIds: held ? [held.id] : [] });
    expect(loaded.context.summary).toBeNull();
    expect(loaded.context.examples.map((e) => e.reply)).not.toContain('Item 2 is cheap dear');
  });

  it('shows at most the last 15 messages before the burst, oldest first', async () => {
    const { current, burst } = await seedWorld();
    for (let i = 0; i < 20; i += 1) await seedMessage(sql(), current, { direction: i % 2 ? 'outbound' : 'inbound', content: `filler ${i}`, provenance: 'owner_manual', occurredAt: at(-(100 - i) * MIN) });
    const { context } = await loadDraftContext(getDb(), { conversationId: current, burstMessageIds: burst, now: NOW });
    expect(context.history).toHaveLength(15);
    expect(context.history.at(-1)?.text).toBe('filler 19');
    expect(context.history[0]?.text).toBe('filler 5');
  });

  it('flags an unreliable voice note as unreadable media', async () => {
    const { current } = await seedWorld();
    const voice = await seedMessage(sql(), current, { direction: 'inbound', type: 'audio', content: '[Voice message]', occurredAt: at(-MIN) });
    await sql()`UPDATE messages SET transcription_status = 'low_confidence' WHERE id = ${voice}`;
    const loaded = await loadDraftContext(getDb(), { conversationId: current, burstMessageIds: [voice], now: NOW });
    expect(loaded.unreadableMedia).toBe(true);
  });

  it('works on a cold start: no settings, no style guide, no examples', async () => {
    const contact = await seedContact(sql(), { phone: '+256700999999' });
    const conv = await seedConversation(sql(), contact);
    const m = await seedMessage(sql(), conv, { direction: 'inbound', content: 'Hello?', occurredAt: at(-MIN) });
    const { context, styleGuideVersion, fewshotMessageIds } = await loadDraftContext(getDb(), { conversationId: conv, burstMessageIds: [m], now: NOW });
    expect(context).toMatchObject({ ownerName: '', businessName: '', businessProfile: '', styleGuide: null, examples: [], history: [] });
    expect(styleGuideVersion).toBeNull();
    expect(fewshotMessageIds).toEqual([]);
  });

  it('refuses a burst with nothing to answer, ids from another conversation, outbound ids, deleted messages and unknown conversations', async () => {
    const { current, other } = await seedWorld();
    const foreign = (await sql()<{ id: string }[]>`SELECT id FROM messages WHERE conversation_id = ${other} AND direction = 'inbound' LIMIT 1`)[0]?.id ?? '';
    const outbound = (await sql()<{ id: string }[]>`SELECT id FROM messages WHERE conversation_id = ${current} AND direction = 'outbound' LIMIT 1`)[0]?.id ?? '';
    const deleted = (await sql()<{ id: string }[]>`SELECT id FROM messages WHERE conversation_id = ${current} AND deleted_at IS NOT NULL`)[0]?.id ?? '';
    for (const ids of [[], [foreign], [outbound], [deleted]]) {
      await expect(loadDraftContext(getDb(), { conversationId: current, burstMessageIds: ids, now: NOW })).rejects.toMatchObject({ code: 'no_burst' });
    }
    await expect(loadDraftContext(getDb(), { conversationId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', burstMessageIds: [foreign], now: NOW })).rejects.toBeInstanceOf(DraftContextError);
  });
});

describe('generateDraftFromContext', () => {
  const answer = { intent: 'question', analysis: 'Asks size and price.', missingFacts: [], riskFlags: [], noReplyNeeded: false, reply: 'Yes dear, UGX 50,000 🙏' };

  it('sends the instructions and the user turn, validates the answer, and records a draft run', async () => {
    const { current, burst } = await seedWorld();
    const loaded = await loadDraftContext(getDb(), { conversationId: current, burstMessageIds: burst, now: NOW });
    const { requests } = stubGroq(() => chatCompletion(JSON.stringify(answer)));
    const result = await generateDraftFromContext(getDb(), loaded);

    expect(result.output).toMatchObject({ intent: 'question', reply: 'Yes dear, UGX 50,000 🙏' });
    expect(result).toMatchObject({ model: 'test-draft-model', promptVersion: 'draft-v1', missingFactsUnmarked: false });
    const body = requests[0]?.body as { messages: Array<{ role: string; content: string }>; temperature?: number; reasoning_effort?: string };
    expect(body.temperature).toBe(0.4);
    expect(body.reasoning_effort).toBeUndefined(); // the test model is not a reasoning model
    const [system, user] = [body.messages[0]?.content ?? '', body.messages.at(-1)?.content ?? ''];
    expect(system).toContain('You draft WhatsApp replies that Marvin will send to customers of agent_47');
    expect(system).toContain('Blue dress: UGX 50,000');
    expect(system).toContain('<example stage=');
    expect(user).toContain('<conversation_summary>Amina wants a blue dress in M.</conversation_summary>');
    expect(user).toContain('Customer: Is the blue dress in M?');
    expect(user).not.toContain('deleted secret');
    expect((await sql()<{ purpose: string; prompt_version: string }[]>`SELECT purpose, prompt_version FROM ai_runs`)).toEqual([{ purpose: 'draft', prompt_version: 'draft-v1' }]);
  });

  it('adds unreadable_media from the context, a generic missing fact for a bare placeholder, and flags unmarked missing facts', async () => {
    const { current } = await seedWorld();
    const voice = await seedMessage(sql(), current, { direction: 'inbound', type: 'audio', content: '[Voice message]', occurredAt: at(-MIN) });
    await sql()`UPDATE messages SET transcription_status = 'failed' WHERE id = ${voice}`;
    const loaded = await loadDraftContext(getDb(), { conversationId: current, burstMessageIds: [voice], now: NOW });

    stubGroq(() => chatCompletion(JSON.stringify({ ...answer, reply: 'It costs [[price?]]' })));
    const first = await generateDraftFromContext(getDb(), loaded, { purpose: 'eval' });
    expect(first.output.riskFlags).toContain('unreadable_media');
    expect(first.output.missingFacts).toEqual(['A detail the reply still needs']);
    expect((await sql()<{ purpose: string }[]>`SELECT purpose FROM ai_runs ORDER BY created_at DESC LIMIT 1`)[0]?.purpose).toBe('eval');

    vi.unstubAllGlobals();
    stubGroq(() => chatCompletion(JSON.stringify({ ...answer, missingFacts: ['the price'], reply: 'It is 50k' })));
    expect((await generateDraftFromContext(getDb(), loaded)).missingFactsUnmarked).toBe(true);
  });

  it('a model that keeps returning garbage throws AiOutputError (after the one corrective retry)', async () => {
    const { current, burst } = await seedWorld();
    const loaded = await loadDraftContext(getDb(), { conversationId: current, burstMessageIds: burst, now: NOW });
    const { requests } = stubGroq(() => chatCompletion('{"intent": "gossip"}'));
    await expect(generateDraftFromContext(getDb(), loaded)).rejects.toBeInstanceOf(AiOutputError);
    expect(requests).toHaveLength(2);
  });
});
