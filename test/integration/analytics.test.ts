import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { buildRange, getAiUsage, getAnalytics, getDraftOutcomes, getEditDistance, getFirstResponse, getTasksByType, getVolume } from '@/lib/metrics/analytics';
import { seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();

/**
 * One small dataset, every expected number worked out by hand below. Africa/Kampala is UTC+3 all year, "now" is Monday 5 October 2026 14:30 local
 * (11:30Z), and the 7-day range is the local days 29 Sep .. 5 Oct, starting at 2026-09-28T21:00Z. Messages near midnight are placed ON PURPOSE so a
 * query that buckets by UTC date instead of the owner's date gets a different answer.
 */
const NOW = new Date('2026-10-05T11:30:00Z');
const TZ = 'Africa/Kampala';
const z = (iso: string) => new Date(iso);
const range = () => buildRange(NOW, 7, TZ);

let counter = 0;
async function conversation(name: string): Promise<string> {
  counter += 1;
  const contact = await seedContact(sql(), { phone: `+25670077${String(counter).padStart(4, '0')}`, bsuid: `UG.AN${counter}`, name });
  return seedConversation(sql(), contact, { status: 'waiting_on_customer' });
}
const inbound = (conv: string, at: string, over: { type?: string; provenance?: string } = {}) => seedMessage(sql(), conv, { direction: 'inbound', content: 'q', occurredAt: z(at), ...over });
const outbound = (conv: string, at: string, over: { status?: string; provenance?: string } = {}) => seedMessage(sql(), conv, { direction: 'outbound', content: 'a', occurredAt: z(at), ...over });

async function seedMessages(): Promise<void> {
  // 29 Sep: A asks 09:00 local, answered after 10 minutes. B asks 23:30 local (20:30Z), answered after 20 minutes.
  const a = await conversation('A');
  await inbound(a, '2026-09-29T06:00:00Z');
  await outbound(a, '2026-09-29T06:10:00Z');
  const b = await conversation('B');
  await inbound(b, '2026-09-29T20:30:00Z');
  await outbound(b, '2026-09-29T20:50:00Z');
  // 30 Sep: B2 asks at 00:30 local (21:30Z on the 29th in UTC!), answered 60 minutes later.
  const b2 = await conversation('B2');
  await inbound(b2, '2026-09-29T21:30:00Z');
  await outbound(b2, '2026-09-29T22:30:00Z');
  // 1 Oct: C writes twice (08:00, 08:05) and is answered at 08:30: ONE first message, 30 minutes. Not counted: a reaction, imported history, a failed send.
  const c = await conversation('C');
  await inbound(c, '2026-10-01T08:00:00Z');
  await inbound(c, '2026-10-01T08:05:00Z');
  await outbound(c, '2026-10-01T08:30:00Z');
  await inbound(c, '2026-10-01T08:40:00Z', { type: 'reaction' });
  await inbound(c, '2026-10-01T08:41:00Z', { provenance: 'imported' });
  await outbound(c, '2026-10-01T09:00:00Z', { status: 'failed' });
  // 5 Oct: D asks at 12:00 local and has not been answered.
  const d = await conversation('D');
  await inbound(d, '2026-10-05T09:00:00Z');
  // Outside the range: before it began.
  const old = await conversation('Old');
  await inbound(old, '2026-09-20T09:00:00Z');
  await outbound(old, '2026-09-20T09:05:00Z');
}

describe('volume', () => {
  it('counts live messages per OWNER day, zero-fills quiet days, and leaves out reactions, imports, failed sends and anything outside the range', async () => {
    await seedMessages();
    expect(await getVolume(getDb(), range())).toEqual([
      { day: '2026-09-29', inbound: 2, outbound: 2 }, // A 09:00, B 23:30 | two replies
      { day: '2026-09-30', inbound: 1, outbound: 1 }, // B2 00:30 (the 29th in UTC) | its reply 01:30
      { day: '2026-10-01', inbound: 2, outbound: 1 }, // C twice | one reply (the failed send is not counted)
      { day: '2026-10-02', inbound: 0, outbound: 0 },
      { day: '2026-10-03', inbound: 0, outbound: 0 },
      { day: '2026-10-04', inbound: 0, outbound: 0 },
      { day: '2026-10-05', inbound: 1, outbound: 0 },
    ]);
  });

  it('a different range includes more: 30 days picks up the message from 20 September', async () => {
    await seedMessages();
    const wide = buildRange(NOW, 30, TZ);
    const days = await getVolume(getDb(), wide);
    expect(days).toHaveLength(30);
    expect(days.find((d) => d.day === '2026-09-20')).toEqual({ day: '2026-09-20', inbound: 1, outbound: 1 });
    expect(days.reduce((sum, d) => sum + d.inbound, 0)).toBe(7);
  });
});

describe('first response', () => {
  it('is the median wait for the first reply, by the day the customer wrote (hand-computed: 10 & 20 min -> 15 min; 60; 30), and 25 min overall', async () => {
    await seedMessages();
    const result = await getFirstResponse(getDb(), range());
    expect(result.byDay).toEqual([
      { day: '2026-09-29', medianSeconds: 900, samples: 2 },
      { day: '2026-09-30', medianSeconds: 3600, samples: 1 },
      { day: '2026-10-01', medianSeconds: 1800, samples: 1 },
      { day: '2026-10-02', medianSeconds: null, samples: 0 },
      { day: '2026-10-03', medianSeconds: null, samples: 0 },
      { day: '2026-10-04', medianSeconds: null, samples: 0 },
      { day: '2026-10-05', medianSeconds: null, samples: 0 }, // D is still waiting: nothing to measure yet
    ]);
    // [600, 1200, 1800, 3600]: the middle two are 1200 and 1800
    expect(result.medianSeconds).toBe(1500);
    expect(result.samples).toBe(4);
  });

  it('with nothing answered the answer is "no data", not zero', async () => {
    const result = await getFirstResponse(getDb(), range());
    expect(result.medianSeconds).toBeNull();
    expect(result.samples).toBe(0);
    expect(result.byDay.every((d) => d.medianSeconds === null && d.samples === 0)).toBe(true);
  });
});

async function draft(conv: string, o: { status: string; createdAt: string; editDistance?: number | null; approvedAt?: string | null; finalMessage?: string | null }): Promise<void> {
  const msg = await inbound(conv, o.createdAt);
  await sql()`
    INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status, created_at, edit_distance, approved_at, final_message_id)
    VALUES (gen_random_uuid(), ${conv}, ${sql().array([msg])}::uuid[], 'x', 'x', 'question', 'a', 'm', 'p', ${o.status}::draft_status, ${z(o.createdAt)}, ${o.editDistance ?? null},
            ${o.approvedAt ? z(o.approvedAt) : null}, ${o.finalMessage ?? null})`;
}

async function seedDrafts(): Promise<void> {
  const conv = await conversation('Drafts');
  // 30 Sep (local): two sent as written (distance 0), one edited (0.4)
  await draft(conv, { status: 'approved', createdAt: '2026-09-30T06:00:00Z', editDistance: 0, approvedAt: '2026-09-30T07:00:00Z' });
  await draft(conv, { status: 'approved', createdAt: '2026-09-30T06:10:00Z', editDistance: 0, approvedAt: '2026-09-30T07:10:00Z' });
  await draft(conv, { status: 'edited', createdAt: '2026-09-30T06:20:00Z', editDistance: 0.4, approvedAt: '2026-09-30T07:20:00Z' });
  // 1 Oct: one rejected, one superseded, one failed; and a draft WRITTEN on 30 Sep that the owner sent (edited, 0.2) only on 1 Oct, so the
  // outcome chart (by the day it was written) and the edit-distance chart (by the day it was sent) must put it on different days
  await draft(conv, { status: 'edited', createdAt: '2026-09-30T06:30:00Z', editDistance: 0.2, approvedAt: '2026-10-01T10:00:00Z' });
  // a scheduled send the owner discarded counts as rejected; a draft that was never sent counts for no edit distance even if a distance is on the row
  await draft(conv, { status: 'cancelled', createdAt: '2026-10-01T06:05:00Z' });
  await draft(conv, { status: 'rejected', createdAt: '2026-10-01T06:06:00Z', editDistance: 0.9, approvedAt: '2026-10-01T06:07:00Z' });
  await draft(conv, { status: 'rejected', createdAt: '2026-10-01T06:10:00Z' });
  await draft(conv, { status: 'superseded', createdAt: '2026-10-01T06:20:00Z' });
  await draft(conv, { status: 'failed', createdAt: '2026-10-01T06:30:00Z' });
  // 5 Oct: one still waiting, one sent by autopilot (approved, but its message went out as ai_autopilot; no edit distance)
  await draft(conv, { status: 'pending', createdAt: '2026-10-05T08:00:00Z' });
  const auto = await seedMessage(sql(), conv, { direction: 'outbound', content: 'auto', provenance: 'ai_autopilot', occurredAt: z('2026-10-05T09:30:00Z') });
  await draft(conv, { status: 'approved', createdAt: '2026-10-05T09:00:00Z', approvedAt: '2026-10-05T09:30:00Z', finalMessage: auto });
  // Outside the range
  await draft(conv, { status: 'approved', createdAt: '2026-09-01T06:00:00Z', editDistance: 0.9, approvedAt: '2026-09-01T07:00:00Z' });
}

describe('draft outcomes', () => {
  it('counts what became of each day’s drafts: as written, edited, rejected, replaced, failed, autopilot, still open', async () => {
    await seedDrafts();
    const { byDay, totals } = await getDraftOutcomes(getDb(), range());
    const zero = { unedited: 0, edited: 0, rejected: 0, superseded: 0, failed: 0, autopilot: 0, open: 0 };
    expect(byDay.map((d) => d.day)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    expect(byDay[0]).toEqual({ day: '2026-09-29', ...zero });
    expect(byDay[1]).toEqual({ day: '2026-09-30', ...zero, unedited: 2, edited: 2 });
    expect(byDay[2]).toEqual({ day: '2026-10-01', ...zero, rejected: 3, superseded: 1, failed: 1 });
    expect(byDay[6]).toEqual({ day: '2026-10-05', ...zero, open: 1, autopilot: 1 });
    expect(totals).toEqual({ unedited: 2, edited: 2, rejected: 3, superseded: 1, failed: 1, autopilot: 1, open: 1 });
  });
});

describe('edit distance (the primary chart)', () => {
  it('is the median distance of what was SENT, by the day it was sent, with the median, p75 and edited share of the whole range', async () => {
    await seedDrafts();
    const result = await getEditDistance(getDb(), range());
    expect(result.byDay.map((d) => [d.day, d.median, d.sent])).toEqual([
      ['2026-09-29', null, 0],
      ['2026-09-30', 0, 3], // distances 0, 0, 0.4 -> median 0
      ['2026-10-01', 0.2, 1],
      ['2026-10-02', null, 0],
      ['2026-10-03', null, 0],
      ['2026-10-04', null, 0],
      ['2026-10-05', null, 0], // the autopilot send stored no distance: it was not edited by anyone
    ]);
    expect(result.sent).toBe(4);
    expect(result.median).toBeCloseTo(0.1, 4); // [0, 0, 0.2, 0.4]: (0 + 0.2) / 2
    expect(result.p75).toBeCloseTo(0.25, 4); // position 0.75 * 3 = 2.25: 0.2 + 0.25 * (0.4 - 0.2)
    expect(result.editedShare).toBe(0.5);
  });

  it('with nothing sent the answer is "no data"', async () => {
    const result = await getEditDistance(getDb(), range());
    expect(result).toMatchObject({ median: null, p75: null, sent: 0, editedShare: null });
  });
});

describe('tasks by kind', () => {
  it('counts tasks created in the range with where they stand and who noted them; every kind is listed, even with none', async () => {
    const conv = await conversation('T');
    const task = (type: string, status: string, by: string, createdAt: string) =>
      sql()`INSERT INTO tasks (id, conversation_id, description, type, status, created_by, created_at) VALUES (gen_random_uuid(), ${conv}, 'x', ${type}, ${status}, ${by}, ${z(createdAt)})`;
    await task('request', 'open', 'ai', '2026-10-01T08:00:00Z');
    await task('request', 'done', 'ai', '2026-10-02T08:00:00Z');
    await task('request', 'done', 'owner', '2026-10-02T09:00:00Z');
    await task('followup', 'cancelled', 'ai', '2026-10-03T08:00:00Z');
    await task('request', 'open', 'ai', '2026-08-01T08:00:00Z'); // long before the range
    expect(await getTasksByType(getDb(), range())).toEqual([
      { type: 'request', open: 1, done: 2, cancelled: 0, byAssistant: 2, byOwner: 1 },
      { type: 'followup', open: 0, done: 0, cancelled: 1, byAssistant: 1, byOwner: 0 },
      { type: 'reminder', open: 0, done: 0, cancelled: 0, byAssistant: 0, byOwner: 0 },
    ]);
  });
});

describe('AI usage', () => {
  async function run(model: string, purpose: string, input: number, output: number, at: string, ok = true): Promise<void> {
    await sql()`INSERT INTO ai_runs (id, purpose, model, input_tokens, output_tokens, latency_ms, ok, created_at) VALUES (gen_random_uuid(), ${purpose}::ai_purpose, ${model}, ${input}, ${output}, 100, ${ok}, ${z(at)})`;
  }
  async function seedRuns(): Promise<void> {
    await run('m1', 'draft', 1000, 200, '2026-09-30T06:00:00Z');
    await run('m1', 'draft', 1000, 200, '2026-09-30T07:00:00Z');
    await run('m2', 'analysis', 500, 100, '2026-09-30T08:00:00Z');
    await run('m1', 'draft', 0, 0, '2026-10-01T08:00:00Z', false);
    await run('m1', 'draft', 9999, 9999, '2026-09-01T08:00:00Z'); // outside the range
  }

  it('without a price list: tokens and calls only, cost is null (no price is ever guessed)', async () => {
    await seedRuns();
    const usage = await getAiUsage(getDb(), range(), null);
    expect(usage.currency).toBeNull();
    expect(usage.byDay[1]).toEqual({ day: '2026-09-30', inputTokens: 2500, outputTokens: 500, calls: 3, failed: 0, cost: null });
    expect(usage.byDay[2]).toEqual({ day: '2026-10-01', inputTokens: 0, outputTokens: 0, calls: 1, failed: 1, cost: null });
    expect(usage.totals).toEqual({ inputTokens: 2500, outputTokens: 500, calls: 4, failed: 1, cost: null });
    expect(usage.byPurpose).toEqual([
      { purpose: 'draft', inputTokens: 2000, outputTokens: 400, calls: 3 },
      { purpose: 'analysis', inputTokens: 500, outputTokens: 100, calls: 1 },
    ]);
    expect(usage.unpricedModels).toEqual([]);
  });

  it('with prices: cost per day from per-million-token prices; a model without a price is named and counted as zero (a lower bound, said so)', async () => {
    await seedRuns();
    const usage = await getAiUsage(getDb(), range(), { currency: 'USD', models: { m1: { input: 0.15, output: 0.6 } } });
    // 30 Sep, m1: 2000 in * 0.15/1e6 + 400 out * 0.6/1e6 = 0.0003 + 0.00024 = 0.00054; m2 unpriced
    expect(usage.byDay[1]?.cost).toBeCloseTo(0.00054, 8);
    expect(usage.byDay[2]?.cost).toBe(0);
    expect(usage.totals.cost).toBeCloseTo(0.00054, 8);
    expect(usage.currency).toBe('USD');
    expect(usage.unpricedModels).toEqual(['m2']);
  });

  it('zero-fills days with no calls', async () => {
    const usage = await getAiUsage(getDb(), range(), null);
    expect(usage.byDay).toHaveLength(7);
    expect(usage.byDay.every((d) => d.calls === 0 && d.cost === null)).toBe(true);
  });
});

describe('getAnalytics', () => {
  it('assembles every series for one range, in the owner’s zone', async () => {
    await seedMessages();
    await seedDrafts();
    const all = await getAnalytics(getDb(), { now: NOW, days: 7, timeZone: TZ, prices: null });
    expect(all.range.dates).toHaveLength(7);
    expect(all.volume).toHaveLength(7);
    expect(all.firstResponse.byDay).toHaveLength(7);
    expect(all.drafts.byDay).toHaveLength(7);
    expect(all.editDistance.byDay).toHaveLength(7);
    expect(all.tasks).toHaveLength(3);
    expect(all.ai.byDay).toHaveLength(7);
  });
});
