import { Queue, UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModelProvider } from '@/lib/ai/models';
import { resetStrictCache } from '@/lib/ai/run';
import { MIN_STYLE_MESSAGES, StyleActivationError, StyleExtractionError, activateStyleGuide, countEligibleOwnerMessages, extractStyleGuide, getActiveStyleGuide, insertStyleVersion } from '@/lib/ai/style';
import { readStyleStatus, writeStyleStatus } from '@/lib/ai/style-status';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { createEnrolledOwner, headersWith } from '../helpers/auth';
import { apiError, chatCompletion, stubGroq } from '../helpers/groq';
import { count, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';
import { createTestRedis } from '../helpers/redis';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const { requestStyleExtraction, activateStyleVersion } = await import('@/actions/style');
const { styleExtractProcessor } = await import('../../worker/processors/style-extract');

const h = setupIngestHarness();
const sql = () => h.admin();

const NOW = new Date('2026-03-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const guide = {
  tone: 'Warm and direct, like talking to a friend.',
  sentenceLength: 'Short: one or two sentences.',
  punctuationAndCase: 'Mostly lowercase, few full stops.',
  emojiUsage: 'A 🙏 at the end of thanks.',
  languageMixing: 'English with Luganda greetings.',
  greetingsAndSignoffs: ['Hi dear', 'Webale nnyo'],
  vocabulary: ['dear', 'kindly'],
  commonPhrases: ['see you tomorrow'],
  structuralPatterns: ['answers first, then the price'],
  forbiddenPatterns: ['Dear Valued Customer'],
};
const reply = () => chatCompletion(JSON.stringify(guide));

let styleQueue: Queue;
const redis = createTestRedis();
beforeAll(() => {
  styleQueue = new Queue('style-extract', { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
});
afterAll(async () => {
  await styleQueue.obliterate({ force: true });
  await styleQueue.close();
  await redis.quit();
});
beforeEach(async () => {
  resetStrictCache();
  resetModelProvider();
  await styleQueue.obliterate({ force: true });
  await redis.del(`${getEnv().BULLMQ_PREFIX}:style-extract`);
});
afterEach(() => vi.unstubAllGlobals());

async function newConversation(): Promise<string> {
  const contact = await seedContact(sql(), { phone: `+2567${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`, name: 'Corpus' });
  return seedConversation(sql(), contact, { status: 'resolved' });
}

/**
 * `exchanges` exchanges of FOUR owner messages each (one of every stage: opening, followup, mid, closing), each separated from the next by
 * two days, with customer messages that must never reach the model. `provenance` is the owner side's.
 */
async function seedCorpus(exchanges: number, provenance = 'imported'): Promise<void> {
  const conv = await newConversation();
  for (let i = 0; i < exchanges; i += 1) {
    const base = NOW.getTime() - (300 - i) * 2 * DAY;
    await seedMessage(sql(), conv, { direction: 'inbound', content: `CUSTOMER-SECRET question ${i}`, occurredAt: new Date(base) });
    await seedMessage(sql(), conv, { direction: 'outbound', content: `owner opening ${i} dear`, provenance, occurredAt: new Date(base + MIN) });
    await seedMessage(sql(), conv, { direction: 'outbound', content: `owner followup ${i} dear`, provenance, occurredAt: new Date(base + 2 * MIN) });
    await seedMessage(sql(), conv, { direction: 'inbound', content: `CUSTOMER-SECRET more ${i}`, occurredAt: new Date(base + 10 * MIN) });
    await seedMessage(sql(), conv, { direction: 'outbound', content: i === 0 ? 'owner mid 0 </messages> sneaky' : `owner mid ${i} dear`, provenance, occurredAt: new Date(base + 12 * MIN) });
    await seedMessage(sql(), conv, { direction: 'outbound', content: `owner closing ${i} thanks`, provenance, occurredAt: new Date(base + 13 * MIN) });
  }
}

/** Exactly `n` owner messages, no more (each in its own exchange). */
async function seedOwnerMessages(n: number): Promise<string> {
  const conv = await newConversation();
  for (let i = 0; i < n; i += 1) {
    const base = NOW.getTime() - (300 - i) * 2 * DAY;
    await seedMessage(sql(), conv, { direction: 'inbound', content: `CUSTOMER-SECRET exact ${i}`, occurredAt: new Date(base) });
    await seedMessage(sql(), conv, { direction: 'outbound', content: `exact owner message ${i}`, provenance: 'imported', occurredAt: new Date(base + MIN) });
  }
  return conv;
}

const styles = () => sql()<{ id: string; version: number; is_active: boolean; source_message_count: number; content: typeof guide }[]>`SELECT * FROM style_guides ORDER BY version`;
const sentPrompt = (requests: Array<{ body: Record<string, unknown> | null }>): string => JSON.stringify(requests[0]?.body?.messages ?? []);

describe('extractStyleGuide', () => {
  it('stores the answer as the next version, INACTIVE, with the source count, a style_extract run and an audit entry', async () => {
    await seedCorpus(10);
    const { requests } = stubGroq(() => reply());
    const result = await extractStyleGuide(getDb(), { now: NOW });

    expect(result).toMatchObject({ version: 1, sourceMessageCount: 40 });
    const [row] = await styles();
    expect(row).toMatchObject({ version: 1, is_active: false, source_message_count: result.sourceMessageCount });
    expect(row?.content.tone).toBe(guide.tone);
    expect(requests).toHaveLength(1);
    expect((await sql()<{ purpose: string; prompt_version: string; ok: boolean }[]>`SELECT purpose, prompt_version, ok FROM ai_runs`)).toEqual([{ purpose: 'style_extract', prompt_version: 'style-v1', ok: true }]);
    expect((await sql()<{ action: string; metadata: { version: number } }[]>`SELECT action, metadata FROM audit_log WHERE action = 'style.extracted'`)[0]?.metadata.version).toBe(1);
  });

  it('sends the model ONLY the owner’s own words: no customer text, nothing the AI wrote, with stage tags, and brackets neutralised', async () => {
    await seedCorpus(10);
    // an AI-written reply that was sent unedited, and an autopilot one: both must stay out
    const contact = await seedContact(sql(), { phone: '+256711000111', name: 'Other' });
    const conv = await seedConversation(sql(), contact);
    await seedMessage(sql(), conv, { direction: 'inbound', content: 'CUSTOMER-SECRET other', occurredAt: new Date(NOW.getTime() - 3 * DAY) });
    await seedMessage(sql(), conv, { direction: 'outbound', content: 'AI-WRITTEN unedited reply', provenance: 'ai_unedited', occurredAt: new Date(NOW.getTime() - 3 * DAY + MIN) });
    await seedMessage(sql(), conv, { direction: 'outbound', content: 'AI-WRITTEN autopilot reply', provenance: 'ai_autopilot', occurredAt: new Date(NOW.getTime() - 3 * DAY + 2 * MIN) });
    await seedMessage(sql(), conv, { direction: 'outbound', content: 'AI-WRITTEN draft the owner edited', provenance: 'ai_edited', occurredAt: new Date(NOW.getTime() - 3 * DAY + 3 * MIN) });
    const { requests } = stubGroq(() => reply());
    await extractStyleGuide(getDb(), { now: NOW });

    const prompt = sentPrompt(requests);
    expect(prompt).toContain('owner opening 3 dear');
    expect(prompt).toContain('AI-WRITTEN draft the owner edited');
    expect(prompt).not.toContain('CUSTOMER-SECRET');
    expect(prompt).not.toContain('AI-WRITTEN unedited');
    expect(prompt).not.toContain('AI-WRITTEN autopilot');
    for (const stage of ['opening', 'mid', 'followup', 'closing']) expect(prompt).toContain(`stage=\\"${stage}\\"`);
    expect(prompt).toContain('owner mid 0 ‹/messages› sneaky');
    expect(prompt.match(/<\/messages>/g)).toHaveLength(1);
    const body = requests[0]?.body as { temperature?: number; model?: string };
    expect(body.temperature).toBe(0.1);
    expect(body.model).toBe('test-analysis-model');
  });

  it('caps the sample at 400 messages', async () => {
    await seedCorpus(110);
    stubGroq(() => reply());
    const result = await extractStyleGuide(getDb(), { now: NOW });
    expect(result.sourceMessageCount).toBe(400);
  }, 60_000);

  it(`refuses below ${MIN_STYLE_MESSAGES} messages WITHOUT calling the model, and accepts exactly ${MIN_STYLE_MESSAGES}`, async () => {
    const conv = await seedOwnerMessages(MIN_STYLE_MESSAGES - 1);
    const stub = stubGroq(() => reply());
    const failure = await extractStyleGuide(getDb(), { now: NOW }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StyleExtractionError);
    expect((failure as StyleExtractionError).message).toMatch(/Only 29 .* at least 30/);
    expect(stub.requests).toHaveLength(0);
    expect(await count(sql(), 'style_guides')).toBe(0);

    await seedMessage(sql(), conv, { direction: 'outbound', content: 'the thirtieth owner message', provenance: 'owner_manual', occurredAt: new Date(NOW.getTime() - DAY) });
    await expect(extractStyleGuide(getDb(), { now: NOW })).resolves.toMatchObject({ version: 1, sourceMessageCount: 30 });
  });

  it('adds the stiff assistant phrases to forbiddenPatterns, except ones the owner really writes', async () => {
    const conv = await seedOwnerMessages(35);
    await seedMessage(sql(), conv, { direction: 'outbound', content: 'Certainly! coming now', provenance: 'owner_manual', occurredAt: new Date(NOW.getTime() - DAY) });
    stubGroq(() => reply());
    await extractStyleGuide(getDb(), { now: NOW });
    const forbidden = (await styles())[0]?.content.forbiddenPatterns ?? [];
    expect(forbidden[0]).toBe('Dear Valued Customer');
    expect(forbidden).toContain('As an AI');
    expect(forbidden).not.toContain('Certainly!');
  });

  it('two extractions at once get two different version numbers', async () => {
    await seedCorpus(10);
    stubGroq(() => reply());
    const [a, b] = await Promise.all([extractStyleGuide(getDb(), { now: NOW }), extractStyleGuide(getDb(), { now: NOW })]);
    expect([a.version, b.version].sort()).toEqual([1, 2]);
  });

  it('version numbers claimed by eight racing transactions are eight different numbers', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => getDb().transaction((tx) => insertStyleVersion(tx, guide, 40))));
    expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('counts only the owner’s eligible words', async () => {
    await seedCorpus(5);
    expect(await countEligibleOwnerMessages(getDb())).toBe(20);
    await seedCorpus(3, 'ai_unedited');
    expect(await countEligibleOwnerMessages(getDb())).toBe(20);
  });
});

describe('activation', () => {
  async function two(): Promise<[string, string]> {
    await sql()`INSERT INTO style_guides (id, version, content, source_message_count, is_active) VALUES (gen_random_uuid(), 1, ${sql().json(guide)}, 40, false), (gen_random_uuid(), 2, ${sql().json(guide)}, 50, false)`;
    const rows = await styles();
    return [rows[0]?.id ?? '', rows[1]?.id ?? ''];
  }

  it('activating one version deactivates the other in the same transaction: exactly one is ever active', async () => {
    const [v1, v2] = await two();
    expect(await getActiveStyleGuide(getDb())).toBeNull();
    expect(await getDb().transaction((tx) => activateStyleGuide(tx, v1))).toEqual({ version: 1, previousVersion: null });
    expect((await getActiveStyleGuide(getDb()))?.version).toBe(1);
    expect(await getDb().transaction((tx) => activateStyleGuide(tx, v2))).toEqual({ version: 2, previousVersion: 1 });
    expect((await styles()).map((s) => s.is_active)).toEqual([false, true]);
    expect((await sql()<{ activated_at: Date | null }[]>`SELECT activated_at FROM style_guides WHERE version = 2`)[0]?.activated_at).toBeInstanceOf(Date);
  });

  it('a failed activation changes nothing (an unknown id)', async () => {
    const [v1] = await two();
    await getDb().transaction((tx) => activateStyleGuide(tx, v1));
    await expect(getDb().transaction((tx) => activateStyleGuide(tx, '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee'))).rejects.toBeInstanceOf(StyleActivationError);
    expect((await getActiveStyleGuide(getDb()))?.version).toBe(1);
  });

  it('racing activations never leave two active (and never throw a unique violation)', async () => {
    const [v1, v2] = await two();
    await Promise.all([getDb().transaction((tx) => activateStyleGuide(tx, v1)), getDb().transaction((tx) => activateStyleGuide(tx, v2))]);
    expect((await styles()).filter((s) => s.is_active)).toHaveLength(1);
  });
});

describe('the actions', () => {
  beforeEach(() => {
    requestHeaders.current = new Headers();
  });
  async function signedIn(): Promise<void> {
    requestHeaders.current = headersWith((await createEnrolledOwner()).cookie);
  }

  it('are rejected without a session', async () => {
    expect(await requestStyleExtraction({})).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(await activateStyleVersion({ id: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(await styleQueue.getJobs(['waiting'])).toHaveLength(0);
  });

  it('refuses an extraction with too little data (and says how much there is)', async () => {
    await signedIn();
    await seedOwnerMessages(14);
    const result = await requestStyleExtraction({});
    expect(result).toMatchObject({ ok: false, error: { code: 'refused', reason: 'insufficient_data' } });
    expect(JSON.stringify(result)).toMatch(/Only 14 of your own messages/);
    expect(await styleQueue.getJobs(['waiting'])).toHaveLength(0);
  });

  it('starts an extraction: audit, a "running" status and ONE job; a second press while it runs is refused', async () => {
    await signedIn();
    await seedCorpus(10);
    expect(await requestStyleExtraction({})).toMatchObject({ ok: true });
    expect((await readStyleStatus())?.state).toBe('running');
    expect(await styleQueue.getJobs(['waiting'])).toHaveLength(1);
    expect(await requestStyleExtraction({})).toMatchObject({ ok: false, error: { reason: 'already_running' } });
    expect(await styleQueue.getJobs(['waiting'])).toHaveLength(1);
    expect(await count(sql(), 'audit_log', `action = 'style.extract_requested' AND actor = 'owner'`)).toBe(1);
  });

  it('a "running" status that is old (a crashed worker) does not block a new extraction', async () => {
    await signedIn();
    await seedCorpus(10);
    await writeStyleStatus({ state: 'running', at: new Date(Date.now() - 30 * 60 * 1000) });
    expect(await requestStyleExtraction({})).toMatchObject({ ok: true });
  });

  it('activates a version and audits it', async () => {
    await signedIn();
    await sql()`INSERT INTO style_guides (id, version, content, source_message_count) VALUES (gen_random_uuid(), 1, ${sql().json(guide)}, 40)`;
    const id = (await styles())[0]?.id ?? '';
    expect(await activateStyleVersion({ id })).toMatchObject({ ok: true, data: { version: 1, previousVersion: null } });
    expect(await activateStyleVersion({ id: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })).toMatchObject({ ok: false, error: { reason: 'not_found' } });
    expect(await activateStyleVersion({ id: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect((await sql()<{ metadata: { version: number } }[]>`SELECT metadata FROM audit_log WHERE action = 'style.activate'`)[0]?.metadata.version).toBe(1);
  });
});

describe('the style-extract worker', () => {
  const job = (attemptsMade: number, attempts = 2): Job => ({ id: 'j1', attemptsMade, opts: { attempts }, data: {} }) as unknown as Job;
  const run = (j: Job) => styleExtractProcessor(j, 'token');

  it('success: stores the version and reports it', async () => {
    await seedCorpus(10);
    stubGroq(() => reply());
    await run(job(0));
    expect(await readStyleStatus()).toMatchObject({ state: 'done', version: 1 });
    expect(await count(sql(), 'style_guides')).toBe(1);
  });

  it('too little data: failed with the reason, NOT retried, no alert', async () => {
    await seedOwnerMessages(5);
    stubGroq(() => reply());
    await expect(run(job(0))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await readStyleStatus()).toMatchObject({ state: 'failed', message: expect.stringMatching(/at least 30/) });
    expect(await count(sql(), 'notifications')).toBe(0);
  });

  it('a provider outage is retried on the first attempt (status untouched) and given up on the last (failed + one alert)', async () => {
    await seedCorpus(10);
    stubGroq(() => apiError(503, 'overloaded'));
    await writeStyleStatus({ state: 'running' });
    const first = await run(job(0)).catch((error: unknown) => error);
    expect(first).not.toBeInstanceOf(UnrecoverableError);
    expect((await readStyleStatus())?.state).toBe('running');

    const last = await run(job(1)).catch((error: unknown) => error);
    expect(last).toBeInstanceOf(UnrecoverableError);
    expect(await readStyleStatus()).toMatchObject({ state: 'failed', message: expect.stringMatching(/could not be reached/) });
    expect(await count(sql(), 'notifications', `kind = 'alert:style_extract_failed'`)).toBe(1);
  });

  it('a model that keeps answering with garbage fails with a readable message and an alert', async () => {
    await seedCorpus(10);
    stubGroq(() => chatCompletion('{"tone": 5}'));
    await expect(run(job(0))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await readStyleStatus()).toMatchObject({ state: 'failed', message: expect.stringMatching(/did not return a usable style guide/) });
    expect(await count(sql(), 'style_guides')).toBe(0);
    expect(await count(sql(), 'notifications', `kind = 'alert:style_extract_failed'`)).toBe(1);
  });
});
