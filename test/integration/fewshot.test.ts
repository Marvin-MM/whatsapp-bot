import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { listPairs, selectFewShot } from '@/lib/ai/fewshot';
import { pairsCte } from '@/lib/ai/fewshot-sql';
import { type StageMessage, deriveStages } from '@/lib/ai/stages';
import { getDb } from '@/lib/db';
import { count, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sqlc = () => h.admin();

const NOW = new Date('2026-03-01T12:00:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

async function conversation(name: string): Promise<string> {
  const contact = await seedContact(sqlc(), { phone: `+2567${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`, name });
  return seedConversation(sqlc(), contact, { status: 'resolved' });
}
const inbound = (conv: string, content: string, when: Date) => seedMessage(sqlc(), conv, { direction: 'inbound', content, occurredAt: when });
const owner = (conv: string, content: string, when: Date, provenance = 'imported', extra: { type?: string; status?: string } = {}) =>
  seedMessage(sqlc(), conv, { direction: 'outbound', content, occurredAt: when, provenance, status: extra.status ?? 'sent', type: extra.type ?? 'text' });

describe('stage derivation: SQL and TypeScript agree', () => {
  // mulberry32: a tiny deterministic PRNG so a failure is reproducible
  function prng(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('matches on 60 random conversations full of boundary gaps, reactions and failed sends', async () => {
    const random = prng(20261005);
    const gaps = [0, 1, 1, 5 * MIN, 5 * MIN, 2 * HOUR, 23 * HOUR + 59 * MIN, 24 * HOUR, 24 * HOUR, 25 * HOUR, 3 * DAY];
    const expected = new Map<string, string>();

    for (let c = 0; c < 60; c += 1) {
      const conv = await conversation(`Random ${c}`);
      let t = NOW.getTime() - 80 * DAY;
      const live: StageMessage[] = [];
      const length = 3 + Math.floor(random() * 14);
      for (let i = 0; i < length; i += 1) {
        t += gaps[Math.floor(random() * gaps.length)] ?? 0;
        const direction = random() < 0.5 ? 'outbound' : 'inbound';
        const roll = random();
        const isReaction = roll < 0.08;
        const isFailed = direction === 'outbound' && roll >= 0.08 && roll < 0.14;
        const id = await seedMessage(sqlc(), conv, {
          direction,
          type: isReaction ? 'reaction' : 'text',
          content: `m${c}-${i}`,
          occurredAt: new Date(t),
          ...(direction === 'outbound' ? { status: isFailed ? 'failed' : 'sent', provenance: 'imported' } : {}),
        });
        if (!isReaction && !isFailed) live.push({ id, direction, occurredAt: new Date(t) });
      }
      for (const [id, stage] of deriveStages(live, NOW)) expected.set(id, stage);
    }

    const rows = await getDb().execute<{ id: string; stage: string }>(sql`WITH ${pairsCte(NOW.toISOString())} SELECT id, stage FROM pairs`);
    const actual = new Map(rows.map((row) => [row.id, row.stage]));
    expect(actual.size).toBe(expected.size);
    expect(expected.size).toBeGreaterThan(150);
    const disagreements = [...expected].filter(([id, stage]) => actual.get(id) !== stage);
    expect(disagreements).toEqual([]);
    // the test is only meaningful if every stage actually occurred
    expect(new Set(expected.values())).toEqual(new Set(['opening', 'mid', 'closing', 'followup']));
  });
});

describe('pairs: the customer side of a reply', () => {
  it('is the run of customer messages since the owner last spoke (oldest first, at most 5), skipping reactions, deleted and empty ones', async () => {
    const conv = await conversation('Amina');
    await owner(conv, 'earlier owner message', at(-10 * DAY));
    for (let i = 1; i <= 7; i += 1) await inbound(conv, `c${i}`, at(-10 * DAY + i * MIN));
    await seedMessage(sqlc(), conv, { direction: 'inbound', type: 'reaction', content: '👍', occurredAt: at(-10 * DAY + 8 * MIN) });
    const deleted = await inbound(conv, 'secret deleted', at(-10 * DAY + 9 * MIN));
    await sqlc()`UPDATE messages SET deleted_at = now() WHERE id = ${deleted}`;
    await inbound(conv, '   ', at(-10 * DAY + 10 * MIN));
    await owner(conv, 'the reply', at(-10 * DAY + 20 * MIN));

    const pairs = await listPairs(getDb(), { now: NOW, limit: 10 });
    const reply = pairs.find((p) => p.reply === 'the reply');
    expect(reply?.customerText).toBe('c3\nc4\nc5\nc6\nc7');
    expect(reply?.customerMessageIds).toHaveLength(5);
  });

  it('a follow-up has no customer side, and listPairs can leave those out', async () => {
    const conv = await conversation('Brian');
    await inbound(conv, 'hello', at(-5 * DAY));
    await owner(conv, 'hi', at(-5 * DAY + MIN));
    await owner(conv, 'did you get it?', at(-5 * DAY + 3 * HOUR));
    const all = await listPairs(getDb(), { now: NOW, limit: 10, requireCustomerText: false });
    expect(all.map((p) => [p.reply, p.customerText, p.stage])).toEqual([['did you get it?', null, 'closing'], ['hi', 'hello', 'opening']]);
    const withCustomer = await listPairs(getDb(), { now: NOW, limit: 10 });
    expect(withCustomer.map((p) => p.reply)).toEqual(['hi']);
  });

  it('lists newest first, honours the limit and `before`', async () => {
    const conv = await conversation('Kato');
    for (let i = 0; i < 6; i += 1) {
      await inbound(conv, `q${i}`, at(-(10 - i) * DAY));
      await owner(conv, `a${i}`, at(-(10 - i) * DAY + MIN));
    }
    expect((await listPairs(getDb(), { now: NOW, limit: 3 })).map((p) => p.reply)).toEqual(['a5', 'a4', 'a3']);
    expect((await listPairs(getDb(), { now: NOW, limit: 10, before: at(-(10 - 3) * DAY) })).map((p) => p.reply)).toEqual(['a2', 'a1', 'a0']);
  });
});

describe('eligibility: only the owner’s own words', () => {
  it('never returns ai_unedited, ai_autopilot, customer-provenance, failed, placeholder or non-text replies', async () => {
    const conv = await conversation('Eligibility');
    const seeds: Array<[string, string, { type?: string; status?: string }]> = [
      ['owner_manual', 'manual reply', {}],
      ['owner_app_echo', 'echo reply', {}],
      ['imported', 'imported reply', {}],
      ['ai_edited', 'edited reply', {}],
      ['ai_unedited', 'UNEDITED AI reply', {}],
      ['ai_autopilot', 'AUTOPILOT reply', {}],
      ['imported', 'has a [[placeholder]] in it', {}],
      ['imported', 'failed one', { status: 'failed' }],
      ['imported', '[Media omitted]', { type: 'unsupported' }],
      ['imported', '   ', {}],
    ];
    let t = -20 * DAY;
    for (const [provenance, content, extra] of seeds) {
      await inbound(conv, `question for ${content}`, at(t));
      await owner(conv, content, at(t + MIN), provenance, extra);
      t += 2 * HOUR;
    }
    const replies = (await listPairs(getDb(), { now: NOW, limit: 50 })).map((p) => p.reply).sort();
    expect(replies).toEqual(['echo reply', 'edited reply', 'imported reply', 'manual reply']);

    const picked = await selectFewShot(getDb(), { conversationId: await conversation('Other'), burstText: 'question', stage: 'mid', now: NOW, perConversation: 10 });
    expect(picked.map((p) => p.reply).sort()).toEqual(['echo reply', 'edited reply', 'imported reply', 'manual reply']);
    expect(await count(sqlc(), 'messages', `provenance IN ('ai_unedited','ai_autopilot')`)).toBe(2);
  });
});

describe('selectFewShot', () => {
  async function history(): Promise<{ current: string; other: string }> {
    const other = await conversation('History');
    let t = -60 * DAY;
    const exchange = async (q: string, a: string, gapAfter = 2 * HOUR) => {
      await inbound(other, q, at(t));
      await owner(other, a, at(t + 2 * MIN));
      t += gapAfter;
    };
    await exchange('How much is the blue dress?', 'The blue dress is 50k', 3 * DAY);
    await exchange('Do you deliver to Entebbe?', 'Yes we deliver to Entebbe, 10k', 3 * DAY);
    await exchange('hello', 'Hi dear, how can I help?', 3 * DAY);
    await exchange('Is the red bag in stock?', 'Yes it is, come anytime', 3 * DAY);
    const current = await conversation('Current');
    return { current, other };
  }

  it('prefers pairs whose customer side matches the new burst (full-text rank)', async () => {
    const { current } = await history();
    const picked = await selectFewShot(getDb(), { conversationId: current, burstText: 'how much is the blue dress please', stage: 'mid', now: NOW, limit: 4, sameStageQuota: 0 });
    expect(picked[0]?.reply).toBe('The blue dress is 50k');
    expect(picked[0]?.rank).toBeGreaterThan(0);
    expect(picked.map((p) => p.rank)).toEqual([...picked.map((p) => p.rank)].sort((a, b) => b - a));
  });

  it('takes same-stage pairs first (these histories are all `opening`: each starts after 3 days of silence)', async () => {
    const { current } = await history();
    const picked = await selectFewShot(getDb(), { conversationId: current, burstText: 'anything', stage: 'opening', now: NOW, limit: 8, sameStageQuota: 3, perConversation: 10 });
    expect(picked.slice(0, 3).every((p) => p.stage === 'opening')).toBe(true);
    const mid = await selectFewShot(getDb(), { conversationId: current, burstText: 'anything', stage: 'mid', now: NOW, limit: 8, perConversation: 10 });
    expect(mid.every((p) => p.stage === 'opening' || p.stage === 'closing')).toBe(true);
  });

  it('caps pairs per conversation at 2 by default', async () => {
    const { current } = await history();
    expect(await selectFewShot(getDb(), { conversationId: current, burstText: 'dress', stage: 'mid', now: NOW })).toHaveLength(2);
  });

  it('excludes the CURRENT conversation’s last 24 hours (already in the prompt) but not its older history', async () => {
    const { current } = await history();
    await inbound(current, 'old question about shoes', at(-9 * DAY));
    await owner(current, 'old answer about shoes', at(-9 * DAY + MIN));
    await inbound(current, 'recent question about shoes', at(-3 * HOUR));
    await owner(current, 'recent answer about shoes', at(-3 * HOUR + MIN));
    const replies = (await selectFewShot(getDb(), { conversationId: current, burstText: 'shoes', stage: 'mid', now: NOW, perConversation: 10 })).map((p) => p.reply);
    expect(replies).toContain('old answer about shoes');
    expect(replies).not.toContain('recent answer about shoes');
  });

  it('never returns the evaluation’s held-out replies', async () => {
    const { current, other } = await history();
    const [held] = await sqlc()<{ id: string }[]>`SELECT id FROM messages WHERE conversation_id = ${other} AND content = 'The blue dress is 50k'`;
    const picked = await selectFewShot(getDb(), { conversationId: current, burstText: 'blue dress', stage: 'mid', now: NOW, perConversation: 10, ...(held ? { excludeReplyIds: [held.id] } : {}) });
    expect(picked.map((p) => p.reply)).not.toContain('The blue dress is 50k');
    expect(picked.length).toBeGreaterThan(0);
  });

  it('drops repeated identical replies and survives an empty burst, empty history and odd characters', async () => {
    const conv = await conversation('Dups');
    for (let i = 0; i < 5; i += 1) {
      await inbound(conv, `thanks ${i}`, at(-(20 - i) * DAY));
      await owner(conv, 'You are welcome', at(-(20 - i) * DAY + MIN));
    }
    const current = await conversation('Now');
    expect(await selectFewShot(getDb(), { conversationId: current, burstText: 'thanks', stage: 'mid', now: NOW, perConversation: 10 })).toHaveLength(1);
    expect(await selectFewShot(getDb(), { conversationId: current, burstText: '', stage: 'mid', now: NOW, perConversation: 10 })).toHaveLength(1);
    expect(await selectFewShot(getDb(), { conversationId: current, burstText: `'; DROP TABLE messages; -- | & ! ( ) :* "quoted"`, stage: 'mid', now: NOW })).toBeDefined();
    expect(await count(sqlc(), 'messages')).toBeGreaterThan(5);
  });

  it('returns nothing from an empty database', async () => {
    const current = await conversation('Lonely');
    expect(await selectFewShot(getDb(), { conversationId: current, burstText: 'hello', stage: 'opening', now: NOW })).toEqual([]);
  });
});
